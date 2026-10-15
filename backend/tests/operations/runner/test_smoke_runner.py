"""Smoke prerequisite overlap, failure propagation, and owned cleanup.

Only external command/provider boundaries are synthetic. The smoke orchestration,
run_streamed, api_environment, and process-group stop implementation remain real.
"""

import io
import json
import signal
import subprocess
import sys
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from tests import runner_console
from tests import smoke_runner as runner

BUILD = ["npm", "run", "build", "--", "--webpack"]
# The existing runner_console subprocess tests use 30 s for startup/join safety.
# This is a deadlock watchdog, not a scheduling delay or a product timeout.
WATCHDOG_SECONDS = 30


class _ReachedAPI(RuntimeError):
    """End the test at the first API launch, before any sample or browser work."""


class _Build:
    """An npm command with a controlled exit and a descendant in its own group."""

    pid = 4242

    def __init__(self) -> None:
        self.finished = Event()
        self.returncode: int | None = None
        self.descendant_alive = True
        self.reaped = False
        self.output_closed = False
        self.piped = False
        self.stdout = self

    def finish(self, code: int) -> None:
        if not self.finished.is_set():
            self.returncode = code
            self.descendant_alive = code != 0
            self.finished.set()

    def __iter__(self):
        self.finished.wait()
        return iter([f"synthetic build exit {self.returncode}\n"])

    def close(self) -> None:
        self.output_closed = True

    def poll(self) -> int | None:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if not self.finished.wait(timeout):
            raise subprocess.TimeoutExpired(BUILD, timeout)
        self.reaped = True
        assert self.returncode is not None
        return self.returncode


def _wait(event: Event, message: str) -> None:
    assert event.wait(WATCHDOG_SECONDS), message


