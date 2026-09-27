"""Safety contracts for the offline Supabase installation archive."""

from __future__ import annotations

import json
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backup.backup_installation import BackupError, parse_config, run_backup

SNAPSHOT = "f" * 64
_BASE_SERVICES = (
    "db",
    "auth",
    "rest",
    "storage",
    "imgproxy",
    "meta",
    "studio",
    "api-gw",
    "provider-volume-init",
)
_DEV_SERVICES = (*_BASE_SERVICES, "mailpit")
_PRODUCTION_SERVICES = (*_BASE_SERVICES, "api", "scanner-worker", "clamav", "caddy")
_DEV_VOLUMES = (
    "supabase-db-data",
    "supabase-db-config",
    "supabase-storage-data",
    "supabase-studio-snippets",
)
_PRODUCTION_VOLUMES = (*_DEV_VOLUMES, "caddy-data")


def _private(path: Path, content: str = "private") -> Path:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)
    return path


def _config(tmp_path: Path, *, deployment: str = "development") -> Path:
    for name in ("repository", "staging"):
        (tmp_path / name).mkdir(mode=0o700)
    production = deployment == "production"
    tls_directory = tmp_path / "tls" if production else None
    if tls_directory:
        tls_directory.mkdir(mode=0o700)
        _private(tls_directory / "certificate.pem", "tls private material")
    payload = {
        "version": 3,
        "installation_id": "a" * 32,
        "project_name": "client-a",
        "deployment": deployment,
        "compose_root": str(Path(__file__).resolve().parents[3] / "infra" / "supabase"),
        "provider_env_file": str(_private(tmp_path / "provider.env")),
        "app_env_file": str(_private(tmp_path / "app.env", "app environment secret"))
        if production
        else None,
        "caddy_config_file": str(_private(tmp_path / "Caddyfile", "Caddy private config"))
        if production
        else None,
        "tls_directory": str(tls_directory) if tls_directory else None,
        "restic_repository": str(tmp_path / "repository"),
        "restic_password_file": str(_private(tmp_path / "restic-key")),
        "staging_directory": str(tmp_path / "staging"),
        "completion_marker": str(tmp_path / "backup-complete.json"),
    }
    path = _private(tmp_path / "backup.json", json.dumps(payload))
    return path


class BackupCommands:
    """Fake Docker and Restic responses for the offline Supabase archive path."""

    def __init__(
        self,
        config: Path,
        *,
        fail_at: str | None = None,
        corrupt_restored_manifest: bool = False,
    ) -> None:
        self.config = json.loads(config.read_text(encoding="utf-8"))
        self.fail_at = fail_at
        self.corrupt_restored_manifest = corrupt_restored_manifest
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.snapshot_manifest: bytes | None = None
        self.marker_present_during_verification: list[bool] = []
        self.restic_cache_modes: list[int] = []
        self.archive_files: dict[str, bytes] = {}
        self.services = (
            _PRODUCTION_SERVICES if self.config["deployment"] == "production" else _DEV_SERVICES
        )
        self.volumes = (
            _PRODUCTION_VOLUMES if self.config["deployment"] == "production" else _DEV_VOLUMES
        )
        self.images = {
            service: f"example.invalid/{service}@sha256:{service.encode().hex():0<64}"
            for service in self.services
        }

    def __call__(
        self, args: list[str], *, env: dict[str, str]
    ) -> subprocess.CompletedProcess[bytes]:
        self.calls.append((args, env))
        if args[0] == "restic":
            cache = Path(env["RESTIC_CACHE_DIR"])
            self.restic_cache_modes.append(stat.S_IMODE(cache.stat().st_mode))
        command = " ".join(args)
        if self.fail_at == "unavailable-restic" and args[0] == "restic":
            raise FileNotFoundError("restic")
        if self.fail_at and self.fail_at in command:
            return subprocess.CompletedProcess(args, 1, b"", b"failed")
        if args[:2] == ["docker", "ps"]:
            return subprocess.CompletedProcess(args, 0, "\n".join(self.services).encode(), b"")
        if args[:3] == ["docker", "container", "inspect"]:
            project = self.config["project_name"]
            containers = [
                {
                    "Config": {
                        "Image": self.images[service],
                        "Labels": {
                            "com.docker.compose.project": project,
                            "com.docker.compose.service": service,
                        },
                    },
                    "Image": f"sha256:{service.encode().hex():0<64}",
                    "State": {"Status": "exited"},
                }
                for service in self.services
            ]
            return subprocess.CompletedProcess(args, 0, json.dumps(containers).encode(), b"")
        if args[:3] == ["docker", "volume", "ls"]:
            names = [f"{self.config['project_name']}_{name}" for name in self.volumes]
            return subprocess.CompletedProcess(args, 0, "\n".join(names).encode(), b"")
        if args[:3] == ["docker", "volume", "inspect"]:
            project = self.config["project_name"]
            volumes = [
                {
                    "Name": name,
                    "Labels": {
                        "com.docker.compose.project": project,
                        "com.docker.compose.volume": name.removeprefix(f"{project}_"),
                    },
                }
                for name in args[3:]
            ]
            return subprocess.CompletedProcess(args, 0, json.dumps(volumes).encode(), b"")
        if args[:2] == ["docker", "compose"]:
            payload = {"services": {name: {"image": image} for name, image in self.images.items()}}
            return subprocess.CompletedProcess(args, 0, json.dumps(payload).encode(), b"")
        if args[:2] == ["restic", "backup"]:
            bundle = Path(args[-1])
            self.snapshot_manifest = (bundle / "manifest.json").read_bytes()
            self.archive_files = {
                item.relative_to(bundle).as_posix(): item.read_bytes()
                for item in bundle.rglob("*")
                if item.is_file()
            }
            self.marker_present_during_verification.append(
                Path(self.config["completion_marker"]).exists()
            )
            summary = {"message_type": "summary", "snapshot_id": SNAPSHOT}
            return subprocess.CompletedProcess(args, 0, (json.dumps(summary) + "\n").encode(), b"")
        if args[:2] == ["restic", "check"]:
            self.marker_present_during_verification.append(
                Path(self.config["completion_marker"]).exists()
            )
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if args[:2] == ["restic", "restore"]:
            self.marker_present_during_verification.append(
                Path(self.config["completion_marker"]).exists()
            )
            target = Path(args[args.index("--target") + 1])
            source = Path(args[args.index("--include") + 1])
            destination = target / source.relative_to(source.anchor)
            destination.parent.mkdir(parents=True, exist_ok=True)
            contents = self.snapshot_manifest or b""
            if self.corrupt_restored_manifest:
                contents += b"corrupt"
            destination.write_bytes(contents)
            return subprocess.CompletedProcess(args, 0, b"", b"")
        return subprocess.CompletedProcess(args, 0, b"", b"")


