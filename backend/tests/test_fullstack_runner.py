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
                    cwd=kwargs["cwd"],
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
