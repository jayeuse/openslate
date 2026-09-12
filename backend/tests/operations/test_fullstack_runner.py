import json
import subprocess
import sys
import tomllib
from pathlib import Path
from secrets import token_urlsafe
from unittest.mock import MagicMock
from xml.etree.ElementTree import ParseError

import pytest

from app.core.config import Settings
from app.core.config.environment import environment_inputs
from tests import fullstack_runner as runner
from tests.scanner_recovery import _replace_engine

PRIVATE_FILE_CANARY = token_urlsafe(32)


@pytest.fixture(autouse=True)
def isolate_runner_reports(tmp_path, monkeypatch):
    backend = tmp_path / "backend"
    backend.mkdir()
    monkeypatch.setattr(runner, "BACKEND", backend)


def test_disposable_config_rewrite_uses_only_the_fixed_release_tuple():
    source = '''project_id = "env(SUPABASE_PROJECT_ID)"

[api]
port = "env(SUPABASE_API_PORT)"

[db]
port = "env(SUPABASE_DB_PORT)"
shadow_port = "env(SUPABASE_SHADOW_PORT)"

[db.pooler]
port = "env(SUPABASE_POOLER_PORT)"

[studio]
port = "env(SUPABASE_STUDIO_PORT)"
api_url = "env(SUPABASE_URL)"

[local_smtp]
port = "env(SUPABASE_MAIL_PORT)"

[auth]
site_url = "env(FRONTEND_URL)"
additional_redirect_urls = [
  "env(SUPABASE_AUTH_REDIRECT_URL)",
  "env(AUTH_SETUP_URL)",
]
enable_signup = false
'''

    rewritten = runner.rewrite_disposable_config(source, "a" * 32)
    config = tomllib.loads(rewritten)

    assert config["project_id"] == "p5-" + "a" * 32
    assert config["api"]["port"] == 55321
    assert config["db"] == {"port": 55322, "shadow_port": 55320, "pooler": {"port": 55329}}
    assert config["studio"] == {"port": 55323, "api_url": "http://127.0.0.1:55321"}
    assert config["local_smtp"]["port"] == 55324
    assert config["auth"]["site_url"] == "http://localhost:3008"
    assert config["auth"]["additional_redirect_urls"] == [
        "http://localhost:3008/auth/callback",
        "http://localhost:3008/auth/setup",
    ]
    assert config["auth"]["enable_signup"] is False
    assert "env(" not in rewritten


@pytest.mark.parametrize("failure", ["malformed_report", "summary_write"])
def test_report_failure_still_deletes_private_credentials(tmp_path, monkeypatch, failure):
    private = tmp_path / "private"
    private.mkdir()
    (private / "fixture.json").write_text(PRIVATE_FILE_CANARY)
    if failure == "malformed_report":
        (private / "pytest.xml").write_text("<truncated")
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")

    def fail_setup(*args, **kwargs):
        raise RuntimeError("controlled setup failure")

    monkeypatch.setattr(runner.shutil, "copytree", fail_setup)
    original_write = Path.write_text

    def write(path, *args, **kwargs):
        if path.name == "fullstack-summary.json":
            raise OSError("controlled summary failure")
        return original_write(path, *args, **kwargs)

    if failure == "summary_write":
        monkeypatch.setattr(Path, "write_text", write)
    with pytest.raises(ParseError if failure == "malformed_report" else OSError):
        runner.main()
    assert not private.exists()


def test_changed_project_identity_cannot_start_or_stop_an_existing_stack(tmp_path, monkeypatch):
    private = tmp_path / "private"
    private.mkdir()
    source = tmp_path / "source"
    (source / "supabase").mkdir(parents=True)
    (source / "supabase/config.toml").write_text('project_id = "another-project"\n')
    monkeypatch.setattr(runner, "ROOT", source)
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    command = MagicMock()
    monkeypatch.setattr(runner.subprocess, "run", command)
    assert runner.main() == 1
    command.assert_not_called()
    assert not private.exists()


