"""Inspect or restore an encrypted v2 installation snapshot to a fresh target.

This is a support-operated, stopped-service command, not a live application API.
The backed-up database and private-file roots are restored as one recovery set.
Until native restore certification, only POSIX-origin snapshot paths are accepted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from .backup_installation import (
    BackupConfig,
    BackupError,
    DirectoryGuard,
    MaintenanceLease,
    _assert_no_symlink,
    _assert_safe_directory,
    _CommandRunner,
    _is_within,
    _minimal_environment,
    _pg_environment,
    _restic_environment,
    _run_with_lease,
    _sha256,
    _subprocess_runner,
    _tree_hash,
    _validate_runtime_paths,
    _write_pgpass,
    parse_config,
)

_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SNAPSHOT = re.compile(r"^[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9A-Za-z_.-]{1,128}$")
_ROOT_ID = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

_FRESH_TARGET_SQL = """SELECT pg_catalog.json_build_object(
  'database', pg_catalog.current_database(),
  'username', current_user,
  'other_connections', (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity
    WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid()
  ),
  'user_objects', (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE pg_catalog.left(n.nspname::pg_catalog.text, 3) <> 'pg_'
      AND n.nspname <> 'information_schema'
  ),
  'user_schemas', (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema')
      AND pg_catalog.left(nspname::pg_catalog.text, 3) <> 'pg_'
  ),
  'user_routines', (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ),
  'user_extensions', (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
  ),
  'other_public_objects', (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_depend AS d
    WHERE d.refclassid = 'pg_catalog.pg_namespace'::pg_catalog.regclass
      AND d.refobjid = 'public'::pg_catalog.regnamespace
  ),
  'database_objects', (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_event_trigger)
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_publication)
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_subscription
       WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database
                        WHERE datname = pg_catalog.current_database()))
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_foreign_data_wrapper)
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_foreign_server)
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_default_acl)
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_largeobject_metadata)
    + (SELECT pg_catalog.count(*) FROM pg_catalog.pg_transform)
  )
)::pg_catalog.text"""


@dataclass(frozen=True)
class RestoreResult:
    snapshot_id: str
    source_installation_id: str
    schema_revision: str
    executed: bool


@dataclass(frozen=True)
class _Root:
    root_id: str
    source_path: str
    tree_sha256: str
    file_count: int
    total_bytes: int
    target: Path


@dataclass(frozen=True)
class _Manifest:
    schema_revision: str
    dump_sha256: str
    dump_bytes: int
    roots: tuple[_Root, ...]


def confirmation_text(config: BackupConfig, snapshot_id: str) -> str:
    """Bind execution approval to the exact snapshot and target identity."""

    target = {
        "database": config.database.url,
        "file_roots": list(
            zip(config.private_file_root_ids, map(str, config.private_file_roots), strict=True)
        ),
        "marker": str(config.completion_marker),
    }
    target_digest = hashlib.sha256(
        json.dumps(target, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:16]
    return (
        f"RESTORE {snapshot_id} FOR {config.installation_id} INTO "
        f"{config.database.host}:{config.database.port}/{config.database.database} "
        f"TARGET {target_digest}"
    )


def _snapshot_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.startswith("/") or "\x00" in value:
        raise BackupError(f"{label} must be an absolute POSIX snapshot path")
    path = PurePosixPath(value)
    if value == "/" or ".." in path.parts or "//" in value or path.as_posix() != value:
        raise BackupError(f"{label} is not a safe POSIX snapshot path")
    return value


def _snapshot_inventory(output: str) -> tuple[dict[str, str], str]:
    nodes: dict[str, str] = {}
    for line in output.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as error:
            raise BackupError("restic snapshot inventory is invalid") from error
        if not isinstance(payload, dict):
            raise BackupError("restic snapshot inventory is invalid")
        if payload.get("struct_type") == "snapshot":
            continue
        if payload.get("struct_type") != "node":
            raise BackupError("restic snapshot inventory has an unknown item")
        path = _snapshot_path(payload.get("path"), "snapshot entry")
        kind = payload.get("type")
        if kind not in {"file", "dir"} or path in nodes:
            raise BackupError("restic snapshot contains an unsafe or duplicate entry")
        nodes[path] = kind
    candidates = [
        path
        for path, kind in nodes.items()
        if kind == "file"
        and PurePosixPath(path).name == "manifest.json"
        and nodes.get(str(PurePosixPath(path).with_name("database.dump"))) == "file"
        and PurePosixPath(path).parent.name.startswith("openslate-backup-")
    ]
    if len(candidates) != 1:
        raise BackupError("snapshot must contain exactly one backup manifest and dump pair")
    return nodes, str(PurePosixPath(candidates[0]).parent)


def _positive_count(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise BackupError(f"{label} is invalid")
    return value


def _manifest(
    path: Path, config: BackupConfig, source_id: str, nodes: Mapping[str, str]
) -> _Manifest:
    _assert_no_symlink(path, "restored manifest")
    try:
        if not stat.S_ISREG(path.stat().st_mode):
            raise BackupError("restored manifest must be a regular file")
        if path.stat().st_size > 1024 * 1024:
            raise BackupError("restored manifest is too large")
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackupError("restored manifest cannot be read") from error
    if not isinstance(raw, dict) or set(raw) != {
        "format_version",
        "installation_id",
        "created_at",
        "schema_revision",
        "database",
        "dump",
        "private_file_roots",
    }:
        raise BackupError("restore requires a complete version-2 manifest")
    if raw["format_version"] != 2 or isinstance(raw["format_version"], bool):
        raise BackupError("restore requires a version-2 manifest; version 1 is unsupported")
    if raw["installation_id"] != source_id or source_id != config.installation_id:
        raise BackupError("source installation identity does not match target configuration")
    revision = raw["schema_revision"]
    if not isinstance(revision, str) or not _REVISION.fullmatch(revision):
        raise BackupError("manifest schema revision is invalid")
    if not isinstance(raw["created_at"], str):
        raise BackupError("manifest creation time is invalid")
    try:
        created_at = datetime.fromisoformat(raw["created_at"].replace("Z", "+00:00"))
    except ValueError as error:
        raise BackupError("manifest creation time is invalid") from error
    if created_at.tzinfo is None:
        raise BackupError("manifest creation time must include a timezone")
    database = raw["database"]
    if (
        not isinstance(database, dict)
        or set(database)
        != {
            "host",
            "port",
            "database",
            "username",
        }
        or not all(
            isinstance(database[key], str) and database[key]
            for key in (
                "host",
                "database",
                "username",
            )
        )
        or not isinstance(database["port"], int)
        or isinstance(database["port"], bool)
    ):
        raise BackupError("manifest database metadata is invalid")
    dump = raw["dump"]
    if not isinstance(dump, dict) or set(dump) != {"format", "sha256", "bytes"}:
        raise BackupError("manifest dump metadata is invalid")
    if (
        dump["format"] != "pg_dump_custom"
        or not isinstance(dump["sha256"], str)
        or not _HEX_SHA256.fullmatch(dump["sha256"])
    ):
        raise BackupError("manifest dump metadata is invalid")
    dump_bytes = _positive_count(dump["bytes"], "manifest dump length")
    if dump_bytes == 0:
        raise BackupError("manifest dump cannot be empty")
    inventories = raw["private_file_roots"]
    if not isinstance(inventories, list) or len(inventories) != len(config.private_file_roots):
        raise BackupError("manifest must include every configured logical file root")
    targets = dict(zip(config.private_file_root_ids, config.private_file_roots, strict=True))
    roots: list[_Root] = []
    seen_paths: set[str] = set()
    for inventory in inventories:
        if not isinstance(inventory, dict) or set(inventory) != {
            "root_id",
            "source_path",
            "path_flavor",
            "tree_sha256",
            "file_count",
            "total_bytes",
        }:
            raise BackupError("manifest logical file root is invalid")
        root_id = inventory["root_id"]
        if (
            not isinstance(root_id, str)
            or not _ROOT_ID.fullmatch(root_id)
            or root_id not in targets
        ):
            raise BackupError("manifest logical file root is unknown")
        if inventory["path_flavor"] != "posix" or os.name == "nt":
            raise BackupError("source path flavor is not supported on this host")
        source_path = _snapshot_path(inventory["source_path"], "source file root")
        if source_path in seen_paths or nodes.get(source_path) != "dir":
            raise BackupError("source file root is duplicate or missing from snapshot")
        seen_paths.add(source_path)
        tree_sha256 = inventory["tree_sha256"]
        if not isinstance(tree_sha256, str) or not _HEX_SHA256.fullmatch(tree_sha256):
            raise BackupError("manifest file tree hash is invalid")
        roots.append(
            _Root(
                root_id=root_id,
                source_path=source_path,
                tree_sha256=tree_sha256,
                file_count=_positive_count(inventory["file_count"], "manifest file count"),
                total_bytes=_positive_count(inventory["total_bytes"], "manifest file bytes"),
                target=targets.pop(root_id),
            )
        )
    if targets:
        raise BackupError("manifest is missing a configured logical file root")
    return _Manifest(revision, dump["sha256"], dump_bytes, tuple(roots))


def _fresh_targets(config: BackupConfig, roots: tuple[Path, ...]) -> None:
    for index, root in enumerate(roots):
        _assert_safe_directory(root, "restore file target")
        if any(
            root == other or _is_within(root, other) or _is_within(other, root)
            for other in roots[:index]
        ):
            raise BackupError("restore file targets cannot overlap")
        try:
            if any(root.iterdir()):
                raise BackupError("restore file target is not empty")
        except OSError as error:
            raise BackupError("restore file target cannot be inspected") from error
    if config.version != 2:
        raise BackupError("restore requires a version-2 configuration")


def _target_preflight(
    lease: MaintenanceLease,
    runner: _CommandRunner,
    config: BackupConfig,
    pgpass: Path,
    guards: Sequence[DirectoryGuard],
) -> None:
    result = _run_with_lease(
        lease,
        runner,
        [
            "psql",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--dbname",
            config.database.url,
            "--command",
            _FRESH_TARGET_SQL,
        ],
        env=_pg_environment(pgpass),
        label="fresh target inspection",
        guards=guards,
    )
    try:
        raw = json.loads(result.stdout.strip())
    except json.JSONDecodeError as error:
        raise BackupError("fresh target inspection returned invalid data") from error
    if (
        not isinstance(raw, dict)
        or set(raw)
        != {
            "database",
            "username",
            "other_connections",
            "user_objects",
            "user_schemas",
            "user_routines",
            "user_extensions",
            "other_public_objects",
            "database_objects",
        }
        or raw["database"] != config.database.database
        or raw["username"] != config.database.username
    ):
        raise BackupError("connected database target differs from confirmed configuration")
    if (
        not isinstance(raw["other_connections"], int)
        or isinstance(raw["other_connections"], bool)
        or raw["other_connections"] != 0
    ):
        raise BackupError("database target is active or its activity cannot be proven absent")
    for key in (
        "user_objects",
        "user_schemas",
        "user_routines",
        "user_extensions",
        "other_public_objects",
        "database_objects",
    ):
        if not isinstance(raw[key], int) or isinstance(raw[key], bool) or raw[key] != 0:
            raise BackupError("database target is not empty")


def _post_restore_revision(
    lease: MaintenanceLease,
    runner: _CommandRunner,
    config: BackupConfig,
    pgpass: Path,
    guards: Sequence[DirectoryGuard],
    expected: str,
) -> None:
    result = _run_with_lease(
        lease,
        runner,
        [
            "psql",
            "--no-psqlrc",
            "--set",
            "ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--dbname",
            config.database.url,
            "--command",
            "SELECT version_num FROM alembic_version",
        ],
        env=_pg_environment(pgpass),
        label="restored schema revision inspection",
        guards=guards,
    )
    if result.stdout.strip() != expected:
        raise BackupError("restored schema revision does not match manifest")


def _promote_root(source: Path, target: Path, expected: _Root) -> None:
    """Copy to an adjacent private directory, verify, then replace an empty root."""

    parent = _assert_safe_directory(target.parent, "restore file target parent")
    temporary = Path(tempfile.mkdtemp(prefix=".openslate-restore-", dir=parent))
    temporary.chmod(0o700)
    try:
        shutil.copytree(source, temporary, dirs_exist_ok=True, symlinks=True)
        if _tree_hash(temporary) != (
            expected.tree_sha256,
            expected.file_count,
            expected.total_bytes,
        ):
            raise BackupError("copied private file tree failed verification")
        _assert_safe_directory(target, "restore file target")
        if any(target.iterdir()):
            raise BackupError("restore file target became nonempty")
        target.rmdir()
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def _success_marker(path: Path, result: RestoreResult) -> None:
    payload = (
        json.dumps(
            {
                "format_version": 1,
                "snapshot_id": result.snapshot_id,
                "source_installation_id": result.source_installation_id,
                "schema_revision": result.schema_revision,
                "restore_completed": True,
                "completed_at": datetime.now(UTC).isoformat(),
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )
    descriptor, raw = tempfile.mkstemp(prefix=".restore-marker-", dir=path.parent)
    temporary = Path(raw)
    try:
        os.fchmod(descriptor, 0o600)
        os.write(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.link(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def run_restore(
    config_path: Path,
    snapshot_id: str,
    source_installation_id: str,
    *,
    execute: bool = False,
    confirmation: str | None = None,
    command_runner: _CommandRunner = _subprocess_runner,
) -> RestoreResult:
    """Inspect a specific snapshot, or restore it to an empty stopped target."""

    config = parse_config(config_path)
    if not _SNAPSHOT.fullmatch(snapshot_id):
        raise BackupError("snapshot ID must be a full 64-character hexadecimal Restic identifier")
    if source_installation_id != config.installation_id:
        raise BackupError("source installation ID does not match target configuration")
    if execute and confirmation != confirmation_text(config, snapshot_id):
        raise BackupError("exact restore confirmation is required")
    staging, roots, repository = _validate_runtime_paths(config, config_path)
    _fresh_targets(config, roots)
    lease = MaintenanceLease.acquire(config, lambda: datetime.now(UTC))
    guards: list[DirectoryGuard] = []
    run_directory: Path | None = None
    try:
        for path, name in (
            (staging, "staging_directory"),
            (repository, "restic_repository"),
            (config.completion_marker.parent, "completion_marker parent"),
            *((root, f"private file target {index}") for index, root in enumerate(roots)),
        ):
            guards.append(DirectoryGuard.acquire(path, name))
        run_directory = Path(tempfile.mkdtemp(prefix="openslate-restore-", dir=staging))
        run_directory.chmod(0o700)
        pgpass = _write_pgpass(config, run_directory)
        cache_dir = run_directory / "restic-cache"
        cache_dir.mkdir(mode=0o700)
        restic_env = _restic_environment(config, cache_dir)
        inventory = _run_with_lease(
            lease,
            command_runner,
            ["restic", "ls", "--json", snapshot_id],
            env=restic_env,
            label="restic snapshot inventory",
            guards=guards,
        )
        nodes, artifact_parent = _snapshot_inventory(inventory.stdout)
        artifacts = run_directory / "artifacts"
        artifacts.mkdir(mode=0o700)
        _run_with_lease(
            lease,
            command_runner,
            [
                "restic",
                "restore",
                f"{snapshot_id}:{artifact_parent}",
                "--target",
                str(artifacts),
                "--include",
                "/manifest.json",
                "--include",
                "/database.dump",
            ],
            env=restic_env,
            label="restic artifact restore",
            guards=guards,
        )
        manifest_path = artifacts / "manifest.json"
        dump_path = artifacts / "database.dump"
        manifest = _manifest(manifest_path, config, source_installation_id, nodes)
        _assert_no_symlink(dump_path, "restored database dump")
        if (
            not dump_path.is_file()
            or dump_path.stat().st_size != manifest.dump_bytes
            or _sha256(dump_path) != manifest.dump_sha256
        ):
            raise BackupError("restored database dump failed hash or length verification")
        _run_with_lease(
            lease,
            command_runner,
            ["pg_restore", "--list", str(dump_path)],
            env=_minimal_environment(),
            label="pg_restore archive validation",
            guards=guards,
        )
        staged_roots: list[tuple[_Root, Path]] = []
        for root in manifest.roots:
            restored_root = run_directory / "roots" / root.root_id
            restored_root.mkdir(mode=0o700, parents=True)
            _run_with_lease(
                lease,
                command_runner,
                [
                    "restic",
                    "restore",
                    f"{snapshot_id}:{root.source_path}",
                    "--target",
                    str(restored_root),
                ],
                env=restic_env,
                label="restic private file restore",
                guards=guards,
            )
            if _tree_hash(restored_root) != (
                root.tree_sha256,
                root.file_count,
                root.total_bytes,
            ):
                raise BackupError("restored private file tree failed hash or count verification")
            staged_roots.append((root, restored_root))
        _target_preflight(lease, command_runner, config, pgpass, guards)
        result = RestoreResult(
            snapshot_id, source_installation_id, manifest.schema_revision, execute
        )
        if execute:
            _fresh_targets(config, roots)
            _target_preflight(lease, command_runner, config, pgpass, guards)
            _run_with_lease(
                lease,
                command_runner,
                [
                    "pg_restore",
                    "--exit-on-error",
                    "--single-transaction",
                    "--no-owner",
                    "--no-privileges",
                    "--dbname",
                    config.database.url,
                    str(dump_path),
                ],
                env=_pg_environment(pgpass),
                label="pg_restore",
                guards=guards,
            )
            _post_restore_revision(
                lease,
                command_runner,
                config,
                pgpass,
                guards,
                manifest.schema_revision,
            )
            for root, restored_root in staged_roots:
                lease.revalidate()
                _promote_root(restored_root, root.target, root)
            lease.revalidate()
            shutil.rmtree(run_directory)
            run_directory = None
            lease.revalidate()
            if config.completion_marker.exists():
                raise BackupError("restore completion marker already exists")
            _success_marker(config.completion_marker, result)
        return result
    finally:
        try:
            if run_directory is not None and run_directory.exists():
                shutil.rmtree(run_directory)
        finally:
            for guard in reversed(guards):
                guard.close()
            lease.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--source-installation-id", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm")
    args = parser.parse_args(argv)
    try:
        result = run_restore(
            args.config,
            args.snapshot,
            args.source_installation_id,
            execute=args.execute,
            confirmation=args.confirm,
        )
    except BackupError as error:
        print(f"Restore failed: {error}", file=sys.stderr)
        return 1
    except OSError:
        print("Restore failed: a protected filesystem operation failed", file=sys.stderr)
        return 1
    if result.executed:
        print(f"Restore complete: snapshot {result.snapshot_id}")
    else:
        print("Restore inspection passed; no target data was changed.")
        confirmation = confirmation_text(parse_config(args.config), args.snapshot)
        print(f"To execute, provide --execute --confirm '{confirmation}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
