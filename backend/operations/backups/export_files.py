"""Owned export filesystem admission, private staging and exclusive publication."""

import hashlib
import os
import shutil
import stat
import tarfile
import time
from pathlib import Path
from uuid import UUID

from app.systems.manage.backups.schemas import (
    ExportClaimResponse,
    ExportCleanedCommand,
    ExportOutcomeCommand,
)
from operations.backups.host import (
    Host,
    Json,
    RunnerError,
    digest,
    fsync_directory,
    physical_archive,
    private_json,
    read_private_json,
)

EXPORT_GID = 10001
API_ROOT = "/var/lib/openslate/backup-exports"
IDENTITY_FIELDS = (
    "st_dev",
    "st_ino",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
    "st_uid",
    "st_gid",
    "st_mode",
    "st_nlink",
)


def admit_export(host: Host, values: dict[str, str]) -> None:
    """Keep group-readable finished output separate from every private backup input."""
    root = host.config.restic_repository.parent / "backup-exports"
    physical_archive()._assert_no_symlink(root, "finished exports")
    details = root.stat()
    configured = [
        line.partition("=")[2]
        for line in host.config.provider_env_file.read_text().splitlines()
        if line.startswith("OPENSLATE_BACKUP_EXPORT_ROOT=")
    ]
    if (
        configured != [str(root)]
        or values.get("BACKUP_EXPORT_ROOT", API_ROOT) != API_ROOT
        or not stat.S_ISDIR(details.st_mode)
        or stat.S_IMODE(details.st_mode) != 0o750
        or details.st_uid != os.geteuid()
        or details.st_gid != EXPORT_GID
    ):
        raise RunnerError("admission_failed")
    private = (
        host.config.restic_repository,
        host.config.restic_password_file,
        host.config.staging_directory,
        host.state_directory,
        host.config_path,
        host.config.provider_env_file,
        host.config.app_env_file,
        host.config.caddy_config_file,
        host.config.tls_directory,
        host.config.compose_root,
        host.config.completion_marker.parent,
    )
    staging = root.parent / "backup-export-staging"
    physical_archive()._assert_no_symlink(staging, "private export staging")
    if any(
        operation.is_relative_to(path) or path.is_relative_to(operation)
        for operation in (root, staging)
        for path in private
    ):
        raise RunnerError("admission_failed")
    log_sources = [
        line.partition("=")[2]
        for line in host.config.provider_env_file.read_text().splitlines()
        if line.startswith("OPENSLATE_LOG_ROOT=")
    ]
    if len(log_sources) != 1 or not Path(log_sources[0]).is_absolute():
        raise RunnerError("admission_failed")
    log_root = Path(log_sources[0])
    physical_archive()._assert_no_symlink(log_root, "private application logs")
    log_root = log_root.resolve(strict=True)
    if not log_root.is_dir() or any(
        log_root.is_relative_to(path.resolve()) or path.resolve().is_relative_to(log_root)
        for path in (*private, root, staging)
    ):
        raise RunnerError("admission_failed")
    api = next(
        item for item in host.containers if host.labels(item)["com.docker.compose.service"] == "api"
    )
    environment = api.get("Config", {}).get("Env", [])
    mounts = [item for item in api.get("Mounts", []) if item.get("Type") in {"bind", "volume"}]
    exports = [item for item in mounts if item.get("Destination") == API_ROOT]
    logs = [item for item in mounts if item.get("Destination") == "/var/log/openslate"]
    if (
        [
            item
            for item in environment
            if isinstance(item, str) and item.startswith("BACKUP_EXPORT_ROOT=")
        ]
        != ["BACKUP_EXPORT_ROOT=" + API_ROOT]
        or any(not isinstance(item, str) for item in environment)
        or len(mounts) != 2
        or len(exports) != 1
        or len(logs) != 1
        or exports[0].get("Type") != "bind"
        or exports[0].get("Source") != str(root)
        or exports[0].get("RW") is not False
        or logs[0].get("Type") != "bind"
        or logs[0].get("Source") != str(log_root)
        or logs[0].get("RW") is not True
    ):
        raise RunnerError("admission_failed")


def export_staging(host: Host, journal: Json, *, create: bool = False) -> Path:
    root = host.config.restic_repository.parent / "backup-export-staging"
    physical = physical_archive()
    physical._assert_no_symlink(root, "private export staging")
    if create:
        root.mkdir(mode=0o700, exist_ok=True)
    physical._private(root, "private export staging", directory=True)
    if (
        stat.S_IMODE(root.stat().st_mode) != 0o700
        or root.stat().st_uid != os.geteuid()
        or root.stat().st_dev != (root.parent / "backup-exports").stat().st_dev
        or root.is_relative_to(host.state_directory)
        or host.state_directory.is_relative_to(root)
    ):
        raise RunnerError("result_unconfirmed")
    directory: Path = root / journal["claim_id"]
    physical._assert_no_symlink(directory, "owned export staging")
    if create:
        directory.mkdir(mode=0o700)
    physical._private(directory, "owned export staging", directory=True)
    if stat.S_IMODE(directory.stat().st_mode) != 0o700 or directory.stat().st_uid != os.geteuid():
        raise RunnerError("result_unconfirmed")
    return directory