def test_backend_regression_subprocess_includes_authenticated_jwt_audience(tmp_path, monkeypatch):
    private = tmp_path / "private"
    private.mkdir()
    captured = {}
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")

    def command(command, **kwargs):
        if command == ["supabase", "status", "-o", "json"]:
            return MagicMock(
                stdout=runner.json.dumps(
                    {
                        "DB_URL": "postgresql://postgres:test-password@127.0.0.1:55322/postgres",
                        "API_URL": runner.AUTH,
                        "PUBLISHABLE_KEY": "test-publishable-key",
                        "SECRET_KEY": "test-secret-key",
                    }
                )
            )
        if command[1:3] == ["-m", "pytest"]:
            captured.update(kwargs["env"])
        return MagicMock()

    monkeypatch.setattr(runner.subprocess, "run", command)

    assert runner.main() == 1
    settings = Settings.model_validate(environment_inputs(tmp_path / ".env", process=captured))
    assert settings.supabase_jwt_audience == "authenticated"


@pytest.mark.parametrize(
    ("platform", "cache_override", "browser_override", "expected"),
    [
        ("linux", None, None, "installer/.cache/ms-playwright"),
        ("darwin", None, None, "installer/Library/Caches/ms-playwright"),
        ("linux", "shared-cache", None, "shared-cache/ms-playwright"),
        ("linux", None, "shared-browsers", "shared-browsers"),
        ("linux", None, "0", "0"),
    ],
)
def test_private_tool_environment_preserves_installed_browser_location(
    tmp_path, monkeypatch, platform, cache_override, browser_override, expected
):
    private = tmp_path / "private"
    private.mkdir()
    captured = {}
    monkeypatch.setenv("HOME", str(tmp_path / "installer"))
    monkeypatch.setenv("UNRELATED_PRIVATE_SETTING", PRIVATE_FILE_CANARY)
    for name, value in (
        ("XDG_CACHE_HOME", cache_override),
        ("PLAYWRIGHT_BROWSERS_PATH", browser_override),
    ):
        monkeypatch.delenv(name, raising=False)
        if value is not None:
            monkeypatch.setenv(name, value if value == "0" else str(tmp_path / value))
    monkeypatch.setattr(runner.sys, "platform", platform)
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")

    def command(command, **kwargs):
        captured.update(kwargs["env"])
        raise RuntimeError("Stop before starting services")

    monkeypatch.setattr(runner.subprocess, "run", command)
    assert runner.main() == 1
    assert captured["HOME"] == str(private / "home")
    assert "UNRELATED_PRIVATE_SETTING" not in captured
    assert captured["PLAYWRIGHT_BROWSERS_PATH"] == (
        expected if expected == "0" else str(tmp_path / expected)
    )


def test_replacement_scanner_receives_the_required_listener_port(tmp_path):
    scanner = MagicMock()
    scanner.container = "disposable-scanner"
    scanner.manifest = tmp_path / "manifest.json"
    scanner.manifest.write_text(
        runner.json.dumps({"image_digest": "test-image", "signature_hashes": {}})
    )
    scanner._hashes.return_value = {}
    scanner._security.return_value = []
    scanner._sidecar.return_value = {"ready": True}
    launched_environment = {}

    def command(arguments, **kwargs):
        if arguments[0] == "run":
            for index, argument in enumerate(arguments[:-1]):
                if argument == "--env":
                    key, value = arguments[index + 1].split("=", 1)
                    launched_environment[key] = value
        return MagicMock(stdout="test-image" if arguments[0] == "inspect" else "")

    scanner._run.side_effect = command
    _replace_engine(scanner)

    assert launched_environment.get("FILES_CLAMAV_PORT") == "3310"


