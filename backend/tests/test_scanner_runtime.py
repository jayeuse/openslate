"""Scanner worker container boundaries for disposable full-stack runs."""

import json
import os
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from app.core.config import Settings
from tests import scanner_runtime
from tests.postgres_runtime import POSTGRES_NETWORK_ALIAS, postgres_network_name
from tests.scanner_runtime import DisposableScanner


def _application_environment(scanner: DisposableScanner, storage_root: Path) -> dict[str, str]:
    values = {name.upper(): "test-value" for name in Settings.model_fields}
    database_url = "postgresql+psycopg://openslate_runtime:test-password@127.0.0.1:49152/openslate"
    database_manifest = scanner.private / "database.json"
    database_manifest.write_text(json.dumps({"run_id": scanner.run_id, "urls": [database_url]}))
    database_manifest.chmod(0o600)
    values.update(
        DATABASE_URL=database_url,
        FILES_STORAGE_ROOT=str(storage_root),
        E2E_ALLOW_MUTATIONS="true",
        OPENSLATE_FULLSTACK_RUN_ID=scanner.run_id,
        OPENSLATE_TEST_DATABASE_MANIFEST=str(database_manifest),
    )
    return values


def _scanner(tmp_path: Path) -> DisposableScanner:
    private = tmp_path / "private"
    private.mkdir()
    return DisposableScanner(
        tmp_path,
        private,
        "a" * 32,
        {"PATH": "test"},
        (tmp_path / "process.log").open("w"),
    )


def test_build_context_supplies_unified_server_image_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for relative in (
        "infra/clamav/clamd.conf",
        "infra/clamav/freshclam.conf",
        "infra/clamav/serve.sh",
        "infra/docker/clamav.Dockerfile",
        "infra/docker/backend.Dockerfile",
        "backend/pyproject.toml",
        "backend/uv.lock",
        "backend/app/main.py",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/src/page.tsx",
        "frontend/node_modules/ignored.txt",
        "contracts/openapi.json",
    ):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        content = ""
        if relative.endswith("clamav.Dockerfile"):
            content = f"FROM clamav/clamav@{scanner_runtime.BASE_IMAGE_DIGEST}\n"
        path.write_text(content)
    scanner = _scanner(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    scanner.env["HOME"] = str(home)
    commands: list[list[str]] = []
    monkeypatch.setattr(scanner, "_run", lambda arguments, **_: commands.append(arguments))

    try:
        scanner._build()
    finally:
        scanner.log.close()

    context = scanner.private / "scanner-build"
    assert (context / "frontend/package.json").is_file()
    assert (context / "frontend/src/page.tsx").is_file()
    assert not (context / "frontend/node_modules").exists()
    assert (context / "contracts/openapi.json").is_file()
    assert [command[0] for command in commands] == ["build", "build"]
    assert scanner.images == [scanner.image, scanner.backend_image]


def test_worker_mounts_only_the_disposable_private_store_and_rewrites_its_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scanner = _scanner(tmp_path)
    storage_root = scanner.private / "private-files"
    storage_root.mkdir(parents=True)
    scanner.manifest.write_text("{}")
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> CompletedProcess[str]:
        commands.append(arguments)
        return CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(scanner, "_run", command)
    try:
        scanner.start_worker(
            _application_environment(scanner, storage_root), postgres_network_name(scanner.run_id)
        )
    finally:
        scanner.log.close()

    create = next(arguments for arguments in commands if arguments[0] == "create")
    assert create[create.index("--user") + 1] == f"{os.getuid()}:{os.getgid()}"
    mounts = [argument for argument in create if argument.startswith("type=bind,")]
    assert mounts == [
        f"type=bind,src={storage_root},dst=/run/openslate-private-files",
        f"type=bind,src={scanner.manifest},dst=/run/scanner-manifest.json,readonly",
    ]
    worker_environment = (scanner.private / "scanner-worker.env").read_text()
    assert "DATABASE_URL=" in worker_environment
    assert f"@{POSTGRES_NETWORK_ALIAS}:5432/openslate\n" in worker_environment
    assert "FILES_STORAGE_ROOT=/run/openslate-private-files\n" in worker_environment
    assert str(storage_root) not in worker_environment
    assert "host.docker.internal" not in create
    assert ["network", "connect", scanner.network, scanner.worker] in commands
    assert ["network", "connect", postgres_network_name(scanner.run_id), scanner.worker] in commands


def test_worker_keeps_optional_smtp_settings_absent_when_the_runner_disables_smtp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scanner = _scanner(tmp_path)
    storage_root = scanner.private / "private-files"
    storage_root.mkdir(parents=True)
    scanner.manifest.write_text("{}")
    environment = _application_environment(scanner, storage_root)
    for name in (
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
        "SMTP_FROM",
        "SMTP_TRANSPORT",
        "SMTP_DELIVERY_ENCRYPTION_KEY",
    ):
        environment.pop(name)
    commands: list[list[str]] = []
    monkeypatch.setattr(scanner, "_run", lambda arguments, **_: commands.append(arguments))

    try:
        scanner.start_worker(environment, postgres_network_name(scanner.run_id))
    finally:
        scanner.log.close()

    worker_environment = (scanner.private / "scanner-worker.env").read_text()
    assert "SMTP_ENABLED=test-value\n" in worker_environment
    assert "SMTP_HOST=" not in worker_environment


@pytest.mark.parametrize("storage_root", ["/tmp/not-a-disposable-store", "private-files"])
def test_worker_rejects_storage_outside_its_disposable_private_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, storage_root: str
) -> None:
    scanner = _scanner(tmp_path)
    calls: list[list[str]] = []
    monkeypatch.setattr(
        scanner,
        "_run",
        lambda arguments, **_: calls.append(arguments),
    )
    try:
        with pytest.raises(RuntimeError, match="disposable private storage"):
            scanner.start_worker(_application_environment(scanner, Path(storage_root)))
    finally:
        scanner.log.close()

    assert calls == []


def test_worker_rejects_a_symlinked_disposable_storage_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scanner = _scanner(tmp_path)
    target = tmp_path / "outside"
    target.mkdir()
    storage_root = scanner.private / "private-files"
    storage_root.symlink_to(target, target_is_directory=True)
    calls: list[list[str]] = []
    monkeypatch.setattr(scanner, "_run", lambda arguments, **_: calls.append(arguments))
    try:
        with pytest.raises(RuntimeError, match="disposable private storage"):
            scanner.start_worker(_application_environment(scanner, storage_root))
    finally:
        scanner.log.close()

    assert calls == []
