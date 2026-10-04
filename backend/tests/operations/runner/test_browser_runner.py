"""Narrow browser repair runs retain owned infrastructure without scanner claims."""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests import fullstack_runner as runner
from tests.operations.runner.test_fullstack_runner import _stub_fullstack_prerequisites


def test_browser_only_owns_provider_api_gateway_but_does_not_run_scanner_or_backend_suite(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands = []

    def execute(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, 0, "")

    scanner = _stub_fullstack_prerequisites(monkeypatch, tmp_path, execute)
    backend = MagicMock(side_effect=AssertionError("backend suite must not run"))
    monkeypatch.setattr(runner, "run_backend_coverage", backend)
    process = MagicMock()
    process.poll.return_value = None
    monkeypatch.setattr(runner.subprocess, "Popen", lambda *_args, **_kwargs: process)
    monkeypatch.setattr(runner.os, "killpg", MagicMock())
    gateway = MagicMock()
    monkeypatch.setattr(runner, "DisposableCaddy", lambda *_args: gateway)
    monkeypatch.setattr(runner, "wait_for", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "measure_admission", lambda: {"recovered": True})
    monkeypatch.setenv("CI", "true")

    assert runner.main(("--browser-only",)) == 0
    scanner.start.assert_not_called()
    scanner.start_worker.assert_not_called()
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
    assert report["scanner_observations"] == {}
    assert report["browser_completed"] is True