def test_fullstack_backend_environment_loads_strict_application_settings(tmp_path, monkeypatch):
    """The runner must supply every setting without inheriting a developer's shell."""
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")
    execute = subprocess.run
    configuration_checks = []
    status = {
        "DB_URL": f"postgresql://postgres:{token_urlsafe(32)}@127.0.0.1:55322/postgres",
        "API_URL": runner.AUTH,
        "PUBLISHABLE_KEY": token_urlsafe(32),
        "SECRET_KEY": token_urlsafe(32),
    }

    def disposable_command(command, **kwargs):
        if command[:3] == [sys.executable, "-m", "pytest"]:
            configuration_checks.append(
                execute(
                    [
                        sys.executable,
                        "-c",
                        "from app.core.config import get_settings; get_settings()",
                    ],
                    cwd=runner.ROOT / "backend",
                    env=kwargs["env"],
                    capture_output=True,
                    text=True,
                )
            )
            raise RuntimeError("Stop at the validated backend test boundary")
        output = json.dumps(status) if command[:2] == ["supabase", "status"] else ""
        return subprocess.CompletedProcess(command, 0, stdout=output)

    monkeypatch.setattr(runner.subprocess, "run", disposable_command)
    assert runner.main() == 1
    assert len(configuration_checks) == 1
    assert configuration_checks[0].returncode == 0, configuration_checks[0].stderr


def test_backend_only_runs_suite_and_cleans_stack_without_browser_or_scanner(tmp_path, monkeypatch):
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "BACKEND", tmp_path / "backend")
    commands = []
    coverage = MagicMock()
    monkeypatch.setattr(runner, "run_backend_coverage", coverage)
    scanner = MagicMock()
    monkeypatch.setattr(runner, "DisposableScanner", scanner)

    def command(command, **kwargs):
        commands.append(command)
        status = {
            "DB_URL": "postgresql://postgres:test@127.0.0.1:55322/postgres",
            "API_URL": runner.AUTH, "PUBLISHABLE_KEY": "test", "SECRET_KEY": "test",
        }
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(status))

    monkeypatch.setattr(runner.subprocess, "run", command)
    assert runner.main(["--backend-coverage-only"]) == 0
    coverage.assert_called_once()
    scanner.assert_not_called()
    assert ["supabase", "stop", "--no-backup"] in commands
    assert not any(c[0] in {"npm", "npx"} for c in commands)
    summary = json.loads((tmp_path / "backend/test-results/coverage/summary.json").read_text())
    assert summary["scope"] == "backend-coverage-only"
    assert summary["result"] == "passed"


