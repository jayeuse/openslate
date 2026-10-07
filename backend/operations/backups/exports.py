"""Confined host export dispatch under the existing installation lock."""

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryFile
from uuid import uuid4

from pydantic import TypeAdapter, ValidationError

from app.systems.manage.backups.schemas import (
    ExportClaimFirst,
    ExportClaimNone,
    ExportClaimReplay,
    ExportClaimReply,
    ExportClaimResponse,
    ExportCleanedCommand,
    ExportInspectResponse,
    ExportMutationResponse,
    ExportOutcomeCommand,
)
from operations.backups.archive import candidate_marker
from operations.backups.export_files import (
    cleanup_acknowledgement,
    cleanup_claim,
    cleanup_staging,
    clear_cleanup_acknowledgement,
    delete_expired_artifact,
    export_staging,
    publish_repository,
    retain_cleanup_acknowledgement,
    verify_publication,
)
from operations.backups.host import Host, Json, RunnerError, physical_archive

CLAIM_ADAPTER: TypeAdapter[ExportClaimReply] = TypeAdapter(ExportClaimReply)
Clock = Callable[[], datetime]


def replay_cleanup(host: Host, deadline: float) -> None:
    """Replay only a retained exact absence acknowledgement, never a fresh claim."""
    pending = cleanup_acknowledgement(host)
    if pending is None:
        return
    claim, command = pending
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RunnerError("result_unconfirmed")
        returned = ExportMutationResponse.model_validate(
            host.bridge(command.model_dump(mode="json"), timeout=remaining)
        ).claim
        fenced_claim(
            host,
            {"claim_id": str(claim.claim_id), "claim": claim.model_dump(mode="json")},
            returned,
        )
        if returned.artifact_deleted_at != command.deleted_at or any(
            getattr(returned.export, key) != getattr(claim.export, key)
            for key in ("ready_at", "expires_at", "size_bytes", "sha256", "failure_code")
        ):
            raise RunnerError("result_unconfirmed")
        clear_cleanup_acknowledgement(host)
    except (OSError, ValueError, KeyError, TypeError, physical_archive().BackupError) as error:
        raise RunnerError("result_unconfirmed") from error


def maintain_exports(host: Host, now: Clock) -> ExportInspectResponse:
    """One bounded cleanup pass before either new job, including idle ticks."""
    deadline = time.monotonic() + 15
    replay_cleanup(host, deadline)
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RunnerError("result_unconfirmed")
        view = ExportInspectResponse.model_validate(
            host.bridge({"op": "inspect-export"}, timeout=remaining)
        )
        if view.unresolved is not None:
            raise RunnerError("recovery_required")
        for claim in view.cleanup_candidates:
            if time.monotonic() >= deadline:
                break
            cleanup_claim(host, claim)
            if claim.export.expires_at is None or now() < claim.export.expires_at:
                raise RunnerError("result_unconfirmed")
            if not delete_expired_artifact(host, claim, deadline):
                break
            command = ExportCleanedCommand(
                op="export-cleaned",
                installation_id=host.config.installation_id,
                project=host.config.project_name,
                export_id=claim.export.id,
                claim_id=claim.claim_id,
                deleted_at=now(),
            )
            retain_cleanup_acknowledgement(host, claim, command)
            replay_cleanup(host, deadline)
        return view
    except (OSError, ValueError, physical_archive().BackupError) as error:
        raise RunnerError("result_unconfirmed") from error


def restic(host: Host, stage: Path, args: list[str], env: dict[str, str], failure: str) -> bytes:
    """Bound metadata memory; private temporary stdout never enters the repository tar."""
    try:
        with TemporaryFile(dir=stage) as output:
            result = host.command_runner(
                ["restic", "--quiet", "--no-cache", *args],
                env=env,
                stdout=output,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=1800,
                pass_fds=(host.lock_fd,),
            )
            if result.returncode or output.tell() > 1048576:
                raise RunnerError(failure)
            output.seek(0)
            data = result.stdout if isinstance(result.stdout, bytes) else output.read(1048577)
            if len(data) > 1048576:
                raise RunnerError(failure)
            return data
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RunnerError(failure) from error