def cleanup_staging(host: Host, journal: Json, *, missing_ok: bool = False) -> None:
    """Remove only the exact claim's admitted private directory after child disposition."""
    try:
        expected = (
            host.config.restic_repository.parent / "backup-export-staging" / journal["claim_id"]
        )
        physical_archive()._assert_no_symlink(expected, "owned export staging")
        if missing_ok:
            try:
                expected.lstat()
            except FileNotFoundError:
                return
        directory = export_staging(host, journal)
        shutil.rmtree(directory)
        fsync_directory(directory.parent)
    except (OSError, ValueError, physical_archive().BackupError) as error:
        raise RunnerError("result_unconfirmed") from error


def artifact_absent(host: Host, claim: ExportClaimResponse) -> bool:
    path = host.config.restic_repository.parent / "backup-exports" / (str(claim.export.id) + ".tar")
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    return False


def file_identity(details: os.stat_result) -> dict[str, int]:
    identity = {key: int(getattr(details, key)) for key in IDENTITY_FIELDS}
    identity["st_mode"] = stat.S_IMODE(details.st_mode)
    return identity


def publication_proof(
    host: Host,
    claim_id: UUID,
    export_id: UUID,
) -> tuple[ExportOutcomeCommand, dict[str, int]]:
    """Read the exact durable ready proof; never adopt an existing unproven UUID file."""
    try:
        journal = read_private_json(
            host.run_directory({"claim_id": str(claim_id)}) / "journal.json"
        )
        claim = ExportClaimResponse.model_validate(journal["claim"])
        outcome = ExportOutcomeCommand.model_validate(journal["outcome"])
        proof = journal["publication"]
        if (
            journal.get("version") != 1
            or journal.get("kind") != "export"
            or journal.get("phase") not in {"published", "outcome_pending", "done"}
            or journal["claim_id"] != str(claim_id)
            or journal["installation_id"] != host.config.installation_id
            or journal["project"] != host.config.project_name
            or journal["template_sha256"] != digest(host.config_path)
            or journal["config_sha256"] != digest(host.run_config(journal))
            or claim.claim_id != claim_id
            or claim.export.id != export_id
            or claim.installation_id != host.config.installation_id
            or claim.source.installation_id != claim.installation_id
            or claim.source.claim_id == claim_id
            or claim.source.run.id != claim.export.backup_run_id
            or outcome.state != "ready"
            or outcome.claim_id != claim_id
            or outcome.export_id != export_id
            or outcome.installation_id != host.config.installation_id
            or outcome.project != host.config.project_name
            or not isinstance(proof, dict)
            or set(proof) != set(IDENTITY_FIELDS)
            or any(type(value) is not int for value in proof.values())
            or proof["st_size"] != outcome.size_bytes
            or proof["st_uid"] != os.geteuid()
            or proof["st_gid"] != EXPORT_GID
            or proof["st_mode"] != 0o640
            or proof["st_nlink"] != 1
        ):
            raise RunnerError("result_unconfirmed")
        return outcome, {key: int(proof[key]) for key in IDENTITY_FIELDS}
    except (OSError, ValueError, KeyError, TypeError, physical_archive().BackupError) as error:
        raise RunnerError("result_unconfirmed") from error


def check_file_identity(path: Path, descriptor: int, proof: dict[str, int]) -> None:
    details = os.fstat(descriptor)
    current = path.lstat()
    if (
        not stat.S_ISREG(details.st_mode)
        or not stat.S_ISREG(current.st_mode)
        or file_identity(details) != proof
        or file_identity(current) != proof
    ):
        raise RunnerError("result_unconfirmed")


def verify_publication(host: Host, expected: ExportOutcomeCommand) -> None:
    """Ready and recovery may submit only the fsynced proof of the unchanged final inode."""
    try:
        retained, proof = publication_proof(host, expected.claim_id, expected.export_id)
        if retained != expected:
            raise RunnerError("result_unconfirmed")
        path = (
            host.config.restic_repository.parent
            / "backup-exports"
            / (str(expected.export_id) + ".tar")
        )
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            check_file_identity(path, stream.fileno(), proof)
    except OSError as error:
        raise RunnerError("result_unconfirmed") from error


def delete_expired_artifact(host: Host, claim: ExportClaimResponse, deadline: float) -> bool:
    """Verify the exact owned artifact before removal; unknown or changed files remain."""
    root = host.config.restic_repository.parent / "backup-exports"
    path = root / (str(claim.export.id) + ".tar")
    if time.monotonic() >= deadline:
        return False
    retained, proof = publication_proof(host, claim.claim_id, claim.export.id)
    if retained.size_bytes != claim.export.size_bytes or retained.sha256 != claim.export.sha256:
        raise RunnerError("result_unconfirmed")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return True
    except OSError as error:
        raise RunnerError("result_unconfirmed") from error
    try:
        with os.fdopen(descriptor, "rb") as stream:
            check_file_identity(path, stream.fileno(), proof)
            if time.monotonic() >= deadline:
                return False
            path.unlink()
        fsync_directory(root)
        if not artifact_absent(host, claim):
            raise RunnerError("result_unconfirmed")
        return True
    except OSError as error:
        raise RunnerError("result_unconfirmed") from error