def test_acceptance_only_runs_real_stack_without_backend_regression_or_coverage(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")
    coverage = MagicMock()
    monkeypatch.setattr(runner, "run_backend_coverage", coverage)
    batches = MagicMock()
    monkeypatch.setattr(runner, "run_backend_batches", batches)
    scanner_class = MagicMock()
    scanner_class.return_value.observations = {"ready": True}
    monkeypatch.setattr(runner, "DisposableScanner", scanner_class)
    identities = MagicMock(return_value={
        "admin": {"email": "admin@example.com", "password": "password", "id": "admin"},
        "member": {"email": "member@example.com", "password": "password", "id": "member"},
    })
    monkeypatch.setattr(runner, "seed", identities)
    monkeypatch.setattr(runner, "wait_for", MagicMock())
    monkeypatch.setattr(runner, "measure_admission", MagicMock(return_value={"recovered": True}))
    recovery = MagicMock()
    monkeypatch.setattr("tests.scanner_recovery.verify_worker_recovery", recovery)
    popen = MagicMock()
    popen.return_value.poll.return_value = 0
    monkeypatch.setattr(runner.subprocess, "Popen", popen)
    coverage_output = runner.BACKEND / "test-results/coverage"
    coverage_output.mkdir(parents=True)
    coverage_evidence = coverage_output / "coverage.json"
    coverage_evidence.write_text('{"coverage": "preserve"}')

    commands = []
    browser_titles = [
        "real login, expiry refresh, identity, logout and boundary enforcement",
        "local capability and disabled-account checks survive real provider sessions",
        "real invitation email callback and password acceptance",
        "schema, record edits and relationship changes persist through the authenticated BFF",
        (
            "workspace revisions, saved queries, CSV authority and automatic private scanning "
            "survive the real stack"
        ),
    ]
    status = {
        "DB_URL": "postgresql://postgres:test@127.0.0.1:55322/postgres",
        "API_URL": runner.AUTH,
        "PUBLISHABLE_KEY": "test-publishable-key",
        "SECRET_KEY": "test-secret-key",
    }

    def command(command, **kwargs):
        commands.append(command)
        if command[:2] == ["supabase", "status"]:
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(status))
        if command and command[0] == "npx":
            for title in browser_titles:
                kwargs["stdout"].write(json.dumps({"test": title, "status": "passed"}) + "\n")
        return subprocess.CompletedProcess(command, 0, stdout="")

    monkeypatch.setattr(runner.subprocess, "run", command)
    assert runner.main(["--acceptance-only"]) == 0

    coverage.assert_not_called()
    batches.assert_not_called()
    scanner_class.return_value.start.assert_called_once()
    scanner_class.return_value.start_worker.assert_called_once()
    scanner_class.return_value.stop.assert_called_once()
    identities.assert_called_once()
    recovery.assert_called_once()
    assert popen.call_count == 2
    assert ["supabase", "start"] in commands
    assert [sys.executable, "-m", "alembic", "upgrade", "head"] in commands
    assert [sys.executable, "-m", "alembic", "check"] in commands
    assert [sys.executable, "scripts/provision_database_role.py", "--confirm"] in commands
    assert ["npm", "run", "build", "--", "--from-process", "--webpack"] in commands
    assert [sys.executable, "scripts/check_operational_health.py"] in commands
    assert ["supabase", "stop", "--no-backup"] in commands
    browser_command = next(command for command in commands if command and command[0] == "npx")
    assert browser_command == [
        "npx", "playwright", "test", "--config=playwright.fullstack.config.ts"
    ]
    assert not any(
        command[0] in {sys.executable, "pytest"} and "pytest" in command
        for command in commands
    )

    summary = json.loads((tmp_path / "frontend/test-results/fullstack-summary.json").read_text())
    assert summary["scope"] == "acceptance-only"
    assert summary["backend_tests_rerun"] is False
    assert summary["result"] == "passed"
    assert [entry["test"] for entry in summary["browser_tests"]] == browser_titles
    assert coverage_evidence.read_text() == '{"coverage": "preserve"}'


@pytest.mark.parametrize(("skipped", "checker_error"), [(0, False), (1, False), (0, True)])
def test_backend_capture_replaces_stale_artifacts_and_rejects_missing_tests(
    tmp_path, monkeypatch, skipped, checker_error
):
    from tests.backend_coverage import run_backend_coverage

    backend, private = tmp_path / "backend", tmp_path / "private"
    (backend / "app").mkdir(parents=True)
    (backend / "app/example.py").write_text("value = 1\n")
    output = backend / "test-results/coverage"
    output.mkdir(parents=True)
    (output / "stale.json").write_text("old run")
    private.mkdir()
    monkeypatch.setattr(subprocess, "check_output", lambda *a, **kw: "revision\n")
    diagnostic = {"passed": False, "error": "Missing coverage comparison base"}
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(
        [], int(checker_error), stdout=json.dumps(diagnostic), stderr=""
    ))

    def run(command, cwd, env):
        if "--cov=app" in command:
            (private / "coverage.json").write_text('{"fresh": true}')
            (private / "pytest.xml").write_text(
                f'<testsuites><testsuite tests="2" failures="0" errors="0" skipped="{skipped}"/>'
                '</testsuites>'
            )

    env = {"TEST_DATABASE_URL": "runtime-private", "MIGRATION_DATABASE_URL": "owner-private"}
    if skipped or checker_error:
        with pytest.raises(RuntimeError, match="complete passing suite"):
            run_backend_coverage(run, backend, private, env, "a" * 32)
    else:
        run_backend_coverage(run, backend, private, env, "a" * 32)
    assert not (output / "stale.json").exists()
    assert json.loads((output / "coverage.json").read_text()) == {"fresh": True}
    metadata = (output / "metadata.json").read_text()
    assert "owner-private" not in metadata and "runtime-private" not in metadata
    assert json.loads(metadata)["test_counts"]["skipped"] == skipped
    if checker_error:
        assert json.loads((output / "gate.json").read_text()) == diagnostic