@pytest.fixture
def smoke_boundary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    state = SimpleNamespace(
        build=_Build(),
        build_started=Event(),
        startup_entered=Event(),
        release_startup=Event(),
        provisioned=Event(),
        api_started=Event(),
        stopped=Event(),
        fault=None,
        cleanup_fails=False,
        clock=100.0,
        thread=None,
        returned=None,
        raised=None,
        build_env=None,
        base_env=None,
        api_env=None,
        log=None,
        cleanup_state=None,
        commands=[],
    )
    monkeypatch.setattr(runner, "BACKEND", tmp_path / "backend")
    monkeypatch.setattr(runner, "FRONTEND", tmp_path / "frontend")
    monkeypatch.setattr(runner, "SUMMARY", tmp_path / "summary.json")
    monkeypatch.setattr(runner, "stop_on_signals", lambda: None)
    monkeypatch.setattr(runner.socket, "socket", lambda: MagicMock())
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: str(private))
    # Do not replace time.monotonic globally: thread/process-stop watchdogs stay real.
    monkeypatch.setattr(runner, "time", SimpleNamespace(monotonic=lambda: state.clock))
    monkeypatch.setenv("DATABASE_BOOTSTRAP_URL", "synthetic-ambient-bootstrap")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "synthetic-ambient-provider")

    def start_stack() -> None:
        state.startup_entered.set()
        state.release_startup.wait()
        if state.fault == "startup":
            raise OSError("synthetic owned-stack startup failure")
        if state.fault == "interrupt":
            raise KeyboardInterrupt("synthetic startup interrupt")

    def stop_stack() -> None:
        state.cleanup_state = (
            state.build.reaped,
            state.build.descendant_alive,
            state.log.closed,
            state.build.output_closed if state.build.piped else True,
        )
        state.stopped.set()
        state.clock += 30.0  # Teardown must not be charged to prerequisite timings.
        if state.cleanup_fails:
            raise RuntimeError("synthetic owned-stack cleanup failure")

    def postgres(root, run_id, env, log, **_kwargs):
        state.base_env = dict(env)
        state.log = log
        manifest = root / "database.json"
        manifest.write_text("{}", encoding="utf-8")
        manifest.chmod(0o600)
        provider = MagicMock()
        provider.start.side_effect = start_stack
        provider.stop.side_effect = stop_stack
        provider.urls.return_value = {
            "DATABASE_BOOTSTRAP_URL": "synthetic-bootstrap",
            "MIGRATION_DATABASE_URL": "synthetic-owner",
            "DATABASE_URL": "synthetic-runtime",
        }
        provider.provider_environment.return_value = {
            "SUPABASE_URL": "http://127.0.0.1:58999",
            "SUPABASE_AUTH_ISSUER": "http://127.0.0.1:58999/auth/v1",
            "SUPABASE_SECRET_KEY": "synthetic-provider",
            "SUPABASE_SESSION_ENCRYPTION_KEY": "synthetic-session",
        }
        provider.write_manifest.return_value = manifest
        return provider

    def popen(command, **kwargs):
        if command == BUILD:
            assert kwargs.get("start_new_session") is True
            state.build_env = dict(kwargs["env"])
            state.build.piped = kwargs.get("stdout") == subprocess.PIPE
            state.build_started.set()
            return state.build
        if "uvicorn" in command:
            state.api_started.set()
            assert state.build.finished.is_set(), "API started before the build finished"
            assert state.build.returncode == 0, "API started with a failed build"
            assert state.provisioned.is_set(), "API started before provisioning completed"
            state.api_env = dict(kwargs["env"])
            raise _ReachedAPI("both prerequisites reached the API boundary")
        state.commands.append(command)
        assert command in [
            [sys.executable, "operations/provision_database_role.py", "--confirm"],
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            [sys.executable, "operations/provision_storage.py", "--confirm"],
        ], f"unexpected external command: {command}"
        if "operations/provision_storage.py" in command:
            if not state.build.finished.is_set():
                assert "WEB_ASSETS_ROOT" not in kwargs["env"]
            if state.fault == "provision":
                raise RuntimeError("synthetic Storage provisioning failure")
        process = MagicMock()
        process.stdout = io.StringIO("")
        process.returncode = 0
        process.poll.return_value = 0
        process.wait.return_value = 0
        return process

    def seed(_owner_url, _run_id, _env, *, roles):
        assert roles == ("admin",)
        assert [sys.executable, "operations/provision_storage.py", "--confirm"] in state.commands
        state.provisioned.set()
        return {
            "admin": {
                "id": "synthetic-admin",
                "email": "admin@example.test",
                "password": "test",
            }
        }

    def checked_run(command, **_kwargs):
        assert command == ["git", "rev-parse", "HEAD"]
        return subprocess.CompletedProcess(command, 0, "synthetic-revision\n")

    def signal_group(group: int, number: int) -> None:
        assert group == state.build.pid
        state.build.finish(-number)
        if number == signal.SIGKILL:
            state.build.descendant_alive = False

    monkeypatch.setattr(runner, "DisposablePostgres", postgres)
    monkeypatch.setattr(runner, "seed", seed)
    monkeypatch.setattr(runner.subprocess, "Popen", popen)
    monkeypatch.setattr(runner.subprocess, "run", checked_run)
    monkeypatch.setattr(runner_console.os, "killpg", signal_group)

    def invoke() -> None:
        try:
            state.returned = runner.main()
        except BaseException as error:
            state.raised = error

    def launch() -> None:
        state.thread = Thread(target=invoke, daemon=True)
        state.thread.start()

    state.launch = launch
    yield state
    # Release every owned barrier even when the old serial behavior causes a red.
    state.release_startup.set()
    state.build.finish(0)
    if state.thread is not None:
        state.thread.join(WATCHDOG_SECONDS)
        assert not state.thread.is_alive(), "test-owned runner did not exit"


