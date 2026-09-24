import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests import caddy_runtime, fullstack_summary
from tests import fullstack_runner as runner
from tests.postgres_runtime import DisposablePostgres


def test_standalone_fullstack_runner_loads_complete_model_registry() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from sqlalchemy.orm import configure_mappers; "
            "import tests.fullstack_runner; "
            "from app.systems.access.identity.service import create_credential; "
            "from app.systems.access.users.models import Role, User, UserStatus; "
            "configure_mappers()",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


class _RunnerPostgres:
    network = "test-network"

    def __init__(self, root: Path) -> None:
        self.root = root

    def start(self) -> None:
        pass

    def urls(self) -> dict[str, str]:
        return {
            "DATABASE_URL": "postgresql+psycopg://runtime@127.0.0.1/openslate",
            "MIGRATION_DATABASE_URL": "postgresql+psycopg://owner@127.0.0.1/openslate",
            "DATABASE_INSPECTOR_URL": "postgresql+psycopg://inspector@127.0.0.1/openslate",
        }

    def write_manifest(self) -> Path:
        manifest = self.root / "database.json"
        manifest.write_text("{}")
        return manifest

    def stop(self) -> None:
        pass


def _stub_fullstack_prerequisites(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, run: object
) -> MagicMock:
    scanner = MagicMock()
    scanner.observations = {}
    monkeypatch.setattr(runner, "BACKEND", tmp_path / "backend")
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")
    monkeypatch.setattr(runner, "DisposablePostgres", lambda *_args: _RunnerPostgres(tmp_path))
    monkeypatch.setattr(runner, "instance_target_for_process", lambda *_args: object())
    monkeypatch.setattr(runner, "DisposableScanner", lambda *_args: scanner)
    monkeypatch.setattr(runner, "run_backend_coverage", lambda *_args: 0)
    monkeypatch.setattr(
        runner,
        "seed",
        lambda *_args: {"admin": {"email": "admin@example.test", "password": "password"}},
    )
    monkeypatch.setattr(runner.subprocess, "run", run)
    return scanner


def test_disposable_caddy_uses_a_pinned_image_loopback_gateway_and_owned_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    monkeypatch.setattr(caddy_runtime.shutil, "which", lambda _: None)
    monkeypatch.setattr(caddy_runtime.sys, "platform", "darwin")
    runtime = caddy_runtime.DisposableCaddy(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect" or arguments[:2] == ["image", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, "a" * 32)
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        runtime.start()
        runtime.stop()
    finally:
        log.close()

    launch = next(arguments for arguments in commands if arguments[0] == "run")
    assert "@sha256:" in caddy_runtime.CADDY_IMAGE
    assert runtime.image in launch
    assert "127.0.0.1:3448:3448/tcp" in launch
    assert "host.docker.internal:host-gateway" in launch
    assert "--read-only" in launch
    build = next(arguments for arguments in commands if arguments[0] == "build")
    assert caddy_runtime.CADDY_IMAGE in runtime.dockerfile.read_text()
    assert runtime.image in build
    assert ["rm", "--force", runtime.container] in commands
    assert ["image", "rm", runtime.image] in commands
    assert runtime.config.stat().st_mode & 0o777 == 0o644


def test_native_caddy_binds_loopback_and_uses_loopback_upstreams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    monkeypatch.setattr(caddy_runtime.shutil, "which", lambda _: "/usr/local/bin/caddy")
    validate = MagicMock()
    process = MagicMock()
    process.poll.return_value = 0
    monkeypatch.setattr(caddy_runtime.subprocess, "run", validate)
    monkeypatch.setattr(caddy_runtime.subprocess, "Popen", lambda *_args, **_kwargs: process)
    runtime = caddy_runtime.DisposableCaddy(tmp_path, "a" * 32, {"PATH": "test"}, log)
    try:
        runtime.start()
        runtime.stop()
    finally:
        log.close()

    assert validate.call_args.args[0][:2] == ["/usr/local/bin/caddy", "validate"]
    rendered = runtime.config.read_text()
    assert "bind 127.0.0.1" in rendered
    assert "http://127.0.0.1:3449 {\n    bind 127.0.0.1" in rendered


def test_linux_docker_caddy_uses_host_network_and_loopback_upstreams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    monkeypatch.setattr(caddy_runtime.shutil, "which", lambda _: None)
    monkeypatch.setattr(caddy_runtime.sys, "platform", "linux")
    runtime = caddy_runtime.DisposableCaddy(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect" or arguments[:2] == ["image", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, "a" * 32)
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        runtime.start()
        runtime.stop()
    finally:
        log.close()

    launch = next(arguments for arguments in commands if arguments[0] == "run")
    assert ["--network", "host"] == launch[
        launch.index("--network") : launch.index("--network") + 2
    ]
    assert "--publish" not in launch
    assert "--add-host" not in launch
    rendered = runtime.config.read_text()
    assert "bind 127.0.0.1" in rendered
    assert "http://127.0.0.1:3449 {\n    bind 127.0.0.1" in rendered


def test_disposable_caddy_rejects_unowned_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    monkeypatch.setattr(caddy_runtime.shutil, "which", lambda _: None)
    runtime = caddy_runtime.DisposableCaddy(tmp_path, "a" * 32, {"PATH": "test"}, log)

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 0, "different-run")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="ownership"):
            runtime.stop()
    finally:
        log.close()