@pytest.mark.parametrize("stage", ["port_preflight", "startup"])
def test_failed_backend_start_removes_previous_coverage(tmp_path, monkeypatch, stage):
    output = runner.BACKEND / "test-results/coverage"
    output.mkdir(parents=True)
    for name in ("coverage.json", "gate.json", "metadata.json"):
        (output / name).write_text('{"passed": true}')
    listener = MagicMock()
    if stage == "port_preflight":
        listener.__enter__.return_value.bind.side_effect = OSError("Port occupied")
    monkeypatch.setattr(runner.socket, "socket", lambda: listener)
    monkeypatch.setattr(
        runner.subprocess, "run", MagicMock(side_effect=RuntimeError("Startup failed"))
    )
    assert runner.main(["--backend-coverage-only"]) == 1
    assert not any((output / name).exists() for name in (
        "coverage.json", "gate.json", "metadata.json"
    ))


def test_backend_batch_reuses_stack_and_keeps_coverage_reports(tmp_path, monkeypatch):
    (runner.BACKEND / "tests").mkdir()
    (runner.BACKEND / "tests/test_sample.py").write_text("def test_sample(): pass\n")
    output = runner.BACKEND / "test-results/coverage"
    output.mkdir(parents=True)
    (output / "gate.json").write_text("prior coverage")
    monkeypatch.setattr(runner.socket, "socket", MagicMock())
    responses = iter(["", "quit"])
    monkeypatch.setattr("builtins.input", lambda _: next(responses))
    commands, manifests = [], []

    def command(command, **kwargs):
        commands.append(command)
        status = {"DB_URL": "postgresql://postgres:test@127.0.0.1:55322/postgres",
                  "API_URL": runner.AUTH, "PUBLISHABLE_KEY": "test", "SECRET_KEY": "test"}
        if command[1:3] == ["-m", "pytest"]:
            env = kwargs["env"]
            manifest = Path(env["OPENSLATE_TEST_DATABASE_MANIFEST"])
            manifests.append(json.loads(manifest.read_text()))
            assert manifest.stat().st_mode & 0o077 == 0
            assert env["OPENSLATE_REQUIRE_DATABASE_TESTS"] == "true"
            assert "--no-cov" in command and "-x" in command
            assert command[-1] == "tests/test_sample.py"
            junit = next(arg.split("=", 1)[1] for arg in command if arg.startswith("--junitxml="))
            Path(junit).write_text(
                '<testsuites><testsuite tests="1" failures="0" errors="0" skipped="0"/>'
                '</testsuites>'
            )
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(status))

    monkeypatch.setattr(runner.subprocess, "run", command)
    assert runner.main(["--backend-batch", "--interactive", "tests/test_sample.py"]) == 0
    assert commands.count(["supabase", "start"]) == 1
    assert commands.count(["supabase", "stop", "--no-backup"]) == 1
    assert len(manifests) == 2 and manifests[0] == manifests[1]
    assert (output / "gate.json").read_text() == "prior coverage"
    assert not any(c[0] in {"npm", "npx"} or "--cov=app" in c for c in commands)