def single_snapshot(data: bytes) -> Json:
    try:
        values = json.loads(data)
        if (
            not isinstance(values, list)
            or len(values) != 1
            or not isinstance(values[0], dict)
            or not re.fullmatch(r"[0-9a-f]{64}", str(values[0].get("id", "")))
            or not isinstance(values[0].get("paths"), list)
            or len(values[0]["paths"]) != 1
            or not isinstance(values[0]["paths"][0], str)
            or not values[0]["paths"][0].startswith("/")
            or not values[0]["paths"][0].endswith("/installation")
        ):
            raise ValueError
        return dict(values[0])
    except (ValueError, TypeError, UnicodeDecodeError) as error:
        raise RunnerError("verification_failed") from error


def export_child(host: Host, claim_id: str, lock_fd: int) -> None:
    """Register the owned process group before copying one proven encrypted snapshot."""
    import fcntl

    host.config = physical_archive().parse_config(host.config_path)
    journal = host.active()
    inherited, expected = os.fstat(lock_fd), (host.directory / "lock").stat()
    if (
        journal is None
        or journal.get("kind") != "export"
        or journal["claim_id"] != claim_id
        or journal["phase"] != "child_launch_pending"
        or (inherited.st_dev, inherited.st_ino) != (expected.st_dev, expected.st_ino)
        or os.getpgid(os.getpid()) != os.getpid()
    ):
        raise RunnerError("journal_invalid")
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    host.lock_fd = lock_fd
    journal["child"] = {"pid": os.getpid(), "pgid": os.getpgid(os.getpid())}
    journal["phase"] = "export_started"
    host.save(journal)
    try:
        copy_export(host, journal)
    except (RunnerError, OSError, ValueError) as error:
        journal["failure_code"] = (
            error.code
            if isinstance(error, RunnerError)
            and error.code in {"copy_failed", "verification_failed"}
            else "copy_failed"
        )
        host.save(journal)
        raise RunnerError(journal["failure_code"]) from error


def copy_export(host: Host, journal: Json) -> None:
    """Copy/check/package one proved source; faults retain safe private child evidence."""
    claim = ExportClaimResponse.model_validate(journal["claim"])
    stage = export_staging(host, journal)
    password = stage / "password"
    physical_archive()._private(password, "export password", directory=False)
    env = {name: os.environ[name] for name in ("PATH",) if name in os.environ}
    source_env = {
        **env,
        "RESTIC_REPOSITORY": str(host.config.restic_repository),
        "RESTIC_PASSWORD_FILE": str(host.config.restic_password_file),
    }
    snapshot_id = claim.source.run.snapshot_id
    if snapshot_id is None:
        raise RunnerError("verification_failed")
    source = single_snapshot(
        restic(host, stage, ["snapshots", "--json", snapshot_id], source_env, "verification_failed")
    )
    if source["id"] != snapshot_id:
        raise RunnerError("verification_failed")
    destination_env = {
        **env,
        "RESTIC_REPOSITORY": str(stage / "repository"),
        "RESTIC_PASSWORD_FILE": str(password),
    }
    restic(host, stage, ["init"], destination_env, "copy_failed")
    restic(
        host,
        stage,
        [
            "copy",
            "--from-repo",
            str(host.config.restic_repository),
            "--from-password-file",
            str(host.config.restic_password_file),
            source["id"],
        ],
        destination_env,
        "copy_failed",
    )
    restic(host, stage, ["check", "--read-data"], destination_env, "verification_failed")
    destination = single_snapshot(
        restic(host, stage, ["snapshots", "--json"], destination_env, "verification_failed")
    )
    manifest = restic(
        host,
        stage,
        ["dump", destination["id"], source["paths"][0] + "/manifest.json"],
        destination_env,
        "verification_failed",
    )
    if (
        destination["paths"] != source["paths"]
        or hashlib.sha256(manifest).hexdigest() != claim.source.run.manifest_sha256
    ):
        raise RunnerError("verification_failed")
    document = json.loads(manifest)
    if (
        not isinstance(document, dict)
        or document.get("format_version") != 3
        or document.get("source_installation_id") != host.config.installation_id
        or document.get("source_project") != host.config.project_name
        or document.get("deployment") != "production"
    ):
        raise RunnerError("verification_failed")
    facts, identity = publish_repository(host, stage, claim)
    journal["publication"] = identity
    journal["outcome"] = ExportOutcomeCommand(
        op="export-outcome",
        installation_id=host.config.installation_id,
        project=host.config.project_name,
        export_id=claim.export.id,
        claim_id=claim.claim_id,
        state="ready",
        finished_at=datetime.now(UTC),
        failure_code=None,
        **facts,
    ).model_dump(mode="json")
    journal["phase"] = "published"
    host.save(journal)
    cleanup_staging(host, journal)