def test_disposable_caddy_removes_an_owned_image_when_container_start_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    monkeypatch.setattr(caddy_runtime.shutil, "which", lambda _: None)
    runtime = caddy_runtime.DisposableCaddy(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[:2] == ["image", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, "a" * 32)
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        runtime.stop()
    finally:
        log.close()

    assert ["image", "rm", runtime.image] in commands


def test_gateway_config_preserves_single_origin_routes_with_container_host_upstreams() -> None:
    rendered = caddy_runtime.render_gateway_config()

    assert "https://localhost:3448" in rendered
    assert "bind 0.0.0.0" in rendered
    assert rendered.count("host.docker.internal") == 4
    assert "@events path /api/events" in rendered
    assert "@api path /api /api/*" in rendered
    assert "{{" not in rendered


def test_browser_acceptance_command_runs_the_owned_fullstack_suite_in_every_mode() -> None:
    command = runner.browser_acceptance_command()

    assert command == [
        "npx",
        "playwright",
        "test",
        "--config=playwright.fullstack.config.ts",
    ]


def test_partial_postgres_startup_cleans_only_its_labeled_volume_and_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[:2] == ["volume", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, json.dumps([{
                "Name": runtime.volume, "Labels": {
                    "openslate.test.run": runtime.run_id,
                    "openslate.test.worktree": runtime.worktree,
                },
            }]))
        if arguments[:2] == ["network", "inspect"]:
            return subprocess.CompletedProcess(
                arguments, 0, f"{runtime.run_id} {runtime.worktree}"
            )
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        runtime.stop()
    finally:
        log.close()
    assert ["rm", "--force", runtime.container] not in commands
    assert ["volume", "rm", runtime.volume] in commands
    assert ["network", "rm", runtime.network] in commands


def test_runner_rejects_invalid_batch_before_starting_postgres(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = MagicMock()
    monkeypatch.setattr(runner, "DisposablePostgres", start)

    with pytest.raises(SystemExit):
        runner.main(["--backend-batch", "tests"])

    start.assert_not_called()


def test_runtime_environment_excludes_bootstrap_and_migration_connections() -> None:
    values = {
        "DATABASE_BOOTSTRAP_URL": "bootstrap-private",
        "MIGRATION_DATABASE_URL": "owner-private",
        "DATABASE_URL": "runtime-private",
    }

    assert runner.runtime_database_environment(values) == {"DATABASE_URL": "runtime-private"}


def test_private_file_storage_is_created_before_the_scanner_worker_starts(tmp_path: Path) -> None:
    storage_root = runner.prepare_private_file_storage(tmp_path)

    assert storage_root == tmp_path / "private-files"
    assert storage_root.is_dir()
    assert storage_root.stat().st_mode & 0o077 == 0


def test_backend_coverage_does_not_require_an_unbuilt_static_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backend CI lane must run from a checkout before the frontend export exists."""
    observed: dict[str, str] = {}
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> MagicMock:
        commands.append(command)
        return MagicMock()

    _stub_fullstack_prerequisites(monkeypatch, tmp_path, run)
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend-without-export")

    def coverage(_run, _backend, _private, environment, _run_id) -> int:
        observed.update(environment)
        return 0

    monkeypatch.setattr(runner, "run_backend_coverage", coverage)

    assert runner.main(["--backend-coverage-only"]) == 0
    assert "WEB_ASSETS_ROOT" not in observed
    assert ["npm", "run", "build", "--", "--webpack"] not in commands


def test_fullstack_stops_before_fastapi_when_static_build_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    start_fastapi = MagicMock()

    def run(command: list[str], **_kwargs: object) -> MagicMock:
        commands.append(command)
        if command == ["npm", "run", "build", "--", "--webpack"]:
            raise subprocess.CalledProcessError(1, command)
        return MagicMock()

    scanner = _stub_fullstack_prerequisites(monkeypatch, tmp_path, run)
    monkeypatch.setattr(runner.subprocess, "Popen", start_fastapi)

    assert runner.main([]) == 1
    assert commands[-1] == ["npm", "run", "build", "--", "--webpack"]
    start_fastapi.assert_not_called()
    scanner.stop.assert_called_once()


def test_fullstack_assigns_static_assets_after_a_successful_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []
    launched_environment: dict[str, str] = {}

    def run(command: list[str], **_kwargs: object) -> MagicMock:
        if command == ["npm", "run", "build", "--", "--webpack"]:
            events.append("build")
        return MagicMock()

    _stub_fullstack_prerequisites(monkeypatch, tmp_path, run)
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")

    def start_fastapi(*_args: object, **kwargs: object) -> None:
        events.append("fastapi")
        launched_environment.update(kwargs["env"])
        raise RuntimeError("stop after FastAPI configuration")

    monkeypatch.setattr(runner.subprocess, "Popen", start_fastapi)

    assert runner.main([]) == 1
    assert events == ["build", "fastapi"]
    assert launched_environment["WEB_ASSETS_ROOT"] == str(runner.FRONTEND / "out")


def test_fullstack_summary_preserves_result_and_observations_contract(tmp_path: Path) -> None:
    (tmp_path / "process.log").write_text(
        "FAILED tests/auth/test_login.py::test_rejects_unknown_user\n"
        '{"test": "login journey", "status": "failed"}\n'
    )
    (tmp_path / "pytest.xml").write_text(
        '<testsuites><testsuite tests="2" failures="1" errors="0" skipped="0">'
        '<properties><property name="pool_checkout_wait_seconds" value="0.25"/>'
        "</properties></testsuite></testsuites>"
    )
    result_path = fullstack_summary.summary_path(
        tmp_path / "backend", tmp_path / "frontend", batch=None, backend_only=False
    )

    fullstack_summary.write_fullstack_summary(
        result_path,
        tmp_path,
        result=1,
        batch=None,
        backend_only=False,
        acceptance_only=True,
        scanner_only=False,
        stage="browser acceptance",
        browser_completed=False,
        admission={"recovered": True},
        checker_exit=1,
        scanner_observations={"ready": True},
        failure_type="RuntimeError",
        failure_message="expected failure",
    )

    assert json.loads(result_path.read_text()) == {
        "result": "failed",
        "scope": "acceptance-only",
        "backend_tests_rerun": False,
        "stage": "browser acceptance",
        "browser_tests": [{"test": "login journey", "status": "failed"}],
        "backend_failures": ["tests/auth/test_login.py::test_rejects_unknown_user"],
        "backend_counts": {"tests": "2", "failures": "1", "errors": "0", "skipped": "0"},
        "resource_observations": {"pool_checkout_wait_seconds": 0.25},
        "admission_observations": {"recovered": True},
        "checker_exit": 1,
        "scanner_observations": {"ready": True},
        "failure_type": "RuntimeError",
        "failure_message": "expected failure",
    }