@pytest.mark.parametrize("outcome", ["failure", "skip", "empty", "missing"])
def test_batch_cannot_pass_with_incomplete_results(tmp_path, outcome):
    from tests.backend_batches import run_backend_batches

    private = tmp_path / "private"
    private.mkdir()
    env = {"TEST_DATABASE_URL": "private-runtime", "MIGRATION_DATABASE_URL": "private-owner"}

    def run(command, cwd, environment):
        if outcome != "missing":
            (private / "pytest.xml").write_text(
                f'<testsuite tests="{0 if outcome == "empty" else 1}" '
                f'failures="{int(outcome == "failure")}" errors="0" '
                f'skipped="{int(outcome == "skip")}"/>'
            )
        if outcome == "failure":
            raise subprocess.CalledProcessError(1, command)

    assert run_backend_batches(run, tmp_path, private, env, "run", {
        "targets": ["tests/test_sample.py"], "interactive": False,
    }) == 1
    report = (tmp_path / "test-results/batches/run.json").read_text()
    assert "private-runtime" not in report and "private-owner" not in report


def test_warm_batch_requires_restart_after_setup_changes(tmp_path, monkeypatch):
    from tests.backend_batches import run_backend_batches

    private = tmp_path / "private"
    private.mkdir()
    dependency = tmp_path / "uv.lock"
    dependency.write_text("before")
    calls = []

    def run(*args):
        calls.append(args)
        (private / "pytest.xml").write_text('<testsuite tests="1"/>')

    def next_batch(_):
        dependency.write_text("changed")
        return ""

    monkeypatch.setattr("builtins.input", next_batch)
    with pytest.raises(RuntimeError, match="start a fresh"):
        run_backend_batches(run, tmp_path, private, {
            "TEST_DATABASE_URL": "runtime", "MIGRATION_DATABASE_URL": "owner",
        }, "run", {"targets": ["tests/test_sample.py"], "interactive": True})
    assert len(calls) == 1


@pytest.mark.parametrize("target", ["tests", "../outside.py", "--no-cov", "tests/missing.py"])
def test_batch_rejects_full_suite_and_invalid_targets_before_startup(tmp_path, monkeypatch, target):
    command = MagicMock()
    monkeypatch.setattr(runner.subprocess, "run", command)
    with pytest.raises(SystemExit):
        runner.main(["--backend-batch", target])
    command.assert_not_called()



def test_successful_narrow_rerun_does_not_clear_a_failed_batch(tmp_path, monkeypatch):
    from tests.backend_batches import run_backend_batches

    private = tmp_path / "private"
    private.mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests/test_sample.py").touch()
    answers = iter(["tests/test_sample.py::test_one", "quit"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    calls = []

    def run(command, cwd, env):
        calls.append(command)
        failed = len(calls) == 1
        (private / "pytest.xml").write_text(
            f'<testsuite tests="1" failures="{int(failed)}"/>'
        )
        if failed:
            raise subprocess.CalledProcessError(1, command)

    assert run_backend_batches(run, tmp_path, private, {
        "TEST_DATABASE_URL": "runtime", "MIGRATION_DATABASE_URL": "owner",
    }, "run", {"targets": ["tests/test_sample.py"], "interactive": True}) == 1
    assert len(calls) == 2


def test_scanner_build_preserves_buildx_without_personal_docker_configuration(
    tmp_path, monkeypatch,
):
    home = tmp_path / "installer"
    plugin = home / ".docker/cli-plugins/docker-buildx"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("installed build plugin")
    (home / ".docker/config.json").write_text(PRIVATE_FILE_CANARY)
    monkeypatch.setenv("HOME", str(home))
    private = tmp_path / "private"
    private.mkdir()
    with (private / "build.log").open("w") as log:
        scanner = runner.DisposableScanner(
            runner.ROOT, private, "a" * 32, {"HOME": str(private / "home")}, log,
        )
        monkeypatch.setattr(scanner, "_run", MagicMock())
        scanner._build()
    installed = private / "home/.docker/cli-plugins/docker-buildx"
    assert installed.is_symlink() and installed.resolve() == plugin.resolve()
    assert not (private / "home/.docker/config.json").exists()
