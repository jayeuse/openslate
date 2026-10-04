"""Existing physical archive evidence and deliberately narrow snapshot retention."""

import json
import os
import re
import signal
import subprocess
import sys
from collections.abc import Callable
from datetime import datetime, timedelta

from app.systems.manage.backups.schemas import ClaimResponse, ExpireCommand
from operations.backups.host import (
    Host,
    Json,
    RunnerError,
    digest,
    physical_archive,
    read_private_json,
)


def run_archive(host: Host, journal: Json) -> None:
    """Call the existing physical archive in an owned bounded child."""
    journal["phase"] = "child_launch_pending"
    host.save(journal)
    try:
        child = subprocess.Popen(
            [
                sys.executable,
                str(host.config.compose_root.parents[1] / "backend/operations/backup_runner.py"),
                "_backup-child",
                "--backup-config",
                str(host.config_path),
                "--state-directory",
                str(host.state_directory),
                "--claim-id",
                journal["claim_id"],
                "--lock-fd",
                str(host.lock_fd),
            ],
            pass_fds=(host.lock_fd,),
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={name: os.environ[name] for name in ("PATH",) if name in os.environ},
        )
        try:
            code = child.wait(timeout=1800)
        except subprocess.TimeoutExpired as error:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
            except ProcessLookupError:
                pass
            raise RunnerError("backup_interrupted") from error
    except OSError as error:
        raise RunnerError("backup_failed") from error
    finally:
        saved = host.active()
        if saved is not None:
            journal.update(saved)
    if saved is None:
        raise RunnerError("journal_invalid")
    if code:
        raise RunnerError("backup_failed")


def backup_child(host: Host, claim_id: str, lock_fd: int) -> None:
    """Register child disposition durably before physical archive work begins."""
    import fcntl

    host.config = physical_archive().parse_config(host.config_path)
    journal = host.active()
    inherited = os.fstat(lock_fd)
    expected = (host.directory / "lock").stat()
    if (
        journal is None
        or journal.get("claim_id") != claim_id
        or journal.get("claim") is None
        or journal["phase"] not in {"stopped", "child_launch_pending"}
        or (inherited.st_dev, inherited.st_ino) != (expected.st_dev, expected.st_ino)
        or os.getpgid(os.getpid()) != os.getpid()
    ):
        raise RunnerError("journal_invalid")
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    journal["child"] = {"pid": os.getpid(), "pgid": os.getpgid(os.getpid())}
    journal["phase"] = "backup_started"
    host.save(journal)
    physical_archive().run_backup(host.run_config(journal))


def marker_facts(host: Host, journal: Json, *, optional: bool = False) -> Json:
    path = host.run_directory(journal) / "backup-complete.json"
    if optional and not path.exists():
        return {"snapshot_id": None, "manifest_sha256": None, "verified_at": None}
    try:
        marker = read_private_json(path)
        completed = datetime.fromisoformat(marker["completed_at"])
        if (
            set(marker)
            != {
                "format_version",
                "source_installation_id",
                "source_project",
                "snapshot_id",
                "manifest_sha256",
                "completed_at",
            }
            or marker["format_version"] != 3
            or marker["source_installation_id"] != host.config.installation_id
            or marker["source_project"] != host.config.project_name
            or completed.utcoffset() is None
            or not all(
                isinstance(marker[key], str) and re.fullmatch(r"[0-9a-f]{64}", marker[key])
                for key in ("snapshot_id", "manifest_sha256")
            )
        ):
            raise ValueError
    except (OSError, ValueError, KeyError, TypeError, physical_archive().BackupError) as error:
        raise RunnerError("verification_failed") from error
    return {
        "snapshot_id": marker["snapshot_id"],
        "manifest_sha256": marker["manifest_sha256"],
        "verified_at": completed.isoformat(),
    }


