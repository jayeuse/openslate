"""Contract tests for the guarded, support-operated restore path."""

from __future__ import annotations

import hashlib
import importlib
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backup.backup_installation import _tree_hash

SNAPSHOT = "a" * 64
INSTALLATION = "b" * 32


def _private_file(path: Path, contents: str) -> Path:
    path.write_text(contents, encoding="utf-8")
    path.chmod(0o600)
    return path


def _fixture(tmp_path: Path) -> tuple[Path, dict[str, Any], dict[str, bytes]]:
    source = tmp_path / "openslate-backup-source"
    source.mkdir()
    source_root = tmp_path / "source-files"
    source_root.mkdir()
    (source_root / "object.txt").write_text("restored object", encoding="utf-8")
    tree_sha256, file_count, total_bytes = _tree_hash(source_root)
    source_dump = source / "database.dump"
    source_dump.write_bytes(b"custom-format-test-dump")
    source_manifest = source / "manifest.json"
    source_manifest.write_text(
        json.dumps(
            {
                "format_version": 2,
                "installation_id": INSTALLATION,
                "created_at": "2026-09-23T00:00:00Z",
                "schema_revision": "26b841577675",
                "database": {
                    "host": "source.example",
                    "port": 5432,
                    "database": "source_db",
                    "username": "source_owner",
                },
                "dump": {
                    "format": "pg_dump_custom",
                    "sha256": hashlib.sha256(source_dump.read_bytes()).hexdigest(),
                    "bytes": source_dump.stat().st_size,
                },
                "private_file_roots": [
                    {
                        "root_id": "workspace_files",
                        "source_path": str(source_root),
                        "path_flavor": "posix",
                        "tree_sha256": tree_sha256,
                        "file_count": file_count,
                        "total_bytes": total_bytes,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    target_root = tmp_path / "restored-files"
    target_root.mkdir()
    for name in ("stage", "repo"):
        (tmp_path / name).mkdir()
    state = _private_file(
        tmp_path / "state.json",
        json.dumps(
            {
                "installation_id": INSTALLATION,
                "maintenance": True,
                "fastapi": "stopped",
                "scanner": "stopped",
                "issued_at": datetime.now(UTC).isoformat(),
            }
        ),
    )
    lock = _private_file(tmp_path / "maintenance.lock", INSTALLATION + "\n")
    config: dict[str, Any] = {
        "version": 2,
        "installation_id": INSTALLATION,
        "database_url": "postgresql://restore_owner@localhost:5432/fresh_restore_db",
        "pg_password_file": str(_private_file(tmp_path / "pg-password", "pg secret")),
        "restic_repository": str(tmp_path / "repo"),
        "restic_password_file": str(_private_file(tmp_path / "restic-password", "restic secret")),
        "staging_directory": str(tmp_path / "stage"),
        "completion_marker": str(tmp_path / "restore-marker.json"),
        "maintenance_state_file": str(state),
        "maintenance_lock_file": str(lock),
        "maintenance_max_age_seconds": 300,
        "private_file_roots": [{"id": "workspace_files", "path": str(target_root)}],
        "initialize_repository": False,
    }
    config_path = _private_file(tmp_path / "restore.json", json.dumps(config))
    snapshot = {
        str(source_manifest): source_manifest.read_bytes(),
        str(source_dump): source_dump.read_bytes(),
        str(source_root / "object.txt"): (source_root / "object.txt").read_bytes(),
    }
    return config_path, config, snapshot


class FakeCommands:
    def __init__(
        self,
        snapshot: dict[str, bytes],
        *,
        connections: int = 0,
        objects: int = 0,
        routines: int = 0,
        extensions: int = 0,
        fail_restore: bool = False,
    ) -> None:
        self.snapshot = snapshot
        self.connections = connections
        self.objects = objects
        self.routines = routines
        self.extensions = extensions
        self.fail_restore = fail_restore
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.revision = "26b841577675"

    def __call__(self, args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        self.calls.append((args, env))
        if args[:3] == ["restic", "ls", "--json"]:
            rows = [
                json.dumps({"struct_type": "node", "type": "file", "path": path})
                for path in self.snapshot
            ]
            source_root = next(
                Path(path).parent for path in self.snapshot if path.endswith("object.txt")
            )
            rows.append(
                json.dumps({"struct_type": "node", "type": "dir", "path": str(source_root)})
            )
            return subprocess.CompletedProcess(args, 0, "\n".join(rows), "")
        if args[:2] == ["restic", "restore"]:
            source = args[2].split(":", 1)[1]
            target = Path(args[args.index("--target") + 1])
            includes = [args[index + 1] for index, arg in enumerate(args) if arg == "--include"]
            for path, contents in self.snapshot.items():
                relative = (
                    Path(path).relative_to(source) if Path(path).is_relative_to(source) else None
                )
                if relative is None or (includes and "/" + relative.as_posix() not in includes):
                    continue
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(contents)
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[0] == "psql":
            if "pg_stat_activity" in args[-1]:
                payload = {
                    "database": "fresh_restore_db",
                    "username": "restore_owner",
                    "other_connections": self.connections,
                    "user_objects": self.objects,
                    "user_schemas": 0,
                }
                if "user_routines" in args[-1]:
                    payload.update(
                        {
                            "user_routines": self.routines,
                            "user_extensions": self.extensions,
                            "other_public_objects": 0,
                            "database_objects": 0,
                        }
                    )
                return subprocess.CompletedProcess(
                    args,
                    0,
                    json.dumps(payload) + "\n",
                    "",
                )
            return subprocess.CompletedProcess(args, 0, self.revision + "\n", "")
        if args[0] == "pg_restore" and "--dbname" in args and self.fail_restore:
            return subprocess.CompletedProcess(args, 1, "", "failed")
        return subprocess.CompletedProcess(args, 0, "", "")


def test_restore_inspects_snapshot_without_writing_target(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    commands = FakeCommands(snapshot)
    restore = importlib.import_module("backup.restore_installation")

    result = restore.run_restore(config_path, SNAPSHOT, INSTALLATION, command_runner=commands)

    assert result.executed is False
    assert result.schema_revision == "26b841577675"
    assert not any(args[0] == "pg_restore" and "--dbname" in args for args, _ in commands.calls)
    assert not Path(config["completion_marker"]).exists()
    assert not list(Path(config["private_file_roots"][0]["path"]).iterdir())
    assert not list(Path(config["staging_directory"]).iterdir())


def test_restore_requires_exact_confirmation_and_restores_only_fresh_target(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    commands = FakeCommands(snapshot)
    restore = importlib.import_module("backup.restore_installation")

    with pytest.raises(restore.BackupError, match="confirmation"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation="wrong",
            command_runner=commands,
        )
    assert not any(args[0] == "pg_restore" and "--dbname" in args for args, _ in commands.calls)
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    result = restore.run_restore(
        config_path,
        SNAPSHOT,
        INSTALLATION,
        execute=True,
        confirmation=confirmation,
        command_runner=commands,
    )

    assert result.executed is True
    assert (
        Path(config["private_file_roots"][0]["path"]) / "object.txt"
    ).read_text() == "restored object"
    marker = json.loads(Path(config["completion_marker"]).read_text())
    assert marker["restore_completed"] is True
    pg_restore = next(
        args for args, _ in commands.calls if args[0] == "pg_restore" and "--dbname" in args
    )
    assert {"--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges"} <= set(
        pg_restore
    )
    assert "--clean" not in pg_restore and "--create" not in pg_restore
    assert all("pg secret" not in str(args) for args, _ in commands.calls)


@pytest.mark.parametrize("connections", [1, 2])
def test_restore_rejects_active_target_before_pg_restore(tmp_path: Path, connections: int) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    commands = FakeCommands(snapshot, connections=connections)
    restore = importlib.import_module("backup.restore_installation")
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)

    with pytest.raises(restore.BackupError, match="active"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=confirmation,
            command_runner=commands,
        )

    assert not any(args[0] == "pg_restore" and "--dbname" in args for args, _ in commands.calls)
    assert not Path(config["completion_marker"]).exists()


def test_restore_rejects_wrong_installation_and_windows_origin(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    commands = FakeCommands(snapshot)
    restore = importlib.import_module("backup.restore_installation")
    manifest_path = next(path for path in snapshot if path.endswith("manifest.json"))
    manifest = json.loads(snapshot[manifest_path])
    manifest["private_file_roots"][0]["path_flavor"] = "windows"
    manifest["private_file_roots"][0]["source_path"] = "C:\\OpenSlate\\private-files"
    snapshot[manifest_path] = json.dumps(manifest).encode()

    with pytest.raises(restore.BackupError, match="path flavor"):
        restore.run_restore(config_path, SNAPSHOT, INSTALLATION, command_runner=commands)

    manifest["private_file_roots"][0]["path_flavor"] = "posix"
    manifest["private_file_roots"][0]["source_path"] = str(tmp_path / "source-files")
    snapshot[manifest_path] = json.dumps(manifest).encode()
    with pytest.raises(restore.BackupError, match="installation"):
        restore.run_restore(config_path, SNAPSHOT, "c" * 32, command_runner=commands)
    assert not Path(config["completion_marker"]).exists()


def test_restore_rejects_v1_manifest_and_unmapped_file_root(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    manifest_path = next(path for path in snapshot if path.endswith("manifest.json"))
    manifest = json.loads(snapshot[manifest_path])
    manifest["format_version"] = 1
    snapshot[manifest_path] = json.dumps(manifest).encode()

    with pytest.raises(restore.BackupError, match="version-2"):
        restore.run_restore(
            config_path, SNAPSHOT, INSTALLATION, command_runner=FakeCommands(snapshot)
        )

    manifest["format_version"] = 2
    manifest["private_file_roots"][0]["root_id"] = "unknown_root"
    snapshot[manifest_path] = json.dumps(manifest).encode()
    with pytest.raises(restore.BackupError, match="unknown"):
        restore.run_restore(
            config_path, SNAPSHOT, INSTALLATION, command_runner=FakeCommands(snapshot)
        )
    assert not Path(config["completion_marker"]).exists()


def test_restore_rejects_target_path_overlap_before_commands(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    config["private_file_roots"][0]["path"] = config["staging_directory"]
    config_path.write_text(json.dumps(config))
    commands = FakeCommands(snapshot)

    with pytest.raises(restore.BackupError, match="overlap"):
        restore.run_restore(config_path, SNAPSHOT, INSTALLATION, command_runner=commands)
    assert commands.calls == []


def test_restore_requires_full_snapshot_identifier_before_commands(tmp_path: Path) -> None:
    config_path, _, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    commands = FakeCommands(snapshot)

    with pytest.raises(restore.BackupError, match="full 64-character"):
        restore.run_restore(config_path, SNAPSHOT[:8], INSTALLATION, command_runner=commands)
    assert commands.calls == []


def test_confirmation_changes_when_logical_file_target_changes(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    first = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    alternate = tmp_path / "alternate-files"
    alternate.mkdir()
    config["private_file_roots"][0]["path"] = str(alternate)
    config_path.write_text(json.dumps(config))
    second = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    assert first != second

    commands = FakeCommands(snapshot)
    with pytest.raises(restore.BackupError, match="confirmation"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=first,
            command_runner=commands,
        )
    assert commands.calls == []


def test_restore_rejects_corrupt_dump_before_target_write(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    dump_path = next(path for path in snapshot if path.endswith("database.dump"))
    snapshot[dump_path] = b"corrupt"
    commands = FakeCommands(snapshot)
    restore = importlib.import_module("backup.restore_installation")
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)

    with pytest.raises(restore.BackupError, match="dump"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=confirmation,
            command_runner=commands,
        )

    assert not any(args[0] == "pg_restore" and "--dbname" in args for args, _ in commands.calls)
    assert not Path(config["completion_marker"]).exists()


def test_restore_rejects_nonempty_database_and_file_target(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    commands = FakeCommands(snapshot, objects=1)

    with pytest.raises(restore.BackupError, match="not empty"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=confirmation,
            command_runner=commands,
        )
    assert not any(args[0] == "pg_restore" and "--dbname" in args for args, _ in commands.calls)
    (Path(config["private_file_roots"][0]["path"]) / "existing").write_bytes(b"existing")
    with pytest.raises(restore.BackupError, match="not empty"):
        restore.run_restore(
            config_path, SNAPSHOT, INSTALLATION, command_runner=FakeCommands(snapshot)
        )
    assert not Path(config["completion_marker"]).exists()


@pytest.mark.parametrize(
    ("routines", "extensions"),
    [(1, 0), (0, 1)],
    ids=["public_function", "installed_extension"],
)
def test_restore_rejects_public_routine_or_extension_on_target(
    tmp_path: Path,
    routines: int,
    extensions: int,
) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    commands = FakeCommands(snapshot, routines=routines, extensions=extensions)

    with pytest.raises(restore.BackupError, match="not empty"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=confirmation,
            command_runner=commands,
        )

    preflight_sql = next(
        args[-1]
        for args, _ in commands.calls
        if args[0] == "psql" and "pg_stat_activity" in args[-1]
    )
    assert "pg_catalog.pg_proc" in preflight_sql
    assert "pg_catalog.pg_extension" in preflight_sql
    assert not any(args[0] == "pg_restore" and "--dbname" in args for args, _ in commands.calls)
    assert not Path(config["completion_marker"]).exists()


def test_restore_rejects_v1_and_failed_pg_restore_without_marker(tmp_path: Path) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    config["version"] = 1
    config["private_file_roots"] = [config["private_file_roots"][0]["path"]]
    config_path.write_text(json.dumps(config))
    with pytest.raises(restore.BackupError, match="version-2"):
        restore.run_restore(
            config_path, SNAPSHOT, INSTALLATION, command_runner=FakeCommands(snapshot)
        )
    config["version"] = 2
    config["private_file_roots"] = [
        {"id": "workspace_files", "path": config["private_file_roots"][0]}
    ]
    config_path.write_text(json.dumps(config))
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    commands = FakeCommands(snapshot, fail_restore=True)

    with pytest.raises(restore.BackupError, match="pg_restore failed"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=confirmation,
            command_runner=commands,
        )
    assert not Path(config["completion_marker"]).exists()
    assert not list(Path(config["private_file_roots"][0]["path"]).iterdir())


def test_restore_never_marks_success_if_sensitive_staging_cleanup_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path, config, snapshot = _fixture(tmp_path)
    restore = importlib.import_module("backup.restore_installation")
    confirmation = restore.confirmation_text(restore.parse_config(config_path), SNAPSHOT)
    actual_rmtree = restore.shutil.rmtree

    def failed_cleanup(path: Path, *args: Any, **kwargs: Any) -> None:
        if path.name.startswith("openslate-restore-"):
            raise OSError("staging cleanup failed")
        actual_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(restore.shutil, "rmtree", failed_cleanup)
    with pytest.raises((restore.BackupError, OSError), match="cleanup"):
        restore.run_restore(
            config_path,
            SNAPSHOT,
            INSTALLATION,
            execute=True,
            confirmation=confirmation,
            command_runner=FakeCommands(snapshot),
        )
    assert not Path(config["completion_marker"]).exists()
