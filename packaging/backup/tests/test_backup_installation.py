"""Focused contract tests for the standalone encrypted backup operation."""

from __future__ import annotations

import importlib
import json
import os
import stat
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

try:
    from backup.backup_installation import BackupConfig, BackupError, main, parse_config, run_backup
except ImportError as error:  # Red phase: the operation must be importable as a standalone package.
    pytest.fail(f"backup operation is unavailable: {error}", pytrace=False)


class FakeCommands:
    """A command boundary that creates only the artifacts the operation consumes."""

    def __init__(self, *, fail_at: str | None = None) -> None:
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.fail_at = fail_at

    def __call__(self, args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        self.calls.append((args, env))
        executable = Path(args[0]).name
        if executable == "psql":
            return subprocess.CompletedProcess(args, 0, "1ae6c84fce12\n", "")
        if executable == "pg_dump":
            dump = Path(args[args.index("--file") + 1])
            dump.write_bytes(b"custom dump bytes")
        if executable == "restic" and "restore" in args:
            target = Path(args[args.index("--target") + 1])
            includes = (value for index, value in enumerate(args) if args[index - 1] == "--include")
            for include in includes:
                source = Path(include)
                destination = target / source.relative_to(source.anchor)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
        if executable == self.fail_at or (self.fail_at == "restic-check" and "check" in args):
            return subprocess.CompletedProcess(args, 1, "", "failed")
        stdout = json.dumps({"message_type": "summary", "snapshot_id": "a" + "f" * 63})
        return subprocess.CompletedProcess(args, 0, stdout if "backup" in args else "", "")


def _write_private(path: Path, value: str = "secret") -> Path:
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)
    return path


def _config(tmp_path: Path, **overrides: Any) -> tuple[Path, dict[str, Any]]:
    tmp_path.mkdir(mode=0o700, parents=True, exist_ok=True)
    files = tmp_path / "private-files"
    files.mkdir()
    (files / "object").write_bytes(b"private bytes")
    stage = tmp_path / "staging"
    stage.mkdir()
    repository = tmp_path / "repository"
    repository.mkdir()
    state = tmp_path / "state.json"
    installation_id = "a" * 32
    state.write_text(
        json.dumps(
            {
                "installation_id": installation_id,
                "maintenance": True,
                "fastapi": "stopped",
                "scanner": "stopped",
                "issued_at": datetime.now(UTC).isoformat(),
            }
        ),
        encoding="utf-8",
    )
    state.chmod(0o600)
    lock = _write_private(tmp_path / "maintenance.lock", installation_id + "\n")
    value: dict[str, Any] = {
        "version": 1,
        "installation_id": installation_id,
        "database_url": "postgresql://openslate_owner@localhost:5432/openslate",
        "pg_password_file": str(_write_private(tmp_path / "pg-password", "pg:password")),
        "restic_repository": str(repository),
        "restic_password_file": str(
            _write_private(tmp_path / "restic-password", "restic secret material")
        ),
        "staging_directory": str(stage),
        "completion_marker": str(tmp_path / "marker.json"),
        "maintenance_state_file": str(state),
        "maintenance_lock_file": str(lock),
        "maintenance_max_age_seconds": 300,
        "private_file_roots": [str(files)],
        "initialize_repository": True,
    }
    value.update(overrides)
    path = tmp_path / "backup.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)
    return path, value