def fenced_claim(host: Host, journal: Json, claim: ExportClaimResponse) -> None:
    if (
        claim.installation_id != host.config.installation_id
        or str(claim.claim_id) != journal["claim_id"]
        or claim.source.installation_id != claim.installation_id
        or claim.source.claim_id == claim.claim_id
        or claim.source.run.id != claim.export.backup_run_id
        or journal["claim"] is not None
        and journal["claim"]["export"]["id"] != str(claim.export.id)
    ):
        raise RunnerError("result_unconfirmed")


def commit_export_outcome(host: Host, journal: Json) -> dict[str, object]:
    expected = ExportOutcomeCommand.model_validate(journal["outcome"])
    if expected.state == "ready":
        verify_publication(host, expected)
    try:
        returned = ExportMutationResponse.model_validate(
            host.bridge(expected.model_dump(mode="json"), journal)
        ).claim
    except ValidationError as error:
        raise RunnerError("result_unconfirmed") from error
    fenced_claim(host, journal, returned)
    if (
        returned.export.id != expected.export_id
        or returned.finished_at != expected.finished_at
        or any(
            getattr(returned.export, field) != getattr(expected, field)
            for field in ("state", "size_bytes", "sha256", "failure_code")
        )
    ):
        raise RunnerError("result_unconfirmed")
    host.finish(journal)
    return {"state": expected.state, "export_id": str(expected.export_id)}


def recover_export(host: Host, journal: Json, now: Clock) -> dict[str, object]:
    """Inspect the exact committed claim; a lost first secret can never be reissued."""
    command = {"op": "inspect-export", "claim_id": journal["claim_id"]}
    if journal["claim"] is not None:
        command["export_id"] = journal["claim"]["export"]["id"]
    try:
        claim = ExportInspectResponse.model_validate(host.bridge(command)).claim
    except ValidationError as error:
        raise RunnerError("result_unconfirmed") from error
    if claim is None:
        raise RunnerError("result_unconfirmed")
    fenced_claim(host, journal, claim)
    journal["claim"] = claim.model_dump(mode="json")
    host.save(journal)
    cleanup_staging(host, journal, missing_ok=True)
    if journal["outcome"] is not None:
        return commit_export_outcome(host, journal)
    if (
        claim.export.state == "failed"
        and claim.export.failure_code
        in {
            "source_unavailable",
            "source_unproven",
        }
        and claim.finished_at is not None
    ):
        host.finish(journal)
        return {"state": "failed", "export_id": str(claim.export.id)}
    if claim.export.state != "preparing":
        raise RunnerError("result_unconfirmed")
    journal["outcome"] = ExportOutcomeCommand(
        op="export-outcome",
        installation_id=host.config.installation_id,
        project=host.config.project_name,
        export_id=claim.export.id,
        claim_id=claim.claim_id,
        state="interrupted",
        finished_at=now(),
        size_bytes=None,
        sha256=None,
        failure_code="export_interrupted",
    ).model_dump(mode="json")
    journal["phase"] = "outcome_pending"
    host.save(journal)
    return commit_export_outcome(host, journal)