def publish_repository(
    host: Host, stage: Path, claim: ExportClaimResponse
) -> tuple[Json, dict[str, int]]:
    repository = stage / "repository"
    locks = repository / "locks"
    if locks.exists() and any(locks.iterdir()):
        raise RunnerError("verification_failed")
    archive_path = stage / "archive.tar"
    descriptor = os.open(archive_path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)

    def confined(member: tarfile.TarInfo) -> tarfile.TarInfo:
        details = (stage / member.name).lstat()
        if (
            not (member.isdir() or member.isreg())
            or details.st_uid != os.geteuid()
            or member.isreg()
            and details.st_nlink != 1
        ):
            raise RunnerError("verification_failed")
        member.uid = member.gid = 0
        member.uname = member.gname = ""
        return member

    root = host.config.restic_repository.parent / "backup-exports"
    path = root / (str(claim.export.id) + ".tar")
    with os.fdopen(descriptor, "w+b") as output:
        with tarfile.open(fileobj=output, mode="w") as archive:
            archive.add(repository, arcname="repository", filter=confined)
        output.flush()
        os.fchown(output.fileno(), -1, EXPORT_GID)
        os.fchmod(output.fileno(), 0o640)
        os.fsync(output.fileno())
        output.seek(0)
        checksum = hashlib.sha256()
        for chunk in iter(lambda: output.read(1048576), b""):
            checksum.update(chunk)
        size = output.tell()
        os.link(archive_path, path, follow_symlinks=False)
        archive_path.unlink()
        fsync_directory(stage)
        fsync_directory(root)
        identity = file_identity(os.fstat(output.fileno()))
        if (
            identity["st_size"] != size
            or identity["st_nlink"] != 1
            or identity["st_uid"] != os.geteuid()
            or identity["st_gid"] != EXPORT_GID
            or identity["st_mode"] != 0o640
        ):
            raise RunnerError("verification_failed")
        check_file_identity(path, output.fileno(), identity)
    return {"size_bytes": size, "sha256": checksum.hexdigest()}, identity


def cleanup_claim(host: Host, claim: ExportClaimResponse) -> None:
    if (
        claim.installation_id != host.config.installation_id
        or claim.source.installation_id != claim.installation_id
        or claim.source.claim_id == claim.claim_id
        or claim.source.run.id != claim.export.backup_run_id
        or claim.export.state not in {"ready", "expired"}
        or claim.export.ready_at is None
        or claim.export.expires_at is None
        or claim.export.size_bytes is None
        or claim.export.sha256 is None
        or claim.export.failure_code is not None
        or claim.finished_at is None
        or claim.artifact_deleted_at is not None
    ):
        raise RunnerError("result_unconfirmed")


def retain_cleanup_acknowledgement(
    host: Host,
    claim: ExportClaimResponse,
    command: ExportCleanedCommand,
) -> None:
    private_json(
        host.directory / "export-cleanup.json",
        {
            "version": 1,
            "installation_id": host.config.installation_id,
            "project": host.config.project_name,
            "template_sha256": digest(host.config_path),
            "claim": claim.model_dump(mode="json"),
            "command": command.model_dump(mode="json"),
        },
    )


def cleanup_acknowledgement(host: Host) -> tuple[ExportClaimResponse, ExportCleanedCommand] | None:
    """Read only this installation's private, exact, verified-absence record."""
    path = host.directory / "export-cleanup.json"
    try:
        try:
            path.lstat()
        except FileNotFoundError:
            return None
        pending = read_private_json(path)
        claim = ExportClaimResponse.model_validate(pending["claim"])
        command = ExportCleanedCommand.model_validate(pending["command"])
        cleanup_claim(host, claim)
        retained, _ = publication_proof(host, claim.claim_id, claim.export.id)
        if retained.size_bytes != claim.export.size_bytes or retained.sha256 != claim.export.sha256:
            raise RunnerError("result_unconfirmed")
        if (
            set(pending)
            != {"version", "installation_id", "project", "template_sha256", "claim", "command"}
            or pending["version"] != 1
            or pending["installation_id"] != host.config.installation_id
            or pending["project"] != host.config.project_name
            or pending["template_sha256"] != digest(host.config_path)
            or command.installation_id != host.config.installation_id
            or command.project != host.config.project_name
            or command.export_id != claim.export.id
            or command.claim_id != claim.claim_id
            or claim.export.expires_at is None
            or command.deleted_at < claim.export.expires_at
            or not artifact_absent(host, claim)
        ):
            raise RunnerError("result_unconfirmed")
        return claim, command
    except (OSError, ValueError, KeyError, TypeError, physical_archive().BackupError) as error:
        raise RunnerError("result_unconfirmed") from error


def clear_cleanup_acknowledgement(host: Host) -> None:
    path = host.directory / "export-cleanup.json"
    path.unlink()
    fsync_directory(path.parent)