def test_backup_uses_password_files_and_writes_marker_only_after_restore_verification(
    tmp_path: Path,
) -> None:
    config_path, config = _config(tmp_path)
    commands = FakeCommands()

    result = run_backup(config_path, command_runner=commands)

    marker = json.loads(Path(config["completion_marker"]).read_text(encoding="utf-8"))
    assert result.snapshot_id == marker["snapshot_id"]
    assert marker["manifest_sha256"] == result.manifest_sha256
    assert all("pg:password" not in " ".join(args) for args, _ in commands.calls)
    assert all("restic secret material" not in " ".join(args) for args, _ in commands.calls)
    pg_dump = next(args for args, _ in commands.calls if Path(args[0]).name == "pg_dump")
    assert "--format=custom" in pg_dump
    assert "--no-owner" in pg_dump and "--no-privileges" in pg_dump
    assert any("check" in args for args, _ in commands.calls)
    assert any("restore" in args for args, _ in commands.calls)
    pg_call = next((args, env) for args, env in commands.calls if Path(args[0]).name == "pg_dump")
    assert "PGPASSFILE" in pg_call[1]
    restic_calls = [(args, env) for args, env in commands.calls if Path(args[0]).name == "restic"]
    assert restic_calls
    assert all("PGPASSFILE" not in env for _, env in restic_calls)
    assert all({"RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE"} <= set(env) for _, env in restic_calls)
    restore_call = next((args, env) for args, env in commands.calls if "pg_restore" in args[0])
    assert "PGPASSFILE" not in restore_call[1]
    assert marker["backup_verified"] is True
    assert "full" not in marker["verification_scope"]
    assert not list(Path(config["staging_directory"]).glob("openslate-backup-*"))


def test_backup_gives_restic_a_private_cache_without_inheriting_home(tmp_path: Path) -> None:
    config_path, config = _config(tmp_path)
    commands = FakeCommands()

    run_backup(config_path, command_runner=commands)

    restic_environments = [env for args, env in commands.calls if Path(args[0]).name == "restic"]
    assert restic_environments
    assert all("HOME" not in env for env in restic_environments)
    assert all("RESTIC_CACHE_DIR" in env for env in restic_environments)
    assert all(
        Path(env["RESTIC_CACHE_DIR"]).is_relative_to(Path(config["staging_directory"]))
        for env in restic_environments
    )


