"""Inspect, restore, and finalize an isolated Supabase installation recovery."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from .backup_installation import (
    _IDENTITY,
    _PROJECT,
    _SNAPSHOT,
    BackupConfig,
    BackupError,
    _atomic_json,
    _command,
    _docker_inventory,
    _env,
    _json_output,
    _labels,
    _private,
    _restic_env,
    _run,
    _sha256,
    parse_config,
)

_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_FINALIZE_SQL = (
    "BEGIN; "
    "UPDATE public.identity_sessions SET "
    "revoked_at = COALESCE(revoked_at, NOW()), "
    "provider_access_token_encrypted = NULL, "
    "provider_refresh_token_encrypted = NULL, "
    "provider_signout_pending_at = NULL, "
    "provider_signout_next_attempt_at = NULL "
    "WHERE revoked_at IS NULL OR provider_access_token_encrypted IS NOT NULL "
    "OR provider_refresh_token_encrypted IS NOT NULL "
    "OR provider_signout_pending_at IS NOT NULL "
    "OR provider_signout_next_attempt_at IS NOT NULL; "
    "COMMIT;"
)
_TARGET_IDENTITY_SQL = (
    "SELECT json_build_object('database', current_database(), 'user', current_user, "
    "'cluster_name', current_setting('cluster_name', true));"
)
_SESSION_POSTCONDITION_SQL = (
    "SELECT NOT EXISTS (SELECT 1 FROM public.identity_sessions WHERE "
    "revoked_at IS NULL OR provider_access_token_encrypted IS NOT NULL "
    "OR provider_refresh_token_encrypted IS NOT NULL "
    "OR provider_signout_pending_at IS NOT NULL "
    "OR provider_signout_next_attempt_at IS NOT NULL);"
)


@dataclass(frozen=True)
class RestoreResult:
    snapshot_id: str
    source_installation_id: str
    target_project: str
    target_instance_id: str
    executed: bool


def _target_instance_id(config: BackupConfig, value: str) -> str:
    if (
        not isinstance(value, str)
        or not _IDENTITY.fullmatch(value)
        or value == config.installation_id
    ):
        raise BackupError(
            "target instance ID must be valid and distinct from the source installation"
        )
    return value


def confirmation_text(
    config_path: Path,
    snapshot_id: str,
    target_project: str,
    target_directory: Path,
    target_instance_id: str,
) -> str:
    config = parse_config(config_path)
    _target_instance_id(config, target_instance_id)
    target = {
        "source_project": config.project_name,
        "source_installation_id": config.installation_id,
        "snapshot_id": snapshot_id,
        "target_project": target_project,
        "target_instance_id": target_instance_id,
        "target_directory": str(target_directory.resolve()),
    }
    digest = hashlib.sha256(
        json.dumps(target, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()[:20]
    return f"RESTORE {snapshot_id} FROM {config.project_name} INTO {target_project} TARGET {digest}"


def _target_preflight(
    config: BackupConfig,
    project: str,
    directory: Path,
    runner: Callable[..., subprocess.CompletedProcess[bytes]],
) -> None:
    if not _PROJECT.fullmatch(project) or project == config.project_name:
        raise BackupError("restore target must use a valid project distinct from the source")
    if not directory.is_absolute() or directory.exists() or directory.is_symlink():
        raise BackupError("restore target directory must be a fresh absolute path")
    _private(directory.parent, "target parent directory", directory=True)
    for noun in ("container", "volume", "network"):
        if _docker_inventory(runner, noun, project):
            raise BackupError("restore target project already owns Docker resources")
    # Also reject orphan resources with target names but missing Compose labels.
    checks = (
        (["docker", "ps", "-a", "--format", "{{.Names}}"], (f"{project}-",)),
        (["docker", "volume", "ls", "--format", "{{.Name}}"], (f"{project}_",)),
        (["docker", "network", "ls", "--format", "{{.Name}}"], (f"{project}_",)),
    )
    for args, prefixes in checks:
        names = _run(runner, args, "Docker target collision inventory").decode("utf-8").splitlines()
        if any(name.startswith(prefixes) for name in names):
            raise BackupError("restore target has a colliding Docker resource")


def _snapshot_bundle_path(inventory: bytes) -> PurePosixPath:
    nodes: dict[str, str] = {}
    for line in inventory.splitlines():
        item = _json_output(line, "Restic inventory")
        if not isinstance(item, dict):
            raise BackupError("Restic inventory has an invalid node")
        if item.get("struct_type") == "snapshot":
            continue
        if item.get("struct_type") != "node":
            raise BackupError("Restic inventory has an unknown node")
        raw = item.get("path")
        kind = item.get("type")
        if (
            not isinstance(raw, str)
            or not raw.startswith("/")
            or "//" in raw
            or ".." in PurePosixPath(raw).parts
            or PurePosixPath(raw).as_posix() != raw
        ):
            raise BackupError("Restic inventory contains an unsafe path")
        if raw in nodes or kind not in {"file", "dir"}:
            raise BackupError("Restic inventory contains an unsafe or duplicate entry")
        nodes[raw] = kind
    manifests = [
        PurePosixPath(path)
        for path, kind in nodes.items()
        if kind == "file" and path.endswith("/bundle/manifest.json")
    ]
    if len(manifests) != 1:
        raise BackupError("Restic snapshot must contain one Supabase bundle")
    bundle = manifests[0].parent
    for path, kind in nodes.items():
        candidate = PurePosixPath(path)
        if (
            candidate != bundle
            and bundle not in candidate.parents
            and not (kind == "dir" and candidate in bundle.parents)
        ):
            raise BackupError("Restic snapshot contains files outside its Supabase bundle")
    return bundle


def _validated_bundle(bundle: Path, config: BackupConfig) -> dict[str, object]:
    manifest_path = bundle / "manifest.json"
    if (
        manifest_path.is_symlink()
        or not manifest_path.is_file()
        or manifest_path.stat().st_size > 2_000_000
    ):
        raise BackupError("restored manifest is missing or unsafe")
    manifest = _json_output(manifest_path.read_bytes(), "Supabase manifest")
    if not isinstance(manifest, dict) or set(manifest) != {
        "format_version",
        "source_installation_id",
        "source_project",
        "deployment",
        "created_at",
        "images",
        "volumes",
        "files",
    }:
        raise BackupError("Supabase manifest fields are invalid")
    if manifest["format_version"] != 3 or type(manifest["format_version"]) is not int:
        raise BackupError("restore requires Supabase bundle format version 3")
    if (manifest["source_installation_id"], manifest["source_project"], manifest["deployment"]) != (
        config.installation_id,
        config.project_name,
        config.deployment,
    ):
        raise BackupError("Supabase bundle source identity does not match configuration")
    volumes = manifest["volumes"]
    images = manifest["images"]
    if (
        not isinstance(volumes, dict)
        or set(volumes) != set(config.volume_names)
        or any(
            volumes.get(logical) != f"{config.project_name}_{logical}"
            for logical in config.volume_names
        )
    ):
        raise BackupError("Supabase bundle volume inventory is invalid")
    if not isinstance(images, dict) or "db" not in images:
        raise BackupError("Supabase bundle image inventory is invalid")
    for value in images.values():
        if (
            not isinstance(value, dict)
            or set(value) != {"ref", "id"}
            or not isinstance(value["ref"], str)
            or not isinstance(value["id"], str)
            or not value["id"].startswith("sha256:")
        ):
            raise BackupError("Supabase bundle image identity is invalid")
    if "@sha256:" not in images["db"]["ref"]:
        raise BackupError("restored PostgreSQL image is not pinned")
    files = manifest["files"]
    if not isinstance(files, dict):
        raise BackupError("Supabase bundle file inventory is invalid")
    actual: set[str] = set()
    for path in bundle.rglob("*"):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise BackupError("Supabase bundle contains unsafe filesystem entries")
        if path.is_file() and path != manifest_path:
            actual.add(path.relative_to(bundle).as_posix())
    expected = {f"volumes/{name}.tar" for name in config.volume_names}
    expected.update(
        {"private/provider.env", "compose/compose.yaml", f"compose/{config.compose_files[1].name}"}
    )
    if config.deployment == "production":
        expected.update({"private/app.env", "private/Caddyfile"})
    if not expected <= actual or set(files) != actual:
        raise BackupError("Supabase bundle is missing or has unlisted files")
    for relative, details in files.items():
        relative_path = PurePosixPath(relative)
        if (
            relative_path.is_absolute()
            or ".." in relative_path.parts
            or not isinstance(details, dict)
            or set(details) != {"sha256", "bytes"}
        ):
            raise BackupError("Supabase bundle file entry is invalid")
        digest, length = details["sha256"], details["bytes"]
        if (
            not isinstance(digest, str)
            or not _DIGEST.fullmatch(digest)
            or type(length) is not int
            or length < 0
        ):
            raise BackupError("Supabase bundle file digest is invalid")
        source = bundle / relative
        if not source.is_file() or source.stat().st_size != length or _sha256(source) != digest:
            raise BackupError("Supabase bundle file failed integrity verification")
    # The operator must check out the exact same deployment release to restore.
    for bundled in (bundle / "compose").rglob("*"):
        if bundled.is_file():
            working = config.compose_root / bundled.relative_to(bundle / "compose")
            if (
                not working.is_file()
                or working.is_symlink()
                or _sha256(working) != _sha256(bundled)
            ):
                raise BackupError("recovery checkout differs from the pinned Compose bundle")
    return manifest


def _validate_tar(path: Path) -> None:
    try:
        with tarfile.open(path, mode="r:") as archive:
            names: set[str] = set()
            for member in archive:
                member_path = PurePosixPath(member.name)
                if (
                    member_path.is_absolute()
                    or ".." in member_path.parts
                    or not (member.isfile() or member.isdir())
                    or member.name in names
                ):
                    raise BackupError("volume archive contains unsafe entries")
                names.add(member.name)
    except (OSError, tarfile.TarError) as error:
        raise BackupError("volume archive cannot be validated") from error


def _image_preflight(
    manifest: Mapping[str, object], runner: Callable[..., subprocess.CompletedProcess[bytes]]
) -> None:
    images = manifest["images"]
    assert isinstance(images, dict)
    for value in images.values():
        assert isinstance(value, dict)
        result = _json_output(
            _run(runner, ["docker", "image", "inspect", value["ref"]], "pinned image admission"),
            "pinned image admission",
        )
        if (
            not isinstance(result, list)
            or len(result) != 1
            or not isinstance(result[0], dict)
            or result[0].get("Id") != value["id"]
        ):
            raise BackupError("local image differs from the exact backed-up image")


def _import_volume(volume: str, image: str, archive: Path) -> None:
    # Restore numeric owners, traverse restored private directories, and retain their modes.
    # BusyBox tar can silently leave root ownership without CHOWN.
    args = [
        "docker",
        "run",
        "-i",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "0:0",
        "--mount",
        f"type=volume,source={volume},target=/target",
        "--entrypoint",
        "tar",
        image,
        "-C",
        "/target",
        "--numeric-owner",
        "-xf",
        "-",
    ]
    with archive.open("rb") as incoming:
        try:
            result = subprocess.run(
                args,
                env=_env(),
                stdin=incoming,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                check=False,
            )
        except OSError as error:
            raise BackupError("Docker volume import is unavailable") from error
    if result.returncode:
        raise BackupError("Docker volume import failed")


def run_restore(
    config_path: Path,
    snapshot_id: str,
    target_project: str,
    target_directory: Path,
    target_instance_id: str,
    *,
    execute: bool = False,
    confirmation: str | None = None,
    tty: bool | None = None,
    command_runner: Callable[..., subprocess.CompletedProcess[bytes]] = _command,
) -> RestoreResult:
    config = parse_config(config_path)
    if not _SNAPSHOT.fullmatch(snapshot_id):
        raise BackupError("snapshot ID must be a full 64-character hexadecimal Restic ID")
    if not _PROJECT.fullmatch(target_project) or target_project == config.project_name:
        raise BackupError("restore target must be distinct from the source project")
    _target_instance_id(config, target_instance_id)
    if execute:
        if not (sys.stdin.isatty() if tty is None else tty):
            raise BackupError("restore execution requires an interactive terminal")
        if confirmation != confirmation_text(
            config_path, snapshot_id, target_project, target_directory, target_instance_id
        ):
            raise BackupError("exact snapshot and target confirmation is required")
    _private(config_path, "restore configuration", directory=False)
    _private(config.restic_password_file, "Restic password file", directory=False)
    _private(config.restic_repository, "Restic repository", directory=True)
    _private(config.staging_directory, "restore staging directory", directory=True)
    _target_preflight(config, target_project, target_directory, command_runner)
    run_dir = Path(
        tempfile.mkdtemp(prefix="openslate-supabase-restore-", dir=config.staging_directory)
    )
    run_dir.chmod(0o700)
    try:
        restic_env = _restic_env(config, run_dir)
        inventory = _run(
            command_runner,
            ["restic", "ls", "--json", snapshot_id],
            "Restic snapshot inventory",
            env=restic_env,
        )
        source_bundle = _snapshot_bundle_path(inventory)
        restored = run_dir / "restored"
        restored.mkdir(mode=0o700)
        _run(
            command_runner,
            ["restic", "restore", snapshot_id, "--target", str(restored)],
            "Restic snapshot restore",
            env=restic_env,
        )
        bundle = restored / str(source_bundle).lstrip("/")
        manifest = _validated_bundle(bundle, config)
        _image_preflight(manifest, command_runner)
        for logical in config.volume_names:
            _validate_tar(bundle / "volumes" / f"{logical}.tar")
        result = RestoreResult(
            snapshot_id, config.installation_id, target_project, target_instance_id, execute
        )
        if not execute:
            return result
        _target_preflight(config, target_project, target_directory, command_runner)
        images = manifest["images"]
        assert isinstance(images, dict)
        db_image = images["db"]["ref"]
        for logical in config.volume_names:
            volume = f"{target_project}_{logical}"
            output = _run(
                command_runner,
                [
                    "docker",
                    "volume",
                    "create",
                    "--label",
                    f"com.docker.compose.project={target_project}",
                    "--label",
                    f"com.docker.compose.volume={logical}",
                    volume,
                ],
                "fresh target volume creation",
            )
            if output.decode("utf-8").strip() != volume:
                raise BackupError("Docker returned an unexpected target volume")
            _import_volume(volume, db_image, bundle / "volumes" / f"{logical}.tar")
        target_directory.mkdir(mode=0o700)
        shutil.copytree(bundle / "private", target_directory / "restored-source-private")
        shutil.copytree(bundle / "compose", target_directory / "compose")
        for file in target_directory.rglob("*"):
            if file.is_file():
                file.chmod(0o600)
            elif file.is_dir():
                file.chmod(0o700)
        pending_marker: dict[str, object] = {
            "format_version": 3,
            "snapshot_id": snapshot_id,
            "source_installation_id": config.installation_id,
            "source_project": config.project_name,
            "target_project": target_project,
            "target_instance_id": target_instance_id,
            "manifest_sha256": _sha256(bundle / "manifest.json"),
            "volume_names": [f"{target_project}_{logical}" for logical in config.volume_names],
            "restored_at": datetime.now(UTC).isoformat(),
            "finalized": False,
        }
    finally:
        shutil.rmtree(run_dir)
    _atomic_json(target_directory / "restore-pending.json", pending_marker)
    return result


def run_finalize(
    config_path: Path,
    snapshot_id: str,
    target_project: str,
    target_directory: Path,
    target_instance_id: str,
    *,
    command_runner: Callable[..., subprocess.CompletedProcess[bytes]] = _command,
) -> None:
    config = parse_config(config_path)
    if (
        not _SNAPSHOT.fullmatch(snapshot_id)
        or not _PROJECT.fullmatch(target_project)
        or target_project == config.project_name
    ):
        raise BackupError("finalization identity is invalid")
    _target_instance_id(config, target_instance_id)
    pending_path = target_directory / "restore-pending.json"
    _private(target_directory, "restored target directory", directory=True)
    _private(pending_path, "pending restore marker", directory=False)
    if (target_directory / "restore-finalized.json").exists():
        raise BackupError("restore has already been finalized")
    pending = _json_output(pending_path.read_bytes(), "pending restore marker")
    if (
        not isinstance(pending, dict)
        or pending.get("format_version") != 3
        or pending.get("snapshot_id") != snapshot_id
        or pending.get("target_project") != target_project
        or pending.get("source_installation_id") != config.installation_id
        or pending.get("target_instance_id") != target_instance_id
    ):
        raise BackupError("pending restore identity does not match this target")
    expected_volumes = [f"{target_project}_{logical}" for logical in config.volume_names]
    if pending.get("volume_names") != expected_volumes:
        raise BackupError("pending restore volume identity is invalid")
    containers = _docker_inventory(command_runner, "container", target_project)
    db: dict[str, object] | None = None
    for item in containers:
        labels = _labels(item, container=True)
        state = item.get("State")
        if labels.get("com.docker.compose.project") != target_project or not isinstance(
            state, dict
        ):
            raise BackupError("target container ownership is invalid")
        if state.get("Status") == "running":
            if labels.get("com.docker.compose.service") != "db" or db is not None:
                raise BackupError(
                    "only the isolated target PostgreSQL service may run during finalization"
                )
            db = item
    if db is None:
        raise BackupError("start only the isolated target PostgreSQL service before finalization")
    host_config = db.get("HostConfig")
    if not isinstance(host_config, dict) or host_config.get("PortBindings"):
        raise BackupError("target PostgreSQL must have no published host port")
    mounts = db.get("Mounts")
    if not isinstance(mounts, list) or any(
        not isinstance(mount, dict)
        or not isinstance(mount.get("Destination"), str)
        or not mount["Destination"].startswith("/")
        or ".." in PurePosixPath(mount["Destination"]).parts
        or PurePosixPath(mount["Destination"]).as_posix() != mount["Destination"]
        for mount in mounts
    ):
        raise BackupError("target PostgreSQL mounts are unavailable or invalid")
    for destination, logical in (
        ("/var/lib/postgresql/data", "supabase-db-data"),
        ("/etc/postgresql-custom", "supabase-db-config"),
    ):
        overlapping = [
            mount
            for mount in mounts
            if mount["Destination"] == destination
            or mount["Destination"].startswith(destination + "/")
            or destination.startswith(mount["Destination"].rstrip("/") + "/")
        ]
        if (
            len(overlapping) != 1
            or overlapping[0].get("Destination") != destination
            or overlapping[0].get("Type") != "volume"
            or overlapping[0].get("Name") != f"{target_project}_{logical}"
        ):
            raise BackupError("target PostgreSQL data/config mount identity is invalid")
    db_config = db.get("Config")
    if not isinstance(db_config, dict) or not isinstance(db_config.get("Image"), str):
        raise BackupError("target PostgreSQL image is unavailable")
    image_ref = db_config["Image"]
    if "@sha256:" not in image_ref:
        raise BackupError("target PostgreSQL image is not pinned")
    restored_compose = target_directory / "compose" / "compose.yaml"
    if not restored_compose.is_file() or image_ref.encode() not in restored_compose.read_bytes():
        raise BackupError("target PostgreSQL does not use the restored Compose image")
    network_settings = db.get("NetworkSettings")
    networks = network_settings.get("Networks") if isinstance(network_settings, dict) else None
    if not isinstance(networks, dict) or not networks:
        raise BackupError("target PostgreSQL network is unavailable")
    for network_name in networks:
        details = _json_output(
            _run(
                command_runner,
                ["docker", "network", "inspect", network_name],
                "target network admission",
            ),
            "target network admission",
        )
        if (
            not isinstance(details, list)
            or len(details) != 1
            or not isinstance(details[0], dict)
            or details[0].get("Internal") is not True
        ):
            raise BackupError("target PostgreSQL is attached to a non-internal network")
    volumes = _docker_inventory(command_runner, "volume", target_project)
    if {item.get("Name") for item in volumes} != set(expected_volumes):
        raise BackupError("target durable volumes changed before finalization")
    for item in volumes:
        labels = _labels(item, container=False)
        if (
            labels.get("com.docker.compose.project") != target_project
            or f"{target_project}_{labels.get('com.docker.compose.volume')}" != item.get("Name")
        ):
            raise BackupError("target durable volume ownership is invalid")
    container_id = db.get("Id")
    if not isinstance(container_id, str) or not container_id:
        raise BackupError("target PostgreSQL container identity is unavailable")
    psql = [
        "docker",
        "exec",
        "--user",
        "postgres",
        container_id,
        "psql",
        "-X",
        "-q",
        "-t",
        "-A",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "supabase_admin",
        "-d",
        "postgres",
        "-c",
    ]
    identity = _json_output(
        _run(command_runner, [*psql, _TARGET_IDENTITY_SQL], "target database identity admission"),
        "target database identity admission",
    )
    if identity != {
        "database": "postgres",
        "user": "supabase_admin",
        "cluster_name": target_instance_id,
    }:
        raise BackupError(
            "target PostgreSQL cluster identity does not match the requested instance"
        )
    _run(command_runner, [*psql, _FINALIZE_SQL], "application session invalidation")
    postcondition = _run(
        command_runner, [*psql, _SESSION_POSTCONDITION_SQL], "application session postcondition"
    ).strip()
    if postcondition != b"t":
        raise BackupError("application session postcondition was not verified")
    _atomic_json(
        target_directory / "restore-finalized.json",
        {
            "format_version": 3,
            "snapshot_id": snapshot_id,
            "source_installation_id": config.installation_id,
            "target_project": target_project,
            "target_instance_id": target_instance_id,
            "target_db_container_id": container_id,
            "completed_at": datetime.now(UTC).isoformat(),
            "application_sessions_invalidated": True,
        },
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--target-project", required=True)
    parser.add_argument("--target-instance-id", required=True)
    parser.add_argument("--target-directory", required=True, type=Path)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--execute", action="store_true")
    action.add_argument("--finalize", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args(argv)
    try:
        if args.finalize:
            run_finalize(
                args.config,
                args.snapshot,
                args.target_project,
                args.target_directory,
                args.target_instance_id,
            )
            print(
                "Restore finalization complete; ingress remains closed until operator "
                "rebind and admission."
            )
        else:
            result = run_restore(
                args.config,
                args.snapshot,
                args.target_project,
                args.target_directory,
                args.target_instance_id,
                execute=args.execute,
                confirmation=args.confirm,
            )
            if result.executed:
                print("Restore staged offline; application sessions still require finalization.")
            else:
                print("Restore inspection passed; no target data was changed.")
                confirmation = confirmation_text(
                    args.config,
                    args.snapshot,
                    args.target_project,
                    args.target_directory,
                    args.target_instance_id,
                )
                print(f"To execute, provide --execute --confirm '{confirmation}'")
    except (BackupError, OSError) as error:
        detail = (
            error if isinstance(error, BackupError) else "protected filesystem operation failed"
        )
        print(
            f"Restore failed: {detail}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
