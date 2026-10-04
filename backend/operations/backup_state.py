"""Private bounded state bridge for the production host backup runner.

Read one strict JSON command on stdin; stdout is typed safe metadata or one safe
error code. This command never invokes Docker, stops services, or handles backup
repository credentials. Exact claim inspection reconciles uncertain acknowledgments.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Any

from pydantic import Field, TypeAdapter, ValidationError
from sqlalchemy import Engine, select, text
from sqlalchemy.exc import SQLAlchemyError

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import ConfigurationError, get_settings
from app.core.config.instance import (
    InstanceTarget,
    assert_instance_target,
    instance_target_for_process,
)
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import AuditSession, get_engine
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.backups import service
from app.systems.manage.backups.models import BackupPolicy, UpdateStatus
from app.systems.manage.backups.schemas import (
    AdoptCommand,
    ClaimCommand,
    ExpireCommand,
    HeartbeatCommand,
    InspectCommand,
    OutcomeCommand,
    ReleaseCommand,
)
from operations.reset.models import _RESET_ADVISORY_LOCK_KEY

Command = Annotated[
    InspectCommand
    | ClaimCommand
    | HeartbeatCommand
    | OutcomeCommand
    | ReleaseCommand
    | ExpireCommand
    | AdoptCommand,
    Field(discriminator="op"),
]
COMMAND_ADAPTER: TypeAdapter[Command] = TypeAdapter(Command)
MAX_COMMAND_BYTES = 16384


def admit(command: Command) -> InstanceTarget:
    """Refuse before DB access; Compose project provenance is host-admitted separately."""
    if sys.platform == "win32":
        raise service.BackupStateError("backup_platform_unsupported")
    settings = get_settings()
    if settings.environment != "production":
        raise service.BackupStateError("backup_production_required")
    target = instance_target_for_process(settings.database_url, "openslate_runtime")
    if (
        target is None
        or target.instance_id != command.installation_id
        or target.host != "db"
        or target.port != 5432
    ):
        raise service.BackupStateError("backup_identity_conflict")
    return target


@contextmanager
def coordinated_session(engine: Engine, target: InstanceTarget) -> Iterator[AuditSession]:
    """Retain one physical connection and commit the claim before same-session unlock."""
    with engine.connect() as connection:
        assert_instance_target(connection, target, expected_user="openslate_runtime")
        connection.rollback()
        acquired = connection.scalar(
            text("SELECT pg_try_advisory_lock(:key)"), {"key": _RESET_ADVISORY_LOCK_KEY}
        )
        connection.commit()
        if acquired is not True:
            raise service.BackupStateError("backup_coordination_busy")
        try:
            with AuditSession(bind=connection, expire_on_commit=False) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_method="OPERATOR",
                    request_path="/operations/backup_state",
                    actor_label="Installation backup runner",
                )
                try:
                    yield db
                    db.commit()
                except BaseException:
                    db.rollback()
                    raise
        finally:
            try:
                if connection.in_transaction():
                    connection.rollback()
                unlocked = connection.scalar(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _RESET_ADVISORY_LOCK_KEY}
                )
                connection.commit()
                if unlocked is not True:
                    connection.invalidate()
                    raise service.BackupStateError("backup_coordination_unavailable")
            except SQLAlchemyError:
                # Never pool a possibly still-locked physical connection. The host
                # receives uncertainty and must inspect its exact claim before outage.
                connection.invalidate()
                raise


def execute(db: AuditSession, command: Command) -> dict[str, Any]:
    """Return validated safe projections; caller owns the coordinated commit."""
    instance = command.installation_id
    if isinstance(command, InspectCommand):
        policy = db.scalar(select(BackupPolicy))
        release = db.scalar(select(UpdateStatus))
        unresolved = service.unresolved_run(db, instance)
        exact = (
            service.exact_claim(db, instance, command.claim_id, command.run_id)
            if command.claim_id
            else None
        )
        return {
            "policy": service.policy_response(db, instance).model_dump(mode="json"),
            "policy_installation_id": policy.installation_id if policy else None,
            "runner_last_seen_at": policy.runner_last_seen_at.isoformat()
            if policy and policy.runner_last_seen_at
            else None,
            "last_release_checked_at": release.checked_at.isoformat()
            if release and release.checked_at
            else None,
            "unresolved": service.claim_response(unresolved, instance).model_dump(mode="json")
            if unresolved
            else None,
            "queued_count": service.queued_count(db, instance),
            "claim": service.claim_response(exact, instance).model_dump(mode="json")
            if exact
            else None,
            "retention_candidates": [
                service.claim_response(row, instance).model_dump(mode="json")
                for row in service.retention_candidates(db, instance)
            ],
        }
    if isinstance(command, ClaimCommand):
        run = service.claim_run(db, instance, command.claim_id)
        return {
            "claim": service.claim_response(run, instance).model_dump(mode="json") if run else None
        }
    if isinstance(command, HeartbeatCommand):
        service.heartbeat(db, instance, command.claim_id)
        return {"recorded": True}
    if isinstance(command, OutcomeCommand):
        run = service.record_outcome(db, instance, command)
        return {"claim": service.claim_response(run, instance).model_dump(mode="json")}
    if isinstance(command, ExpireCommand):
        run = service.record_expiry(db, instance, command)
        return {"claim": service.claim_response(run, instance).model_dump(mode="json")}
    if isinstance(command, ReleaseCommand):
        service.record_release(db, command)
        return {"recorded": True}
    service.adopt_policy(
        db, instance, command.project, command.restore_marker.model_dump(mode="json")
    )
    return {"policy": service.policy_response(db, instance).model_dump(mode="json")}


def main(arguments: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(arguments)
    try:
        raw = sys.stdin.read(MAX_COMMAND_BYTES + 1)
        if len(raw.encode("utf-8")) > MAX_COMMAND_BYTES:
            raise ValueError
        command = COMMAND_ADAPTER.validate_json(raw)
    except (ValueError, ValidationError):
        print(json.dumps({"code": "backup_command_invalid"}))
        return 2
    try:
        target = admit(command)
        with coordinated_session(get_engine(), target) as db:
            result = execute(db, command)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except service.BackupStateError as error:
        print(json.dumps({"code": str(error)}))
        return 2
    except (ConfigurationError, SQLAlchemyError):
        print(json.dumps({"code": "backup_state_unavailable"}))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
