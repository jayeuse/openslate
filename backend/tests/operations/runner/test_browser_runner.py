"""Narrow browser repair runs retain owned infrastructure without the backend suite."""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests import fullstack_runner as runner
from tests.operations.runner.test_fullstack_runner import _stub_fullstack_prerequisites
from tests.runner_console import run_streamed


def _browser_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, browser_exit: int):
    commands = []
    popen = subprocess.Popen

    def execute(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "")

    _stub_fullstack_prerequisites(monkeypatch, tmp_path, execute)

    def stream(command, cwd, env, log, *, capture=False, shown=None):
        if command[:3] != ["npx", "playwright", "test"]:
            return execute(command, cwd=cwd, env=env)
        commands.append(command)
        lines = [
            "  ✓  1 [chromium] › fullstack/auth-session.spec.ts:9:5 › login journey (1.2s)"
        ]
        if browser_exit:
            lines.append(
                "  ✘  2 [chromium] › fullstack/auth-session.spec.ts:20:5 › recovery journey (3.0s)"
            )
        script = ";".join(f"print({line!r})" for line in lines)
        script += f";raise SystemExit({browser_exit})"
        return run_streamed([sys.executable, "-c", script], tmp_path, env, log, shown=shown)

    monkeypatch.setattr(runner, "run_streamed", stream)
    backend = MagicMock(side_effect=AssertionError("backend suite must not run"))
    monkeypatch.setattr(runner, "run_backend_coverage", backend)
    process = MagicMock()
    process.poll.return_value = None

    def start(command, **kwargs):
        return popen(command, **kwargs) if command[1] == "-c" else process

    monkeypatch.setattr(runner.subprocess, "Popen", start)
    monkeypatch.setattr(runner.os, "killpg", MagicMock())
    gateway = MagicMock()
    monkeypatch.setattr(runner, "DisposableCaddy", lambda *_args: gateway)
    monkeypatch.setattr(runner, "wait_for", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "measure_admission", lambda: {"recovered": True})
    monkeypatch.setenv("CI", "true")
    return commands, backend, process, gateway


def test_browser_only_owns_provider_api_gateway_but_does_not_run_backend_suite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands, backend, process, gateway = _browser_runtime(monkeypatch, tmp_path, 0)

    assert runner.main(("--browser-only",)) == 0
    backend.assert_not_called()
    gateway.start.assert_called_once()
    gateway.stop.assert_called_once()
    browser_commands = [
        command for command in commands if command[:3] == ["npx", "playwright", "test"]
    ]
    assert browser_commands == [
        [
            "npx",
            "playwright",
            "test",
            "--config=playwright.fullstack.config.ts",
            "--reporter=list",
            "tests/fullstack/auth-session.spec.ts",
        ]
    ]
    report = json.loads((tmp_path / "frontend/test-results/fullstack-summary.json").read_text())
    assert report["scope"] == "browser-only"
    assert report["backend_tests_rerun"] is False
    assert report["browser_completed"] is True
    assert report["browser_tests"] == [
        {
            "status": "passed",
            "location": "fullstack/auth-session.spec.ts:9:5",
            "title": "login journey",
            "duration": "1.2s",
        }
    ]
    assert set(report.get("stage_seconds", {})) == {
        "prepare",
        "PostgreSQL startup",
        "database role bootstrap",
        "migrations",
        "private Storage initialization",
        "dedicated identities",
        "static frontend build",
        "FastAPI startup",
        "bounded admission and recovery",
        "Caddy gateway startup",
        "browser acceptance",
    }
    process.wait.assert_called_once()


def test_failed_browser_command_retains_partial_results_and_cleans_owned_processes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _commands, backend, process, gateway = _browser_runtime(monkeypatch, tmp_path, 3)

    assert runner.main(("--browser-only",)) == 1

    report = json.loads((tmp_path / "frontend/test-results/fullstack-summary.json").read_text())
    assert report["result"] == "failed"
    assert report["stage"] == "browser acceptance"
    assert report["browser_completed"] is False
    assert report["failure_type"] == "CalledProcessError"
    assert report["browser_tests"] == [
        {
            "status": "passed",
            "location": "fullstack/auth-session.spec.ts:9:5",
            "title": "login journey",
            "duration": "1.2s",
        },
        {
            "status": "failed",
            "location": "fullstack/auth-session.spec.ts:20:5",
            "title": "recovery journey",
            "duration": "3.0s",
        },
    ]
    assert report.get("stage_seconds", {}).get("browser acceptance", -1) >= 0
    assert "read-only operational checker" not in report["stage_seconds"]
    backend.assert_not_called()
    gateway.stop.assert_called_once()
    process.wait.assert_called_once()
