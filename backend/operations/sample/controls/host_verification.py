"""Physical source/export and independently authenticated native delivery proof."""

import hashlib
import json
import os
import secrets
import shutil
import stat
import tarfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any, cast
from uuid import UUID

from app.systems.manage.backups.schemas import (
    BackupExportResponse,
    BackupRunResponse,
    ClaimResponse,
    ExportClaimResponse,
    ExportInspectResponse,
    OutcomeCommand,
)
from operations.backups.archive import marker_facts
from operations.backups.export_files import check_file_identity, publication_proof
from operations.backups.exports import restic, single_snapshot
from operations.backups.host import Host, Json, RunnerError, digest, read_private_json
from operations.sample.controls.host_environment import HostControlRuntime, require
from operations.sample.controls.mfa_verification import _uuid
from operations.sample.phases.actions import SamplePhaseActionError
from operations.sample.population.people import SampleActorCredential
from operations.sample.verification.route_coverage import read_route_evidence

CONTROL_ROUTES = frozenset(
    {
        ("POST", "/api/backups/exports"),
        ("GET", "/api/backups/exports/{export_id}"),
        ("POST", "/api/backups/exports/{export_id}/download-admission"),
        ("GET", "/api/backups/exports/{export_id}/content"),
    }
)


@dataclass(frozen=True, repr=False)
class NativeDownloadRequest:
    credential: SampleActorCredential
    backup_run_id: str
    export_id: str
    size_bytes: int
    sha256: str
    journal_path: Path


def verify_delivery(
    runtime: HostControlRuntime,
    source: BackupRunResponse,
    exported: BackupExportResponse,
    passphrase: str,
    credential: SampleActorCredential,
) -> dict[str, object]:
    try:
        require(
            source.state == "succeeded"
            and source.installation == "current"
            and source.verified_at is not None
            and source.reconciled_at is not None
            and source.snapshot_id is not None
            and source.manifest_sha256 is not None
            and source.failure_code is None
            and source.expired_at is None
            and exported.backup_run_id == source.id
            and exported.state == "ready"
            and exported.expires_at is not None
            and exported.expires_at > datetime.now(UTC)
            and exported.size_bytes is not None
            and exported.size_bytes > 25 * 1024 * 1024,
            "host_export_proof",
        )
        host = runtime.host
        with host.locked():
            host.admit()
            require(host.active() is None, "host_claim")
            source_journal = _journal(host, source.id, export=False)
            source_claim = ClaimResponse.model_validate(
                host.bridge(
                    {
                        "op": "inspect",
                        "run_id": str(source.id),
                        "claim_id": source_journal["claim_id"],
                    }
                )["claim"]
            )
            retained = ClaimResponse.model_validate(source_journal["claim"])
            outcome = OutcomeCommand.model_validate(source_journal["outcome"])
            marker = marker_facts(host, source_journal)
            require(
                source_claim.run == source
                and source_claim.claim_id == retained.claim_id
                and source_claim.installation_id == host.config.installation_id
                and outcome.run_id == source.id
                and outcome.claim_id == retained.claim_id
                and outcome.state == "succeeded"
                and outcome.snapshot_id == source.snapshot_id
                and outcome.manifest_sha256 == source.manifest_sha256
                and marker["snapshot_id"] == source.snapshot_id
                and marker["manifest_sha256"] == source.manifest_sha256
                and datetime.fromisoformat(marker["verified_at"]) == source.verified_at,
                "host_source_proof",
            )
            export_journal = _journal(host, exported.id, export=True)
            claim = ExportInspectResponse.model_validate(
                host.bridge(
                    {
                        "op": "inspect-export",
                        "export_id": str(exported.id),
                        "claim_id": export_journal["claim_id"],
                    }
                )
            ).claim
            require(
                claim is not None
                and claim.export == exported
                and claim.source == source_claim
                and claim.installation_id == host.config.installation_id,
                "host_export_proof",
            )
            assert claim is not None
            published, identity = publication_proof(host, claim.claim_id, exported.id)
            require(
                published.size_bytes == exported.size_bytes and published.sha256 == exported.sha256,
                "host_export_proof",
            )
            path = (
                host.config.restic_repository.parent
                / "backup-exports"
                / (str(exported.id) + ".tar")
            )
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as archive:
                check_file_identity(path, archive.fileno(), identity)
                checksum = hashlib.sha256()
                for chunk in iter(lambda: archive.read(1048576), b""):
                    checksum.update(chunk)
                require(checksum.hexdigest() == exported.sha256, "host_archive")
                check_file_identity(path, archive.fileno(), identity)
            with TemporaryDirectory(prefix="verify-", dir=host.directory) as temporary:
                root = Path(temporary)
                repository = _extract_repository(path, root)
                _verify_repository(host, repository, source, passphrase)
            check_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                check_file_identity(path, check_fd, identity)
            finally:
                os.close(check_fd)
            request = NativeDownloadRequest(
                credential,
                str(source.id),
                str(exported.id),
                cast(int, exported.size_bytes),
                str(exported.sha256),
                runtime.journal_path,
            )
            native = _native_evidence(
                runtime, source, exported, credential, runtime.native_delivery(request)
            )
            return {
                **native,
                "source_backup_verified": True,
                "export_verified": True,
                "source_backup_claim_id": str(source_claim.claim_id),
                "export_claim_id": str(claim.claim_id),
                "source_snapshot_id": source.snapshot_id,
                "source_manifest_sha256": source.manifest_sha256,
                "archive_size_bytes": exported.size_bytes,
                "archive_sha256": exported.sha256,
            }
    except SamplePhaseActionError:
        raise
    except Exception:
        # The private operator/native callback boundary must never expose payloads.
        raise SamplePhaseActionError(
            "Physical delivery is not confirmed", step="host_export_proof"
        ) from None