def test_backup_records_the_alembic_revision_read_from_postgresql(tmp_path: Path) -> None:
    config_path, config = _config(tmp_path)
    manifest_payloads: list[dict[str, object]] = []
    fake = FakeCommands()

    def commands(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        if Path(args[0]).name == "restic" and "backup" in args:
            manifest = Path(next(value for value in args if value.endswith("manifest.json")))
            manifest_payloads.append(json.loads(manifest.read_text(encoding="utf-8")))
        return fake(args, env=env)

    run_backup(config_path, command_runner=commands)

    psql, psql_environment = next(
        (args, env) for args, env in fake.calls if Path(args[0]).name == "psql"
    )
    assert "SELECT version_num FROM alembic_version" in psql
    assert "PGPASSFILE" in psql_environment
    assert manifest_payloads[0]["schema_revision"] == "1ae6c84fce12"
    marker = json.loads(Path(config["completion_marker"]).read_text(encoding="utf-8"))
    assert marker["backup_verified"] is True


def test_version_two_backup_records_portable_logical_file_roots(tmp_path: Path) -> None:
    config_path, config = _config(tmp_path)
    source_root = config["private_file_roots"][0]
    config["version"] = 2
    config["private_file_roots"] = [{"id": "workspace_files", "path": source_root}]
    config_path.write_text(json.dumps(config), encoding="utf-8")
    manifest_payloads: list[dict[str, Any]] = []
    fake = FakeCommands()

    def commands(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        if Path(args[0]).name == "restic" and "backup" in args:
            manifest = Path(next(value for value in args if value.endswith("manifest.json")))
            manifest_payloads.append(json.loads(manifest.read_text(encoding="utf-8")))
        return fake(args, env=env)

    run_backup(config_path, command_runner=commands)

    assert manifest_payloads[0]["format_version"] == 2
    assert manifest_payloads[0]["installation_id"] == config["installation_id"]
    assert manifest_payloads[0]["private_file_roots"] == [
        {
            "root_id": "workspace_files",
            "source_path": source_root,
            "path_flavor": "posix",
            "tree_sha256": manifest_payloads[0]["private_file_roots"][0]["tree_sha256"],
            "file_count": 1,
            "total_bytes": len(b"private bytes"),
        }
    ]


@pytest.mark.parametrize(
    ("platform_name", "base_path"),
    [
        ("darwin", "/Library/Application Support/OpenSlate"),
        ("win32", r"C:\ProgramData\OpenSlate"),
    ],
)
def test_version_two_config_keeps_logical_roots_with_native_path_forms(
    tmp_path: Path, platform_name: str, base_path: str
) -> None:
    config_path, config = _config(tmp_path)
    fields = (
        "pg_password_file",
        "restic_repository",
        "restic_password_file",
        "staging_directory",
        "completion_marker",
        "maintenance_state_file",
        "maintenance_lock_file",
    )
    config.update({field: f"{base_path}/{field}" for field in fields})
    config["version"] = 2
    config["private_file_roots"] = [{"id": "workspace_files", "path": f"{base_path}/private/files"}]
    config_path.write_text(json.dumps(config), encoding="utf-8")

    parsed = parse_config(config_path, platform_name=platform_name)

    assert parsed.version == 2
    assert parsed.private_file_root_ids == ("workspace_files",)
    assert tuple(map(str, parsed.private_file_roots)) == (f"{base_path}/private/files",)
    assert parsed.installation_id == config["installation_id"]


@pytest.mark.parametrize(
    "root_ids",
    [
        ["../workspace_files"],
        ["Workspace Files"],
        ["workspace_files", "workspace_files"],
    ],
)
def test_version_two_backup_rejects_unsafe_or_duplicate_root_ids(
    tmp_path: Path, root_ids: list[str]
) -> None:
    config_path, config = _config(tmp_path)
    source_root = config["private_file_roots"][0]
    config["version"] = 2
    config["private_file_roots"] = [{"id": root_id, "path": source_root} for root_id in root_ids]
    config_path.write_text(json.dumps(config), encoding="utf-8")

    with pytest.raises(BackupError, match="private_file_roots"):
        parse_config(config_path)


@pytest.mark.parametrize("revision", ["", "replace-with-current-alembic-revision\n", "one\ntwo\n"])
def test_backup_rejects_missing_or_ambiguous_alembic_revisions(
    tmp_path: Path, revision: str
) -> None:
    config_path, _ = _config(tmp_path)

    def commands(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        if Path(args[0]).name == "psql":
            return subprocess.CompletedProcess(args, 0, revision, "")
        return FakeCommands()(args, env=env)

    with pytest.raises(BackupError, match="Alembic revision"):
        run_backup(config_path, command_runner=commands)


def test_backup_rejects_static_schema_revision_metadata(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    value["schema_revision"] = "attacker-controlled"
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)

    with pytest.raises(BackupError, match="exactly"):
        parse_config(config_path)


@pytest.mark.parametrize("password_key", ["pg_password_file", "restic_password_file"])
def test_backup_rejects_password_files_inside_the_restic_repository(
    tmp_path: Path, password_key: str
) -> None:
    config_path, value = _config(tmp_path)
    password = _write_private(Path(value["restic_repository"]) / f"{password_key}.secret")
    value[password_key] = str(password)
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)

    with pytest.raises(BackupError, match="cannot be inside restic_repository"):
        run_backup(config_path, command_runner=FakeCommands())


def test_backup_keeps_a_valid_maintenance_lease_after_its_acquisition_window(
    tmp_path: Path,
) -> None:
    config_path, value = _config(tmp_path)
    state = json.loads(Path(value["maintenance_state_file"]).read_text(encoding="utf-8"))
    acquired_at = datetime.fromisoformat(state["issued_at"])
    calls = 0

    def clock() -> datetime:
        nonlocal calls
        calls += 1
        return acquired_at if calls == 1 else acquired_at + timedelta(seconds=301)

    result = run_backup(config_path, command_runner=FakeCommands(), now=clock)

    assert result.snapshot_id


def test_backup_rejects_a_schema_revision_change_while_creating_the_dump(tmp_path: Path) -> None:
    config_path, config = _config(tmp_path)
    fake = FakeCommands()
    revisions = iter(["1ae6c84fce12\n", "9e371bea72d3\n"])

    def commands(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        if Path(args[0]).name == "psql":
            return subprocess.CompletedProcess(args, 0, next(revisions), "")
        return fake(args, env=env)

    with pytest.raises(BackupError, match="Alembic revision changed"):
        run_backup(config_path, command_runner=commands)

    assert not Path(config["completion_marker"]).exists()
    assert not any(Path(args[0]).name == "restic" and "backup" in args for args, _ in fake.calls)


def test_backup_reports_maintenance_lock_contention_as_a_controlled_error(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("fcntl locks are unavailable on Windows")
    import fcntl

    config_path, value = _config(tmp_path)
    descriptor = os.open(Path(value["maintenance_lock_file"]), os.O_RDWR)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(BackupError, match="already in progress"):
            run_backup(config_path, command_runner=FakeCommands())
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def test_backup_cli_reports_maintenance_lock_contention_without_a_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    if os.name == "nt":
        pytest.skip("fcntl locks are unavailable on Windows")
    import fcntl

    config_path, value = _config(tmp_path)
    descriptor = os.open(Path(value["maintenance_lock_file"]), os.O_RDWR)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert main(["--config", str(config_path)]) == 1
        assert capsys.readouterr().err == "Backup failed: backup already in progress\n"
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def test_failed_repository_check_removes_staging_and_never_creates_marker(tmp_path: Path) -> None:
    config_path, config = _config(tmp_path)
    commands = FakeCommands(fail_at="restic-check")

    with pytest.raises(BackupError, match="restic check"):
        run_backup(config_path, command_runner=commands)

    assert not Path(config["completion_marker"]).exists()
    assert not list(Path(config["staging_directory"]).glob("openslate-backup-*"))
    pgpass = next(
        env["PGPASSFILE"] for args, env in commands.calls if Path(args[0]).name == "pg_dump"
    )
    assert not Path(pgpass).exists()


def test_missing_backup_binary_fails_without_a_marker_or_staging_artifacts(tmp_path: Path) -> None:
    config_path, config = _config(tmp_path)

    def unavailable(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        if Path(args[0]).name == "psql":
            return FakeCommands()(args, env=env)
        raise FileNotFoundError("pg_dump")

    with pytest.raises(BackupError, match="pg_dump is unavailable"):
        run_backup(config_path, command_runner=unavailable)

    assert not Path(config["completion_marker"]).exists()
    assert not list(Path(config["staging_directory"]).glob("openslate-backup-*"))


def test_cleanup_failure_prevents_marker_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, config = _config(tmp_path)

    def fails_cleanup(_: Path, __: Path | None) -> None:
        raise BackupError("backup staging cleanup failed")

    monkeypatch.setattr("backup.backup_installation._cleanup_run_directory", fails_cleanup)
    with pytest.raises(BackupError, match="cleanup"):
        run_backup(config_path, command_runner=FakeCommands())
    assert not Path(config["completion_marker"]).exists()


def test_marker_is_published_by_atomic_replace_only_after_validation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path, config = _config(tmp_path)
    marker = Path(config["completion_marker"])
    original_replace = os.replace
    calls: list[tuple[Path, Path]] = []

    def checked_replace(source: str | Path, destination: str | Path) -> None:
        source_path, destination_path = Path(source), Path(destination)
        assert source_path.name.startswith(".backup-marker-")
        assert destination_path == marker
        assert not destination_path.exists()
        calls.append((source_path, destination_path))
        original_replace(source, destination)

    monkeypatch.setattr("backup.backup_installation.os.replace", checked_replace)
    run_backup(config_path, command_runner=FakeCommands())

    assert len(calls) == 1
    assert json.loads(marker.read_text(encoding="utf-8"))["format_version"] == 1


def test_config_rejects_password_in_database_url_and_symlinked_private_root(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    value["database_url"] = "postgresql://openslate_owner:leaked@localhost:5432/openslate"
    config_path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(BackupError, match="password"):
        parse_config(config_path)

    symlink_base = tmp_path / "symlink"
    symlink_base.mkdir()
    config_path, value = _config(symlink_base)
    target = tmp_path / "symlink" / "target"
    target.mkdir()
    link = tmp_path / "symlink" / "linked-private"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"symlinks unavailable: {error}")
    value["private_file_roots"] = [str(link)]
    config_path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(BackupError, match="symlink"):
        run_backup(config_path, command_runner=FakeCommands())


def test_config_rejects_staging_inside_private_root(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    nested_staging = Path(value["private_file_roots"][0]) / "staging"
    nested_staging.mkdir()
    value["staging_directory"] = str(nested_staging)
    config_path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(BackupError, match="cannot overlap"):
        run_backup(config_path, command_runner=FakeCommands())


@pytest.mark.parametrize(
    ("value", "platform_name"),
    [
        ("/var/lib/openslate/backups", "darwin"),
        (r"C:\\ProgramData\\OpenSlate\\backups", "win32"),
    ],
)
def test_config_accepts_native_absolute_path_forms(value: str, platform_name: str) -> None:
    assert BackupConfig._is_absolute_path(value, platform_name=platform_name)


def test_password_file_must_be_private_on_posix(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    password = Path(value["pg_password_file"])
    password.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP)
    with pytest.raises(BackupError, match="not private"):
        run_backup(config_path, command_runner=FakeCommands())


@pytest.mark.parametrize(
    "protected_key",
    [
        "pg_password_file",
        "restic_password_file",
        "maintenance_state_file",
        "maintenance_lock_file",
    ],
)
def test_marker_cannot_replace_a_protected_operation_input(
    tmp_path: Path, protected_key: str
) -> None:
    config_path, value = _config(tmp_path)
    value["completion_marker"] = value[protected_key]
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)

    with pytest.raises(BackupError, match="distinct"):
        run_backup(config_path, command_runner=FakeCommands())


def test_marker_cannot_be_created_inside_repository_or_private_files(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    value["completion_marker"] = str(Path(value["restic_repository"]) / "marker.json")
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)
    with pytest.raises(BackupError, match="inside backup"):
        run_backup(config_path, command_runner=FakeCommands())

    config_path, value = _config(tmp_path / "private-marker")
    value["completion_marker"] = str(Path(value["private_file_roots"][0]) / "marker.json")
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)
    with pytest.raises(BackupError, match="inside backup"):
        run_backup(config_path, command_runner=FakeCommands())


def test_stale_or_wrong_installation_maintenance_proof_is_rejected(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    state_path = Path(value["maintenance_state_file"])
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["issued_at"] = "2000-01-01T00:00:00Z"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    state_path.chmod(0o600)
    with pytest.raises(BackupError, match="stale"):
        run_backup(config_path, command_runner=FakeCommands())

    config_path, value = _config(tmp_path / "wrong-installation")
    state_path = Path(value["maintenance_state_file"])
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["installation_id"] = "b" * 32
    state_path.write_text(json.dumps(state), encoding="utf-8")
    state_path.chmod(0o600)
    with pytest.raises(BackupError, match="stopped in maintenance"):
        run_backup(config_path, command_runner=FakeCommands())


def test_maintenance_proof_change_during_backup_prevents_marker(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    state_path = Path(value["maintenance_state_file"])

    def changes_state(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        result = FakeCommands()(args, env=env)
        if Path(args[0]).name == "pg_dump":
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state["scanner"] = "running"
            state_path.write_text(json.dumps(state), encoding="utf-8")
            state_path.chmod(0o600)
        return result

    with pytest.raises(BackupError, match="stopped in maintenance"):
        run_backup(config_path, command_runner=changes_state)
    assert not Path(value["completion_marker"]).exists()


@pytest.mark.parametrize("replaced", ["state", "lock"])
def test_atomic_replacement_of_maintenance_proof_fails_closed(
    tmp_path: Path, replaced: str
) -> None:
    config_path, value = _config(tmp_path)
    target = Path(
        value["maintenance_state_file"] if replaced == "state" else value["maintenance_lock_file"]
    )

    def replaces_proof(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        result = FakeCommands()(args, env=env)
        if Path(args[0]).name == "pg_dump":
            replacement = target.with_suffix(".replacement")
            if replaced == "state":
                state = json.loads(target.read_text(encoding="utf-8"))
                state["scanner"] = "running"
                replacement.write_text(json.dumps(state), encoding="utf-8")
            else:
                replacement.write_text(value["installation_id"] + "\n", encoding="utf-8")
            replacement.chmod(0o600)
            os.replace(replacement, target)
        return result

    with pytest.raises(BackupError, match="changed during backup"):
        run_backup(config_path, command_runner=replaces_proof)
    assert not Path(value["completion_marker"]).exists()


def test_setup_failure_closes_lease_and_directory_guards(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    operation: Any = importlib.import_module("backup.backup_installation")
    config_path, _ = _config(tmp_path)
    original_close = operation.MaintenanceLease.close
    closed: list[object] = []

    def records_close(lease: object) -> None:
        closed.append(lease)
        original_close(lease)

    def fails_mkdtemp(*_: object, **__: object) -> str:
        raise OSError("staging unavailable")

    monkeypatch.setattr(operation.MaintenanceLease, "close", records_close)
    monkeypatch.setattr(operation.tempfile, "mkdtemp", fails_mkdtemp)
    with pytest.raises(OSError, match="staging unavailable"):
        run_backup(config_path, command_runner=FakeCommands())
    assert len(closed) == 1


def test_child_environments_do_not_inherit_application_or_smtp_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSLATE_JWT_SECRET", "application-secret")
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    config_path, _ = _config(tmp_path)
    commands = FakeCommands()

    run_backup(config_path, command_runner=commands)

    assert all(
        "OPENSLATE_JWT_SECRET" not in env and "SMTP_PASSWORD" not in env
        for _, env in commands.calls
    )


def test_post_init_failure_retry_reuses_initialized_repository(tmp_path: Path) -> None:
    config_path, _ = _config(tmp_path)
    repository_ready = False
    fail_backup_once = True
    calls: list[list[str]] = []

    def commands(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        nonlocal repository_ready, fail_backup_once
        calls.append(args)
        if args == ["restic", "cat", "config", "--json"]:
            return subprocess.CompletedProcess(args, 0 if repository_ready else 1, "", "")
        if args == ["restic", "init"]:
            repository_ready = True
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[:2] == ["restic", "backup"] and fail_backup_once:
            fail_backup_once = False
            return subprocess.CompletedProcess(args, 1, "", "")
        return FakeCommands()(args, env=env)

    with pytest.raises(BackupError, match="restic backup"):
        run_backup(config_path, command_runner=commands)
    run_backup(config_path, command_runner=commands)

    assert sum(args == ["restic", "init"] for args in calls) == 1


def test_decoded_newline_in_database_identifier_and_password_file_is_rejected(
    tmp_path: Path,
) -> None:
    config_path, value = _config(tmp_path)
    value["database_url"] = "postgresql://user%0Aname@localhost:5432/openslate"
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)
    with pytest.raises(BackupError, match="CR, LF"):
        parse_config(config_path)

    config_path, value = _config(tmp_path / "newline-password")
    password = Path(value["pg_password_file"])
    password.write_text("valid\ninvalid", encoding="utf-8")
    password.chmod(0o600)
    with pytest.raises(BackupError, match="CR, LF"):
        run_backup(config_path, command_runner=FakeCommands())


def test_percent_encoded_database_host_is_rejected(tmp_path: Path) -> None:
    config_path, value = _config(tmp_path)
    value["database_url"] = "postgresql://openslate_owner@local%68ost:5432/openslate"
    config_path.write_text(json.dumps(value), encoding="utf-8")
    config_path.chmod(0o600)

    with pytest.raises(BackupError, match="percent encoding"):
        parse_config(config_path)
