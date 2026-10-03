"""One bounded production host backup invocation or explicit reconciliation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Protocol, cast, get_args
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.systems.manage.backups.schemas import (
    RELEASE_PREFIX,
    VERSION_PATTERN,
    AdoptCommand,
    ClaimResponse,
    FailureCode,
    HeartbeatCommand,
    OutcomeCommand,
    ReleaseCommand,
)
from operations.backup_runner_archive import backup_child, marker_facts, retention, run_archive
from operations.backup_runner_host import (
    CommandRunner,
    Host,
    Json,
    RunnerError,
    physical_archive,
    read_private_json,
)

Clock = Callable[[], datetime]
ArchiveRunner = Callable[[Host, Json], None]


def current_time() -> datetime:
    return datetime.now(UTC)


class ReleaseSource(Protocol):
    def open(self, request: Request, *, timeout: int) -> Any: ...


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


def release_observation(*, opener: ReleaseSource | None = None) -> Json:
    """Read only the fixed stable release authority with a bounded request."""
    empty = {"version": None, "release_url": None, "failure_code": "release_unavailable"}
    try:
        client = opener if opener is not None else build_opener(NoRedirect())
        request = Request(
            "https://api.github.com/repos/jayeuse/openslate/releases/latest",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "OpenSlate-backup-runner",
            },
        )
        with client.open(request, timeout=10) as response:
            body = response.read(65537)
        if len(body) > 65536:
            raise ValueError
        value = json.loads(body)
        if (
            not isinstance(value, dict)
            or value.get("draft") is not False
            or value.get("prerelease") is not False
        ):
            raise ValueError
        tag = value.get("tag_name")
        if not isinstance(tag, str):
            raise ValueError
        version = tag.removeprefix("v")
        if not VERSION_PATTERN.fullmatch(version) or value.get("html_url") != RELEASE_PREFIX + tag:
            raise ValueError
        return {"version": version, "release_url": value["html_url"], "failure_code": None}
    except TimeoutError:
        return {**empty, "failure_code": "release_timeout"}
    except HTTPError:
        return empty
    except URLError as error:
        return {
            **empty,
            "failure_code": "release_timeout"
            if isinstance(error.reason, TimeoutError)
            else "release_unavailable",
        }
    except (ValueError, UnicodeDecodeError):
        return {**empty, "failure_code": "release_invalid"}


def outcome_command(
    host: Host,
    journal: Json,
    facts: Json,
    now: Clock,
    *,
    state: Literal["succeeded", "failed", "interrupted"],
    failure: FailureCode | None,
    reconciled: bool,
) -> Json:
    claim = ClaimResponse.model_validate(journal["claim"])
    finished = (
        datetime.fromisoformat(journal["outcome"]["finished_at"])
        if journal.get("outcome")
        else now()
    )
    return OutcomeCommand(
        op="outcome",
        installation_id=host.config.installation_id,
        project=host.config.project_name,
        run_id=claim.run.id,
        claim_id=claim.claim_id,
        state=state,
        finished_at=finished,
        reconciled_at=now() if reconciled else None,
        snapshot_id=facts["snapshot_id"],
        manifest_sha256=facts["manifest_sha256"],
        verified_at=facts["verified_at"],
        failure_code=failure,
    ).model_dump(mode="json")


def commit_outcome(host: Host, journal: Json, command: Json) -> dict[str, object]:
    journal["outcome"] = command
    journal["phase"] = "outcome_pending"
    host.save(journal)
    returned = ClaimResponse.model_validate(host.bridge(command, journal)["claim"])
    expected = OutcomeCommand.model_validate(command)
    if (
        returned.run.id != expected.run_id
        or returned.claim_id != expected.claim_id
        or returned.installation_id != expected.installation_id
        or any(
            getattr(returned.run, field) != getattr(expected, field)
            for field in (
                "state",
                "finished_at",
                "reconciled_at",
                "snapshot_id",
                "manifest_sha256",
                "verified_at",
                "failure_code",
            )
        )
    ):
        raise RunnerError("result_unconfirmed")
    if expected.reconciled_at is not None:
        host.finish(journal)
    return {"state": expected.state, "run_id": str(expected.run_id)}


def disposition(host: Host, journal: Json) -> None:
    child = journal.get("child")
    if child is not None:
        if (
            not isinstance(child, dict)
            or type(child.get("pid")) is not int
            or child["pid"] < 2
            or child.get("pgid") != child["pid"]
        ):
            raise RunnerError("journal_invalid")
        try:
            os.killpg(child["pgid"], 0)
        except ProcessLookupError:
            pass
        except OSError as error:
            raise RunnerError("child_unresolved") from error
        else:
            raise RunnerError("child_unresolved")
    values = host.inventory()
    prior = journal["services"]
    source = {
        item["Id"]: item
        for item in values
        if host.labels(item).get("com.docker.compose.project") == host.config.project_name
    }
    if set(source) != set(prior) or any(
        type(value.get("running")) is not bool
        or value.get("image") != source[identity].get("Image")
        or value.get("service") != host.labels(source[identity]).get("com.docker.compose.service")
        or source[identity].get("State", {}).get("Status") not in {"running", "exited"}
        or (not value["running"] and source[identity]["State"]["Status"] != "exited")
        for identity, value in prior.items()
    ):
        raise RunnerError("journal_invalid")
    pending = journal.get("bridge")
    if pending and any(
        item.get("Name", "").lstrip("/") == pending["name"]
        and item.get("State", {}).get("Status") not in {"exited", "dead"}
        for item in values
    ):
        raise RunnerError("child_unresolved")
    host.check_readers(values, {identity for identity, value in prior.items() if value["running"]})


def heartbeat(host: Host, journal: Json) -> None:
    """Best effort: tell the API the runner still owns this claim after services resume."""
    command = HeartbeatCommand(
        op="heartbeat",
        installation_id=host.config.installation_id,
        project=host.config.project_name,
        claim_id=journal["claim_id"],
    ).model_dump(mode="json")
    try:
        host.bridge(command)
    except RunnerError:
        pass  # A missed heartbeat only delays the status; it must not fail the backup.


def recover_claim(host: Host, journal: Json, now: Clock) -> dict[str, object]:
    disposition(host, journal)
    facts = marker_facts(host, journal, optional=True)
    db = next(
        item for item in host.containers if host.labels(item)["com.docker.compose.service"] == "db"
    )
    if db["State"]["Status"] != "running":
        if not journal["services"][db["Id"]]["running"]:
            raise RunnerError("journal_invalid")
        host.start_existing(journal, {"db"})
    raw = host.bridge({"op": "inspect", "claim_id": journal["claim_id"]})["claim"]
    if raw is None:
        if journal["phase"] != "prepared" or journal["claim"] is not None or facts["snapshot_id"]:
            raise RunnerError("result_unconfirmed")
        host.finish_empty(journal)
        return {"state": "not_claimed"}
    claim = ClaimResponse.model_validate(raw)
    if (
        claim.installation_id != host.config.installation_id
        or str(claim.claim_id) != journal["claim_id"]
        or journal["claim"] is not None
        and journal["claim"]["run"]["id"] != str(claim.run.id)
    ):
        raise RunnerError("result_unconfirmed")
    journal["claim"] = claim.model_dump(mode="json")
    if claim.run.reconciled_at is not None:
        if not journal.get("outcome"):
            raise RunnerError("result_unconfirmed")
        return commit_outcome(host, journal, journal["outcome"])
    if claim.run.snapshot_id is not None and any(
        facts[field] != raw["run"][field] for field in ("snapshot_id", "manifest_sha256")
    ):
        raise RunnerError("verification_failed")
    caddy = next(
        item
        for item in host.containers
        if host.labels(item)["com.docker.compose.service"] == "caddy"
    )
    if caddy["State"]["Status"] == "running":
        host.compose(["stop", "caddy"], failure="restart_failed")
    host.resume(journal)
    heartbeat(host, journal)
    if facts["snapshot_id"] is not None:
        state, failure = "succeeded", None
        try:
            retention(host, journal, facts, now, lambda: heartbeat(host, journal))
        except RunnerError as error:
            if error.code == "result_unconfirmed" or journal.get("expiry") is not None:
                raise
            state, failure = "failed", "retention_failed"
    else:
        pending = journal.get("outcome")
        state = "failed" if pending and pending["state"] == "failed" else "interrupted"
        failure = pending["failure_code"] if pending else "backup_interrupted"
    command = outcome_command(
        host,
        journal,
        facts,
        now,
        state=cast(Literal["succeeded", "failed", "interrupted"], state),
        failure=cast(FailureCode | None, failure),
        reconciled=True,
    )
    return commit_outcome(host, journal, command)


def run_once(
    config_path: Path,
    state_directory: Path,
    *,
    command_runner: CommandRunner,
    archive_runner: ArchiveRunner = run_archive,
    now: Clock = current_time,
    recover: bool = False,
    restore_finalized: Path | None = None,
    release_loader: Callable[[], Json] = release_observation,
) -> dict[str, object]:
    """Perform at most one already authorized queued production backup."""
    host = Host(config_path, state_directory, command_runner)
    host.admit()
    if restore_finalized is not None and not recover:
        raise RunnerError("invalid_input")
    with host.locked():
        active = host.active()
        if active is not None and recover:
            return recover_claim(host, active, now)
        if active is not None and active["phase"] == "prepared" and active["claim"] is None:
            # A tick writes its journal before asking for a claim and stops nothing
            # until a claim is saved. If no claim exists, the crash left nothing to recover.
            lookup = host.bridge({"op": "inspect", "claim_id": active["claim_id"]})
            if lookup.get("claim") is None:
                host.finish_empty(active)
                active = None
        if active is not None:
            raise RunnerError("recovery_required")
        view = host.bridge({"op": "inspect"})
        if view.get("unresolved") is not None:
            raise RunnerError("recovery_required")
        if not view["policy"]["adopted"]:
            if recover and restore_finalized is not None:
                try:
                    document = read_private_json(restore_finalized)
                    command = AdoptCommand.model_validate(
                        {
                            "op": "adopt",
                            "installation_id": host.config.installation_id,
                            "project": host.config.project_name,
                            "restore_marker": document,
                        }
                    )
                    marker = command.restore_marker
                    if (
                        marker.target_instance_id != host.config.installation_id
                        or marker.target_project != host.config.project_name
                        or marker.source_installation_id != view["policy_installation_id"]
                    ):
                        raise ValueError
                except (OSError, ValueError, TypeError, physical_archive().BackupError) as error:
                    raise RunnerError("restore_marker_invalid") from error
                result = host.bridge(command.model_dump(mode="json"))
                if result.get("policy", {}).get("adopted") is not True:
                    raise RunnerError("result_unconfirmed")
                return {"state": "adopted"}
            raise RunnerError("adoption_required")
        if recover:
            return {"state": "idle"}
        checked = view.get("last_release_checked_at")
        if checked is None or now() - datetime.fromisoformat(checked) >= timedelta(hours=6):
            release = ReleaseCommand.model_validate(
                {
                    "op": "release",
                    "installation_id": host.config.installation_id,
                    "project": host.config.project_name,
                    "checked_at": now(),
                    **release_loader(),
                }
            )
            if host.bridge(release.model_dump(mode="json")) != {"recorded": True}:
                raise RunnerError("result_unconfirmed")
        journal = host.prepare(str(uuid4()), view["retention_candidates"])
        claimed = host.bridge({"op": "claim", "claim_id": journal["claim_id"]}, journal)["claim"]
        if claimed is None:
            host.finish_empty(journal)
            return {"state": "idle"}
        claim = ClaimResponse.model_validate(claimed)
        if (
            claim.installation_id != host.config.installation_id
            or str(claim.claim_id) != journal["claim_id"]
        ):
            raise RunnerError("result_unconfirmed")
        journal["claim"] = claim.model_dump(mode="json")
        journal["phase"] = "claimed"
        host.save(journal)
        facts = {"snapshot_id": None, "manifest_sha256": None, "verified_at": None}
        try:
            host.compose(["stop"], failure="backup_interrupted")
            host.stopped()
            journal["phase"] = "stopped"
            host.save(journal)
            archive_runner(host, journal)
            facts = marker_facts(host, journal)
            journal["phase"] = "verified"
            host.save(journal)
            host.resume(journal)
        except RunnerError as error:
            if journal["phase"] == "restarting":
                host.compose(["stop", "caddy", "api", "scanner-worker"], failure="restart_failed")
            failure = cast(
                FailureCode,
                error.code if error.code in get_args(FailureCode) else "backup_interrupted",
            )
            state: Literal["failed", "interrupted"] = (
                "interrupted" if failure == "backup_interrupted" else "failed"
            )
            journal["outcome"] = outcome_command(
                host, journal, facts, now, state=state, failure=failure, reconciled=False
            )
            host.save(journal)
            raise
        heartbeat(host, journal)
        try:
            retention(host, journal, facts, now, lambda: heartbeat(host, journal))
        except RunnerError as error:
            if error.code == "result_unconfirmed" or journal.get("expiry") is not None:
                raise
            return commit_outcome(
                host,
                journal,
                outcome_command(
                    host,
                    journal,
                    facts,
                    now,
                    state="failed",
                    failure="retention_failed",
                    reconciled=True,
                ),
            )
        return commit_outcome(
            host,
            journal,
            outcome_command(
                host, journal, facts, now, state="succeeded", failure=None, reconciled=True
            ),
        )


def main(argv: list[str] | None = None) -> int:
    """Emit safe JSON only; preserve private recovery evidence on operational failure."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action", choices=("run", "recover", "_backup-child"), metavar="{run,recover}"
    )
    parser.add_argument("--backup-config", type=Path, required=True)
    parser.add_argument("--state-directory", type=Path, required=True)
    parser.add_argument("--restore-finalized", type=Path)
    parser.add_argument("--claim-id", help=argparse.SUPPRESS)
    parser.add_argument("--lock-fd", type=int, default=-1, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        if args.action == "_backup-child":
            if os.name == "nt" or args.claim_id is None or args.lock_fd < 0:
                raise RunnerError("invalid_input")
            backup_child(
                Host(args.backup_config, args.state_directory), args.claim_id, args.lock_fd
            )
            return 0
        result = run_once(
            args.backup_config,
            args.state_directory,
            command_runner=subprocess.run,
            recover=args.action == "recover",
            restore_finalized=args.restore_finalized,
        )
        print(json.dumps(result))
        return 3 if result["state"] in {"failed", "interrupted"} else 0
    except RunnerError as error:
        print(json.dumps({"code": error.code}))
        refused = {
            "unsupported_platform",
            "development_refused",
            "admission_failed",
            "invalid_input",
            "restore_marker_invalid",
            "adoption_required",
            "runner_busy",
            "recovery_required",
            "journal_invalid",
        }
        return 2 if error.code in refused else 3
    except KeyboardInterrupt:
        print(json.dumps({"code": "backup_interrupted"}))
        return 3
    except Exception:
        print(json.dumps({"code": "operator_failed"}))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