def _mock_volume_exports(monkeypatch: pytest.MonkeyPatch) -> None:
    from backup import backup_installation

    def export(_: str, __: str, destination: Path) -> None:
        destination.write_bytes(b"fixture volume archive")

    monkeypatch.setattr(backup_installation, "_export_volume", export)


def test_v3_config_accepts_offline_supabase_inputs(tmp_path: Path) -> None:
    config = parse_config(_config(tmp_path))
    assert config.project_name == "client-a"
    assert config.deployment == "development"


def test_old_database_dump_format_is_not_selectable(tmp_path: Path) -> None:
    path = _config(tmp_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = 2
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(BackupError, match="version 3"):
        parse_config(path)


def test_backup_verifies_the_snapshot_before_publishing_its_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "untrusted-home"))
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-secret")
    monkeypatch.setenv("SMTP_PASS", "smtp-secret")
    config = _config(tmp_path)
    commands = BackupCommands(config)
    _mock_volume_exports(monkeypatch)

    result = run_backup(config, command_runner=commands)

    marker = json.loads(Path(json.loads(config.read_text())["completion_marker"]).read_text())
    assert result.snapshot_id == marker["snapshot_id"] == SNAPSHOT
    assert marker["format_version"] == 3
    assert commands.snapshot_manifest is not None
    manifest = json.loads(commands.snapshot_manifest)
    assert manifest["format_version"] == 3
    assert commands.marker_present_during_verification == [False, False, False]
    staging = Path(json.loads(config.read_text())["staging_directory"])
    assert not list(staging.iterdir())
    restic_envs = [env for args, env in commands.calls if args[0] == "restic"]
    assert restic_envs
    cache_paths = [Path(env["RESTIC_CACHE_DIR"]) for env in restic_envs]
    assert all(path.is_relative_to(staging) and not path.exists() for path in cache_paths)
    assert all("HOME" not in env for env in restic_envs)
    assert all("RESTIC_PASSWORD_FILE" in env and "PGPASSFILE" not in env for env in restic_envs)
    assert commands.restic_cache_modes and set(commands.restic_cache_modes) == {0o700}
    assert all(
        "SUPABASE_SERVICE_ROLE_KEY" not in env and "SMTP_PASS" not in env
        for _, env in commands.calls
    )
    assert all(
        "service-secret" not in " ".join(args) and "smtp-secret" not in " ".join(args)
        for args, _ in commands.calls
    )


