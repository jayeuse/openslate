import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest

from tests import caddy_runtime, fullstack_summary
from tests import fullstack_runner as runner
from tests.postgres_runtime import (
    POSTGRES_IMAGE,
    POSTGRES_NETWORK_ALIAS,
    DisposablePostgres,
    postgres_network_name,
)


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


def test_disposable_postgres_discovers_a_pinned_image_loopback_port_and_private_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 0, f"{'a' * 32} {POSTGRES_IMAGE}\n")
        if arguments[:2] == ["network", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, "a" * 32)
        if arguments[0] == "port":
            return subprocess.CompletedProcess(arguments, 0, "127.0.0.1:49152\n")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        runtime.start()
        manifest = runtime.write_manifest()
        runtime.stop()
    finally:
        log.close()

    launch = next(arguments for arguments in commands if arguments[0] == "run")
    assert [
        "network",
        "create",
        "--internal",
        "--label",
        f"openslate.test.run={'a' * 32}",
        postgres_network_name("a" * 32),
    ] in commands
    assert POSTGRES_IMAGE in launch
    assert "127.0.0.1::5432" in launch
    assert "--network" not in launch
    assert [
        "network",
        "connect",
        "--alias",
        POSTGRES_NETWORK_ALIAS,
        postgres_network_name("a" * 32),
        runtime.container,
    ] in commands
    assert f"openslate.test.run={'a' * 32}" in launch
    assert manifest.stat().st_mode & 0o077 == 0
    contents = json.loads(manifest.read_text())
    assert contents["run_id"] == "a" * 32
    assert all(":49152/openslate" in url for url in contents["urls"])
    assert {urlsplit(url).username for url in contents["urls"]} == {
        "postgres",
        "openslate_owner",
        "openslate_runtime",
        "openslate_inspector",
    }
    assert ["rm", "--force", "--volumes", runtime.container] in commands
    assert ["network", "rm", runtime.network] in commands


def test_disposable_postgres_rejects_a_missing_or_non_loopback_discovered_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 0, f"{'a' * 32} {POSTGRES_IMAGE}\n")
        if arguments[0] == "port":
            return subprocess.CompletedProcess(arguments, 0, "0.0.0.0:49152\n")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="loopback port mapping"):
            runtime.start()
    finally:
        log.close()


def test_disposable_postgres_never_removes_an_unowned_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 0, "different-run " + POSTGRES_IMAGE)
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="ownership"):
            runtime.stop()
    finally:
        log.close()
    assert not any(arguments[0] == "rm" for arguments in commands)


def test_disposable_postgres_never_removes_an_unowned_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log = (tmp_path / "process.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
    commands: list[list[str]] = []

    def command(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(arguments)
        if arguments[0] == "inspect":
            raise subprocess.CalledProcessError(1, arguments)
        if arguments[:2] == ["network", "inspect"]:
            return subprocess.CompletedProcess(arguments, 0, "different-run")
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(runtime, "_run", command)
    try:
        with pytest.raises(RuntimeError, match="network without ownership"):
            runtime.stop()
    finally:
        log.close()

    assert ["network", "rm", runtime.network] not in commands


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