def run_export(host: Host, now: Clock) -> dict[str, object]:
    """Admit at most one export after maintenance and backup priority."""
    journal = host.prepare(str(uuid4()), [])
    journal["kind"] = "export"
    host.save(journal)
    try:
        reply = CLAIM_ADAPTER.validate_python(
            host.bridge({"op": "claim-export", "claim_id": journal["claim_id"]}, journal)
        )
    except ValidationError as error:
        raise RunnerError("result_unconfirmed") from error
    if isinstance(reply, ExportClaimNone):
        host.finish_empty(journal)
        return {"state": "idle"}
    claim = reply.claim
    fenced_claim(host, journal, claim)
    journal["claim"] = claim.model_dump(mode="json")
    journal["phase"] = "claimed"
    host.save(journal)
    if (
        isinstance(reply, ExportClaimReplay)
        and claim.export.state == "failed"
        and claim.export.failure_code in {"source_unavailable", "source_unproven"}
        and claim.finished_at is not None
    ):
        host.finish(journal)
        return {"state": "failed", "export_id": str(claim.export.id)}
    if not isinstance(reply, ExportClaimFirst):
        raise RunnerError("recovery_required")
    try:
        if (
            claim.source.run.installation != "current"
            or claim.source.run.verified_at is None
            or claim.source.run.reconciled_at is None
            or claim.source.run.expired_at is not None
        ):
            raise RunnerError("source_unproven")
        candidate_marker(host, claim.source)
    except (RunnerError, OSError, ValueError, physical_archive().BackupError):
        journal["outcome"] = ExportOutcomeCommand(
            op="export-outcome",
            installation_id=host.config.installation_id,
            project=host.config.project_name,
            export_id=claim.export.id,
            claim_id=claim.claim_id,
            state="failed",
            finished_at=now(),
            failure_code="source_unproven",
            size_bytes=None,
            sha256=None,
        ).model_dump(mode="json")
        host.save(journal)
        return commit_export_outcome(host, journal)
    stage = export_staging(host, journal, create=True)
    descriptor = os.open(
        stage / "password", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "wb") as password:
        password.write(reply.passphrase.get_secret_value().encode("utf-8"))
        password.flush()
        os.fsync(password.fileno())
    journal["phase"] = "child_launch_pending"
    host.save(journal)
    child = subprocess.Popen(
        [
            sys.executable,
            str(host.config.compose_root.parents[1] / "backend/operations/backup_runner.py"),
            "_export-child",
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
    timed_out = False
    cancelled = False
    try:
        code = child.wait(timeout=1800)
    except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        timed_out = True
        cancelled = isinstance(error, KeyboardInterrupt)
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            code = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                code = child.wait(timeout=10)
            except subprocess.TimeoutExpired as error:
                raise RunnerError("child_unresolved") from error
    saved = host.active()
    if saved is None or saved.get("child") != {"pid": child.pid, "pgid": child.pid}:
        raise RunnerError("journal_invalid")
    journal.update(saved)
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        pass
    else:
        raise RunnerError("child_unresolved")
    if code or timed_out:
        if journal["outcome"] is not None:
            raise RunnerError("result_unconfirmed")
        cleanup_staging(host, journal)
        failure = "export_interrupted" if timed_out else journal.get("failure_code", "copy_failed")
        if failure not in {"copy_failed", "verification_failed", "export_interrupted"}:
            raise RunnerError("journal_invalid")
        journal["outcome"] = ExportOutcomeCommand(
            op="export-outcome",
            installation_id=host.config.installation_id,
            project=host.config.project_name,
            export_id=claim.export.id,
            claim_id=claim.claim_id,
            state="interrupted" if timed_out else "failed",
            finished_at=now(),
            failure_code=failure,
            size_bytes=None,
            sha256=None,
        ).model_dump(mode="json")
        host.save(journal)
    if journal["outcome"] is None:
        raise RunnerError("result_unconfirmed")
    result = commit_export_outcome(host, journal)
    if cancelled:
        raise KeyboardInterrupt
    return result