@pytest.mark.parametrize(
    ("failure", "message"),
    [
        ("unavailable-restic", "Restic repository admission is unavailable"),
        ("restic backup", "Restic backup failed"),
        ("restic check", "Restic data verification failed"),
    ],
)
def test_backup_dependency_or_verification_failure_cleans_staging_and_marker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
    message: str,
) -> None:
    config = _config(tmp_path)
    commands = BackupCommands(config, fail_at=failure)
    _mock_volume_exports(monkeypatch)

    with pytest.raises(BackupError, match=message):
        run_backup(config, command_runner=commands)

    raw = json.loads(config.read_text(encoding="utf-8"))
    assert not Path(raw["completion_marker"]).exists()
    assert list(Path(raw["staging_directory"]).iterdir()) == []


def test_backup_rejects_a_manifest_that_restic_does_not_restore_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _config(tmp_path)
    commands = BackupCommands(config, corrupt_restored_manifest=True)
    _mock_volume_exports(monkeypatch)

    with pytest.raises(BackupError, match="manifest restore did not match"):
        run_backup(config, command_runner=commands)

    raw = json.loads(config.read_text(encoding="utf-8"))
    assert not Path(raw["completion_marker"]).exists()
    assert list(Path(raw["staging_directory"]).iterdir()) == []


def test_backup_rejects_provider_environment_with_broad_permissions(tmp_path: Path) -> None:
    config = _config(tmp_path)
    raw = json.loads(config.read_text(encoding="utf-8"))
    provider_file = Path(raw["provider_env_file"])
    commands = BackupCommands(config)

    provider_file.chmod(0o644)
    with pytest.raises(BackupError, match="owner-controlled"):
        run_backup(config, command_runner=commands)
    assert commands.calls == []


@pytest.mark.parametrize(
    ("deployment", "private_key"),
    [
        ("development", "provider_env_file"),
        ("production", "provider_env_file"),
        ("production", "app_env_file"),
        ("production", "caddy_config_file"),
        ("production", "tls_directory"),
    ],
)
def test_backup_rejects_symlinked_private_inputs(
    tmp_path: Path, deployment: str, private_key: str
) -> None:
    config = _config(tmp_path, deployment=deployment)
    raw = json.loads(config.read_text(encoding="utf-8"))
    source = Path(raw[private_key])
    target = tmp_path / f"actual-{source.name}"
    if source.is_dir():
        source.rename(target)
        source.symlink_to(target, target_is_directory=True)
    else:
        target.write_bytes(source.read_bytes())
        target.chmod(0o600)
        source.unlink()
        source.symlink_to(target)
    commands = BackupCommands(config)

    with pytest.raises(BackupError, match="symlink"):
        run_backup(config, command_runner=commands)
    assert commands.calls == []


def test_production_backup_captures_private_provider_and_gateway_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _config(tmp_path, deployment="production")
    raw = json.loads(config.read_text(encoding="utf-8"))
    commands = BackupCommands(config)
    _mock_volume_exports(monkeypatch)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "runtime-service-secret")
    monkeypatch.setenv("OPENSLATE_DATABASE_PASSWORD", "runtime-database-secret")
    monkeypatch.setenv("SMTP_PASS", "runtime-smtp-secret")

    run_backup(config, command_runner=commands)

    assert (
        commands.archive_files["private/provider.env"]
        == Path(raw["provider_env_file"]).read_bytes()
    )
    assert commands.archive_files["private/app.env"] == Path(raw["app_env_file"]).read_bytes()
    assert (
        commands.archive_files["private/Caddyfile"] == Path(raw["caddy_config_file"]).read_bytes()
    )
    assert commands.archive_files["private/tls/certificate.pem"] == b"tls private material"
    assert "caddy-data" in json.loads(commands.snapshot_manifest or b"{}")["volumes"]
    assert all(
        not any(
            key in env
            for key in ("SUPABASE_SERVICE_ROLE_KEY", "OPENSLATE_DATABASE_PASSWORD", "SMTP_PASS")
        )
        for _, env in commands.calls
    )
    assert all(
        all(
            secret not in " ".join(args)
            for secret in (
                "runtime-service-secret",
                "runtime-database-secret",
                "runtime-smtp-secret",
            )
        )
        for args, _ in commands.calls
    )


@pytest.mark.parametrize("private_key", ["provider_env_file", "restic_password_file"])
def test_backup_rejects_private_inputs_inside_the_restic_repository(
    tmp_path: Path, private_key: str
) -> None:
    config = _config(tmp_path)
    raw = json.loads(config.read_text(encoding="utf-8"))
    source = Path(raw[private_key])
    target = Path(raw["restic_repository"]) / f"{private_key}.private"
    target.write_bytes(source.read_bytes())
    target.chmod(0o600)
    raw[private_key] = str(target)
    config.write_text(json.dumps(raw), encoding="utf-8")
    config.chmod(0o600)
    commands = BackupCommands(config)

    with pytest.raises(BackupError, match="inside the Restic repository"):
        run_backup(config, command_runner=commands)
    assert commands.calls == []