def snapshot_ids(host: Host) -> set[str]:
    env = {name: os.environ[name] for name in ("PATH",) if name in os.environ}
    env.update(
        RESTIC_REPOSITORY=str(host.config.restic_repository),
        RESTIC_PASSWORD_FILE=str(host.config.restic_password_file),
    )
    values = json.loads(
        host.command(["restic", "snapshots", "--json"], failure="retention_failed", env=env)
    )
    if not isinstance(values, list) or any(
        not isinstance(value, dict)
        or not isinstance(value.get("id"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["id"])
        for value in values
    ):
        raise RunnerError("retention_failed")
    return {value["id"] for value in values}


def candidate_marker(host: Host, claim: ClaimResponse) -> None:
    key = {"claim_id": str(claim.claim_id)}
    config_path = host.run_config(key)
    journal = read_private_json(host.run_directory(key) / "journal.json")
    config = physical_archive().parse_config(config_path)
    if (
        journal.get("claim_id") != str(claim.claim_id)
        or journal.get("installation_id") != host.config.installation_id
        or journal.get("project") != host.config.project_name
        or journal.get("config_sha256") != digest(config_path)
        or journal.get("claim", {}).get("run", {}).get("id") != str(claim.run.id)
        or config.installation_id != host.config.installation_id
        or config.project_name != host.config.project_name
        or config.deployment != "production"
        or config.restic_repository != host.config.restic_repository
        or config.restic_password_file != host.config.restic_password_file
        or config.completion_marker != host.run_directory(key) / "backup-complete.json"
    ):
        raise RunnerError("retention_failed")
    facts = marker_facts(host, key)
    if (
        facts["snapshot_id"] != claim.run.snapshot_id
        or facts["manifest_sha256"] != claim.run.manifest_sha256
    ):
        raise RunnerError("retention_failed")


def acknowledge_expiry(host: Host, journal: Json, command: Json) -> None:
    expected = ExpireCommand.model_validate(command)
    if expected.snapshot_id in snapshot_ids(host):
        journal["expiry"] = None
        host.save(journal)
        raise RunnerError("retention_failed")
    returned = ClaimResponse.model_validate(host.bridge(command, journal)["claim"])
    if (
        returned.run.id != expected.run_id
        or returned.claim_id != expected.claim_id
        or returned.installation_id != expected.installation_id
        or returned.run.snapshot_id != expected.snapshot_id
        or returned.run.expired_at != expected.expired_at
    ):
        raise RunnerError("result_unconfirmed")
    for candidate in journal["candidates"]:
        if candidate["claim_id"] == str(returned.claim_id):
            candidate["run"]["expired_at"] = returned.run.expired_at.isoformat()
    journal["expiry"] = None
    host.save(journal)


def retention(
    host: Host,
    journal: Json,
    facts: Json,
    now: Callable[[], datetime],
    beat: Callable[[], None] = lambda: None,
) -> None:
    """Keep the newest verified point and the new point; prune only after a removal."""
    journal["phase"] = "retention"
    host.save(journal)
    if journal.get("expiry"):
        acknowledge_expiry(host, journal, journal["expiry"])
    claims = [ClaimResponse.model_validate(value) for value in journal["candidates"]]
    owned = [
        value
        for value in claims
        if value.installation_id == host.config.installation_id
        and value.run.installation == "current"
        and value.run.verified_at is not None
        and value.run.reconciled_at is not None
        and value.run.expired_at is None
        and value.run.snapshot_id is not None
        and value.run.finished_at is not None
    ]
    if not owned:
        return
    # The database protects the newest point by verified_at (backup_latest_protected).
    newest = max(owned, key=lambda value: value.run.verified_at or now())
    try:
        candidate_marker(host, newest)
        present = snapshot_ids(host)
        if facts["snapshot_id"] not in present or newest.run.snapshot_id not in present:
            raise RunnerError("retention_failed")
        keep = {facts["snapshot_id"], newest.run.snapshot_id}
        current = ClaimResponse.model_validate(journal["claim"])
        cutoff = now() - timedelta(days=current.claimed_retention_days)
        env = {name: os.environ[name] for name in ("PATH",) if name in os.environ}
        env.update(
            RESTIC_REPOSITORY=str(host.config.restic_repository),
            RESTIC_PASSWORD_FILE=str(host.config.restic_password_file),
        )
        removed = 0
        for candidate in owned:
            if (
                candidate.run.snapshot_id in keep
                or candidate.run.finished_at is None
                or candidate.run.finished_at >= cutoff
            ):
                continue
            candidate_marker(host, candidate)
            if candidate.run.snapshot_id not in present:
                # Removal was not recorded by this runner; do not infer an expiry.
                continue
            command = ExpireCommand(
                op="expire",
                installation_id=host.config.installation_id,
                project=host.config.project_name,
                run_id=candidate.run.id,
                claim_id=candidate.claim_id,
                snapshot_id=candidate.run.snapshot_id,
                expired_at=now(),
            ).model_dump(mode="json")
            journal["expiry"] = command
            host.save(journal)
            try:
                host.command(
                    ["restic", "forget", candidate.run.snapshot_id],
                    failure="retention_failed",
                    env=env,
                    timeout=180,
                )
            except RunnerError:
                if candidate.run.snapshot_id in snapshot_ids(host):
                    journal["expiry"] = None
                    host.save(journal)
                    raise
            acknowledge_expiry(host, journal, command)
            present.discard(candidate.run.snapshot_id)
            removed += 1
            beat()
        if removed:
            # forget only drops references; prune reclaims their data. It runs only
            # when this run removed a snapshot, so most nights skip the slow step.
            host.command(["restic", "prune"], failure="retention_failed", env=env, timeout=3600)
            beat()
    except RunnerError as error:
        if error.code == "result_unconfirmed":
            raise
        raise RunnerError("retention_failed") from error
    except (OSError, ValueError, KeyError, TypeError, physical_archive().BackupError) as error:
        raise RunnerError("retention_failed") from error