def _journal(host: Host, identifier: UUID, *, export: bool) -> Json:
    matched: list[Json] = []
    for directory in (host.directory / "claims").iterdir():
        journal = read_private_json(directory / "journal.json")
        if (journal.get("kind") == "export") != export:
            continue
        claim = (
            ExportClaimResponse.model_validate(journal["claim"])
            if export
            else ClaimResponse.model_validate(journal["claim"])
        )
        resource = claim.export if isinstance(claim, ExportClaimResponse) else claim.run
        if resource.id != identifier:
            continue
        require(
            journal.get("version") == 1
            and journal.get("phase") == "done"
            and journal["claim_id"] == str(claim.claim_id) == directory.name
            and journal["installation_id"] == claim.installation_id == host.config.installation_id
            and journal["project"] == host.config.project_name
            and journal["template_sha256"] == digest(host.config_path)
            and journal["config_sha256"] == digest(host.run_config(journal)),
            "host_claim",
        )
        matched.append(journal)
    require(len(matched) == 1, "host_claim")
    return matched[0]


def _native_evidence(
    runtime: HostControlRuntime,
    source: BackupRunResponse,
    exported: BackupExportResponse,
    credential: SampleActorCredential,
    observation: Mapping[str, Any],
) -> dict[str, object]:
    step = "host_native"
    require(
        set(observation)
        == {
            "actor_id",
            "backup_run_id",
            "export_id",
            "size_bytes",
            "sha256",
            "request_ids",
            "headers",
            "native_download",
            "used_fetch_blob",
            "failure",
            "descriptors_released",
            "attempt_event",
        },
        step,
    )
    require(
        observation["actor_id"] == credential.user_id
        and observation["backup_run_id"] == str(source.id)
        and observation["export_id"] == str(exported.id)
        and type(observation["size_bytes"]) is int
        and observation["size_bytes"] == exported.size_bytes
        and observation["size_bytes"] > 25 * 1024 * 1024
        and observation["sha256"] == exported.sha256
        and observation["native_download"] is True
        and observation["used_fetch_blob"] is False
        and observation["failure"] is None
        and observation["descriptors_released"] is True,
        step,
    )
    ids, headers, event = (observation[key] for key in ("request_ids", "headers", "attempt_event"))
    require(
        isinstance(ids, Mapping) and set(ids) == {"login", "identity", "admission", "content"}, step
    )
    ids = {key: _uuid(value, step) for key, value in ids.items()}
    filename = f"openslate-backup-export-{exported.id}.tar"
    require(
        len(set(ids.values())) == 4
        and headers
        == {
            "cache_control": "no-store",
            "content_type": "application/octet-stream",
            "content_length": str(exported.size_bytes),
            "x_content_type_options": "nosniff",
            "accept_ranges": "none",
            "content_disposition": f'attachment; filename="{filename}"',
        },
        step,
    )
    expected = {
        "event_type": "backup.export.download",
        "outcome": "attempt",
        "source": "backup",
        "operation_id": str(exported.id),
        "subject_id": str(exported.id),
        "actor_id": credential.user_id,
        "request_id": ids["content"],
        "request_method": "GET",
        "request_path": f"/api/backups/exports/{exported.id}/content",
        "metadata": {
            "backup_run_id": str(source.id),
            "size_bytes": exported.size_bytes,
            "sha256": exported.sha256,
        },
    }
    require(
        isinstance(event, Mapping)
        and set(event) == {"id", *expected}
        and all(event.get(key) == value for key, value in expected.items())
        and type(event["metadata"]["size_bytes"]) is int,
        step,
    )
    event_id = _uuid(event["id"], step)
    _journal_requests(runtime.journal_path, ids)
    return {
        "native_download_verified": True,
        "native_attempt_event_id": event_id,
        **{f"native_{key}_request_id": value for key, value in ids.items()},
    }