@pytest.mark.parametrize("overlap", ["marker-input", "marker-repository", "staging-repository"])
def test_backup_rejects_marker_input_and_staging_repository_overlap(
    tmp_path: Path, overlap: str
) -> None:
    config = _config(tmp_path)
    raw = json.loads(config.read_text(encoding="utf-8"))
    if overlap == "marker-input":
        raw["completion_marker"] = raw["provider_env_file"]
    elif overlap == "marker-repository":
        raw["completion_marker"] = str(Path(raw["restic_repository"]) / "backup-complete.json")
    else:
        nested = Path(raw["restic_repository"]) / "nested-staging"
        nested.mkdir(mode=0o700)
        raw["staging_directory"] = str(nested)
    config.write_text(json.dumps(raw), encoding="utf-8")
    config.chmod(0o600)
    commands = BackupCommands(config)

    with pytest.raises(BackupError):
        run_backup(config, command_runner=commands)
    assert commands.calls == []


@pytest.mark.parametrize(
    ("overlap", "deployment", "operation"),
    [
        ("tls", "production", "staging_directory"),
        ("tls", "production", "restic_repository"),
        ("compose", "development", "staging_directory"),
        ("upstream", "development", "staging_directory"),
        ("templates", "development", "restic_repository"),
    ],
)
def test_backup_rejects_operation_directory_inside_recursively_copied_input(
    tmp_path: Path, overlap: str, deployment: str, operation: str
) -> None:
    config = _config(tmp_path, deployment=deployment)
    raw = json.loads(config.read_text(encoding="utf-8"))
    if overlap == "tls":
        input_root = Path(raw["tls_directory"])
    else:
        compose_root = tmp_path / "release-compose"
        compose_root.mkdir(mode=0o700)
        (compose_root / "upstream").mkdir(mode=0o700)
        (compose_root / "templates").mkdir(mode=0o700)
        (compose_root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (compose_root / "compose.dev.yaml").write_text("services: {}\n", encoding="utf-8")
        raw["compose_root"] = str(compose_root)
        input_root = compose_root if overlap == "compose" else compose_root / overlap
    nested = input_root / f"nested-{operation}"
    nested.mkdir(mode=0o700)
    raw[operation] = str(nested)
    config.write_text(json.dumps(raw), encoding="utf-8")
    config.chmod(0o600)
    calls: list[list[str]] = []

    def forbidden_runner(
        args: list[str], *, env: dict[str, str]
    ) -> subprocess.CompletedProcess[bytes]:
        calls.append(args)
        raise AssertionError("Docker or Restic reached before path admission")

    with pytest.raises(BackupError, match="overlap"):
        run_backup(config, command_runner=forbidden_runner)
    assert calls == []


@pytest.mark.parametrize(
    "legacy_or_invalid",
    [
        {"database_url": "postgresql://obsolete"},
        {"pg_password_file": "/obsolete/pg-password"},
        {"private_file_roots": []},
        {"missing": None},
    ],
)
def test_supabase_backup_config_rejects_legacy_or_unlisted_fields(
    tmp_path: Path, legacy_or_invalid: dict[str, object]
) -> None:
    config = _config(tmp_path)
    raw = json.loads(config.read_text(encoding="utf-8"))
    if "missing" in legacy_or_invalid:
        raw.pop("app_env_file")
    else:
        raw.update(legacy_or_invalid)
    config.write_text(json.dumps(raw), encoding="utf-8")
    config.chmod(0o600)

    with pytest.raises(BackupError, match="exactly the version 3 fields"):
        parse_config(config)


def test_backup_cleanup_failure_does_not_publish_a_completion_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _config(tmp_path)
    commands = BackupCommands(config)
    _mock_volume_exports(monkeypatch)
    from backup import backup_installation

    original_rmtree = shutil.rmtree

    def fail_operation_cleanup(path: str | Path, *args: Any, **kwargs: Any) -> None:
        if Path(path).name.startswith("openslate-supabase-backup-"):
            raise OSError("backup staging cleanup failed")
        original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(backup_installation.shutil, "rmtree", fail_operation_cleanup)

    with pytest.raises((BackupError, OSError), match="cleanup"):
        run_backup(config, command_runner=commands)

    marker_path = Path(json.loads(config.read_text())["completion_marker"])
    assert not marker_path.exists()