def _joined(state) -> dict[str, object]:
    state.thread.join(WATCHDOG_SECONDS)
    assert not state.thread.is_alive(), "runner did not await/cancel the pending build"
    assert state.stopped.is_set(), "owned stack was not cleaned"
    assert state.cleanup_state == (True, False, False, True), (
        "build leader, descendants, and piped output must end before stack/log teardown"
    )
    assert state.log.closed
    if state.build_env is not None:
        assert state.build_env == state.base_env, "frontend received non-base credentials"
    return json.loads(runner.SUMMARY.read_text(encoding="utf-8"))


@pytest.mark.parametrize("first_ready", ["build", "provision"])
def test_smoke_overlaps_build_with_startup_and_waits_for_both_prerequisites(
    smoke_boundary, first_ready: str
) -> None:
    state = smoke_boundary
    state.launch()
    _wait(state.startup_entered, "owned-stack startup did not begin")
    _wait(state.build_started, "build did not start while owned-stack startup was blocked")
    assert not state.release_startup.is_set()
    assert not state.api_started.is_set()
    state.clock = 102.0
    if first_ready == "build":
        state.build.finish(0)
        assert not state.provisioned.is_set()
    else:
        state.release_startup.set()
        _wait(state.provisioned, "provisioning did not finish while the build was blocked")
        assert not state.build.finished.is_set()
    assert not state.api_started.is_set()
    state.clock = 107.0
    state.release_startup.set()
    state.build.finish(0)
    report = _joined(state)

    assert state.raised is None
    assert state.returned == 1  # The intentional API-boundary sentinel, not a smoke pass.
    assert state.api_started.is_set()
    assert report["failure_type"] == "_ReachedAPI"
    assert state.api_env["WEB_ASSETS_ROOT"] == str(runner.FRONTEND / "out")
    assert "DATABASE_BOOTSTRAP_URL" not in state.api_env
    assert "MIGRATION_DATABASE_URL" not in state.api_env
    assert state.api_env["E2E_BACKGROUND_WORKERS"] == "true"
    assert state.api_env["E2E_SEEDING_WITHOUT_ANONYMOUS_LIMITS"] == "true"
    assert sum(report["stage_seconds"].values()) == 7.0, (
        "serial stage accounting double-counted overlap or included teardown"
    )


@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_smoke_preserves_build_failure_during_startup_and_cleans_the_owned_stack(
    smoke_boundary, cleanup_fails: bool
) -> None:
    state = smoke_boundary
    state.cleanup_fails = cleanup_fails
    state.launch()
    _wait(state.startup_entered, "owned-stack startup did not begin")
    _wait(state.build_started, "build did not start while owned-stack startup was blocked")
    state.build.finish(17)  # The exited leader still has a live descendant.
    assert not state.release_startup.is_set()
    state.release_startup.set()
    report = _joined(state)

    assert state.raised is None
    assert state.returned == 1
    assert not state.api_started.is_set()
    assert report["result"] == "failed"
    assert report["failure_type"] == "CalledProcessError"
    assert state.build.returncode == 17


@pytest.mark.parametrize("fault", ["startup", "provision", "interrupt"])
def test_smoke_cancels_and_awaits_the_build_when_the_stack_side_fails(
    smoke_boundary, fault: str
) -> None:
    state = smoke_boundary
    state.fault = fault
    state.launch()
    _wait(state.startup_entered, "owned-stack startup did not begin")
    _wait(state.build_started, "build did not start while owned-stack startup was blocked")
    assert not state.build.finished.is_set()
    state.release_startup.set()
    report = _joined(state)

    assert not state.api_started.is_set()
    assert state.build.returncode in (-signal.SIGTERM, -signal.SIGKILL)
    assert report["result"] == "failed"
    if fault == "interrupt":
        assert state.returned is None
        assert isinstance(state.raised, KeyboardInterrupt)
        assert str(state.raised) == "synthetic startup interrupt"
    else:
        assert state.raised is None
        assert state.returned == 1
        assert report["failure_type"] == ("OSError" if fault == "startup" else "RuntimeError")