def _journal_requests(path: Path, ids: Mapping[str, str]) -> None:
    read_route_evidence(path)
    routes = {
        "login": ("POST", "/api/auth/login"),
        "identity": ("GET", "/api/auth/me"),
        "admission": ("POST", "/api/backups/exports/{export_id}/download-admission"),
        "content": ("GET", "/api/backups/exports/{export_id}/content"),
    }
    started, observed = {}, []
    with path.open() as stream:
        for line in stream:
            row = json.loads(line)
            if row.get("event") == "request_started":
                started[row["attempt_id"]] = (row.get("method"), row.get("route_template"))
            elif row.get("event") == "request_finished" and row.get("request_id") in ids.values():
                key = next(key for key, value in ids.items() if value == row["request_id"])
                require(
                    started[row["attempt_id"]] == routes[key]
                    and row.get("status_code") == 200
                    and not row.get("failure_code"),
                    "host_native_journal",
                )
                observed.append(key)
    require(sorted(observed) == sorted(ids), "host_native_journal")


def _extract_repository(archive: Path, target: Path) -> Path:
    try:
        details = target.lstat()
        require(
            stat.S_ISDIR(details.st_mode)
            and details.st_uid == os.geteuid()
            and stat.S_IMODE(details.st_mode) == 0o700
            and not tuple(target.iterdir()),
            "host_archive",
        )
        with tarfile.open(archive, mode="r|") as source:
            for member in source:
                parts = PurePosixPath(member.name).parts
                require(
                    bool(parts)
                    and parts[0] == "repository"
                    and ".." not in parts
                    and (member.isdir() or member.isreg())
                    and not member.issparse(),
                    "host_archive",
                )
                require(
                    len(parts) == 1
                    and member.isdir()
                    or len(parts) > 1
                    and parts[1] in {"config", "data", "index", "keys", "snapshots", "locks"},
                    "host_archive",
                )
                path = target.joinpath(*parts)
                if member.isdir():
                    path.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                data = source.extractfile(member)
                require(data is not None, "host_archive")
                assert data is not None
                descriptor = os.open(
                    path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
                )
                with os.fdopen(descriptor, "wb") as destination, data:
                    shutil.copyfileobj(data, destination, 1048576)
                require(path.stat().st_size == member.size, "host_archive")
        repository = target / "repository"
        require((repository / "config").is_file(), "host_archive")
        return repository
    except SamplePhaseActionError:
        raise
    except (OSError, ValueError, tarfile.TarError):
        raise SamplePhaseActionError(
            "Export archive is not confined", step="host_archive"
        ) from None


def _verify_repository(
    host: Any, repository: Path, source: BackupRunResponse, passphrase: str
) -> None:
    try:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "RESTIC_REPOSITORY": str(repository),
            "RESTIC_PASSWORD": passphrase,
        }
        destination = single_snapshot(
            restic(host, repository.parent, ["snapshots", "--json"], env, "verification_failed")
        )
        restic(host, repository.parent, ["check", "--read-data"], env, "verification_failed")
        manifest = restic(
            host,
            repository.parent,
            ["dump", destination["id"], destination["paths"][0] + "/manifest.json"],
            env,
            "verification_failed",
        )
        document = json.loads(manifest)
        require(
            hashlib.sha256(manifest).hexdigest() == source.manifest_sha256
            and document.get("format_version") == 3
            and document.get("source_installation_id") == host.config.installation_id
            and document.get("source_project") == host.config.project_name
            and document.get("deployment") == "production",
            "host_repository",
        )
        for password in (
            secrets.token_urlsafe(32),
            host.config.restic_password_file.read_text().strip(),
        ):
            require(password != passphrase, "host_repository")
            try:
                restic(
                    host,
                    repository.parent,
                    ["snapshots", "--json"],
                    {**env, "RESTIC_PASSWORD": password},
                    "verification_failed",
                )
            except RunnerError:
                continue
            raise SamplePhaseActionError(
                "Export password isolation is not confirmed", step="host_repository"
            )
    except SamplePhaseActionError:
        raise
    except (OSError, ValueError, TypeError, RunnerError):
        raise SamplePhaseActionError(
            "Export repository verification failed", step="host_repository"
        ) from None
