"""Terminal progress and stop handling for the disposable-stack test runners."""

import io
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from tests import runner_console
from tests.runner_console import e2e_browser_flags, progress_line, relay, run_streamed


def test_pytest_results_reach_the_terminal_as_one_short_line_each() -> None:
    assert (
        progress_line("tests/auth/test_login.py::test_lockout PASSED          [ 12%]\n")
        == " 12% PASSED  tests/auth/test_login.py::test_lockout"
    )
    assert (
        progress_line("tests/a.py::test_b[x y] FAILED [100%]")
        == "100% FAILED  tests/a.py::test_b[x y]"
    )
    assert progress_line("========= 3 passed, 1 skipped in 4.20s =========") is not None


def test_a_huge_parametrized_id_is_shortened_and_keeps_its_outcome() -> None:
    line = progress_line(f"tests/files/test_routes.py::test_id[{'x' * 26_000_000}] PASSED [  3%]")

    assert line is not None and line.startswith("  3% PASSED  tests/files/test_routes.py")
    assert len(line) < 160


@pytest.mark.parametrize(
    "line",
    [
        "postgresql://openslate_runtime:synthetic-password@127.0.0.1:5432/postgres",
        "E   AssertionError: assert 'synthetic-secret' == 'other'",
        " Container openslate-e2e-abc-db-1  Started",
        "tests/auth/test_login.py ....F.....                                  [ 12%]",
    ],
)
def test_other_output_stays_in_the_private_log(line: str) -> None:
    assert progress_line(line) is None


def test_playwright_list_results_and_totals_reach_the_terminal() -> None:
    assert progress_line("  ✓  3 [chromium] › smoke/records.spec.ts:9:5 › opens a record (1.2s)")
    assert progress_line("  ✘  4 [chromium] › smoke/boards.spec.ts:7:5 › posts (3.0s)")
    assert progress_line("  16 passed (23.5s)")


@pytest.mark.parametrize(
    ("progress", "shown"), [(None, ""), ("1", "100% PASSED  tests/a.py::test_b\n")]
)
def test_a_streamed_command_is_quiet_unless_progress_is_requested(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    progress: str | None,
    shown: str,
) -> None:
    # Drawing thousands of result lines slowed the machine, so runs are quiet by default.
    if progress is None:
        monkeypatch.delenv("OPENSLATE_TEST_PROGRESS", raising=False)
    else:
        monkeypatch.setenv("OPENSLATE_TEST_PROGRESS", progress)
    script = "print('secret=synthetic'); print('tests/a.py::test_b PASSED [100%]')"
    with (tmp_path / "process.log").open("w") as log:
        run_streamed([sys.executable, "-c", script], tmp_path, dict(os.environ), log)

    assert capsys.readouterr().out == shown
    assert "secret=synthetic" in (tmp_path / "process.log").read_text()


def test_a_failed_streamed_command_raises_like_a_checked_run(tmp_path: Path) -> None:
    with (
        (tmp_path / "process.log").open("w") as log,
        pytest.raises(subprocess.CalledProcessError) as failure,
    ):
        run_streamed([sys.executable, "-c", "raise SystemExit(3)"], tmp_path, {}, log)

    assert failure.value.returncode == 3


def test_e2e_browsers_are_headless_unless_requested_and_always_headless_in_ci(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("OPENSLATE_E2E_HEADED", raising=False)
    assert e2e_browser_flags() == ["--reporter=list"]
    monkeypatch.setenv("OPENSLATE_E2E_HEADED", "1")
    assert e2e_browser_flags() == ["--reporter=list", "--headed"]
    monkeypatch.setenv("CI", "true")
    assert e2e_browser_flags() == ["--reporter=list"]


def test_a_stopped_runner_still_runs_its_cleanup() -> None:
    # TaskStop and `kill` send SIGTERM; Python's default action skipped every finally
    # block, so the disposable Supabase stack kept running.
    saved = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGHUP)}
    cleaned = []
    try:
        runner_console.stop_on_signals()

        def terminate_with_cleanup() -> None:
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            finally:
                cleaned.append(True)

        with pytest.raises(KeyboardInterrupt):
            terminate_with_cleanup()
        assert signal.getsignal(signal.SIGTERM) == signal.SIG_IGN
    finally:
        for number, handler in saved.items():
            signal.signal(number, handler)
    assert cleaned == [True]


def test_a_shard_line_is_logged_and_shown_with_its_shard_name(
    capsys: pytest.CaptureFixture[str],
) -> None:
    log = io.StringIO()

    relay(io.StringIO(" 50% PASSED  tests/a.py::test_b\n"), log, "[2/3]")

    # Each line carries its wall-clock time so shard stage durations can be read back.
    assert re.fullmatch(r"\d\d:\d\d:\d\d  50% PASSED  tests/a.py::test_b\n", log.getvalue())
    assert re.fullmatch(
        r"\[2/3\] \d\d:\d\d:\d\d  50% PASSED  tests/a.py::test_b\n", capsys.readouterr().out
    )


class _Installed(Exception):
    pass


def _refuse_to_continue() -> None:
    raise _Installed


@pytest.mark.parametrize(
    ("module", "arguments"),
    [("fullstack_runner", (["--backend-coverage-only"],)), ("smoke_runner", ())],
)
def test_each_runner_handles_a_stop_before_it_changes_anything(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, module: str, arguments: tuple[list[str], ...]
) -> None:
    # CI coverage shard 3/5: this test reached the runner's output cleanup before the stop
    # handling, removed the shard's own test-results/coverage, and the shard then failed
    # with FileNotFoundError.
    runner = __import__(f"tests.{module}", fromlist=["main"])
    output = tmp_path / "test-results/coverage"
    output.mkdir(parents=True)
    monkeypatch.setattr(runner, "BACKEND", tmp_path)
    monkeypatch.setattr(runner, "stop_on_signals", _refuse_to_continue)
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: pytest.fail("stack started"))

    with pytest.raises(_Installed):
        runner.main(*arguments)
    assert output.is_dir()


def test_parallel_coverage_handles_a_stop_before_it_starts_shards(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests import parallel_coverage

    monkeypatch.setattr(parallel_coverage, "stop_on_signals", _refuse_to_continue)
    monkeypatch.setattr(
        parallel_coverage.subprocess, "Popen", lambda *_, **__: pytest.fail("shard started")
    )

    with pytest.raises(_Installed):
        parallel_coverage.main([])


_RUNNER = """
import sys
from pathlib import Path
from tests.runner_console import run_streamed, stop_on_signals

pids, cleaned = Path(sys.argv[1]), Path(sys.argv[2])
child = (
    "import os, subprocess, sys, time; "
    "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)']); "
    f"open({str(pids)!r}, 'w').write(f'{{os.getpid()}} {{grandchild.pid}}'); "
    "time.sleep(120)"
)
stop_on_signals()
try:
    with (pids.parent / "process.log").open("w") as log:
        run_streamed([sys.executable, "-c", child], pids.parent, {}, log)
finally:
    cleaned.write_text("cleanup ran")
"""


def _gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


def test_a_stopped_runner_stops_its_command_and_what_the_command_started(
    tmp_path: Path,
) -> None:
    # Review finding 1: an interrupted run_streamed left pytest or npm running while
    # the runner removed the services they used.
    import time

    pids, cleaned = tmp_path / "pids", tmp_path / "cleaned"
    runner = subprocess.Popen(
        [sys.executable, "-c", _RUNNER, str(pids), str(cleaned)],
        cwd=Path(__file__).resolve().parents[3],
    )
    children: list[int] = []
    try:
        deadline = time.monotonic() + 30
        while not (pids.exists() and pids.read_text().count(" ") == 1):
            assert time.monotonic() < deadline, "the command did not start"
            assert runner.poll() is None, "the runner ended early"
            time.sleep(0.05)
        children = [int(pid) for pid in pids.read_text().split()]
        runner.send_signal(signal.SIGTERM)
        runner.wait(timeout=30)
        assert cleaned.read_text() == "cleanup ran"
        deadline = time.monotonic() + 10
        while not all(_gone(pid) for pid in children):
            assert time.monotonic() < deadline, f"still running: {children}"
            time.sleep(0.05)
    finally:
        for pid in children:
            if not _gone(pid):
                os.kill(pid, signal.SIGKILL)
        if runner.poll() is None:
            runner.kill()


class _Group:
    """A process double whose group can end at any step."""

    def __init__(self, *, exited: bool = False, waits: int = 0) -> None:
        self.pid, self.exited, self.timeouts = 4242, exited, waits

    def poll(self) -> int | None:
        return 0 if self.exited else None

    def wait(self, timeout: float | None = None) -> int:
        if self.timeouts and timeout is not None:
            self.timeouts -= 1
            raise subprocess.TimeoutExpired("api", timeout)
        return 0


@pytest.mark.parametrize(
    ("group", "missing_from", "signals"),
    [
        (_Group(exited=True), 0, [signal.SIGTERM, signal.SIGKILL]),
        (_Group(), 1, [signal.SIGTERM, signal.SIGKILL]),
        (_Group(waits=1), 9, [signal.SIGTERM, signal.SIGKILL, signal.SIGKILL]),
        (_Group(waits=1), 2, [signal.SIGTERM, signal.SIGKILL, signal.SIGKILL]),
    ],
    ids=["already-exited", "gone-before-term", "timeout-then-kill", "gone-before-kill"],
)
def test_a_group_that_ends_during_a_stop_counts_as_stopped(
    monkeypatch: pytest.MonkeyPatch, group: _Group, missing_from: int, signals: list[int]
) -> None:
    # Review finding 2: a group that ended between poll() and SIGTERM raised
    # ProcessLookupError from the SIGKILL fallback and skipped the smoke cleanup.
    sent: list[int] = []

    def killpg(_group: int, number: int) -> None:
        sent.append(number)
        if missing_from and len(sent) >= missing_from:
            raise ProcessLookupError

    monkeypatch.setattr(runner_console.os, "killpg", killpg)

    runner_console.stop_process_group(group)  # type: ignore[arg-type]

    assert sent == signals


_LEADER = """
import subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
open(sys.argv[1], "w").write(str(child.pid))
"""


def test_a_stop_reaches_what_an_exited_leader_left_running(tmp_path: Path) -> None:
    # Review finding 4: stop_process_group returned once the leader had exited, so a
    # child still holding the output pipe kept running.
    import time

    pid_file = tmp_path / "child"
    leader = subprocess.Popen(
        [sys.executable, "-c", _LEADER, str(pid_file)], start_new_session=True
    )
    child = 0
    try:
        leader.wait(timeout=30)
        child = int(pid_file.read_text())
        assert not _gone(child), "the child ended before the stop"

        runner_console.stop_process_group(leader, timeout=5)

        deadline = time.monotonic() + 10
        while not _gone(child):
            assert time.monotonic() < deadline, f"still running: {child}"
            time.sleep(0.05)
    finally:
        try:
            os.killpg(leader.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_smoke_evidence_keeps_each_test_outcome_without_other_output(tmp_path: Path) -> None:
    # Review finding 7: a passing smoke run deleted its private log and kept no
    # per-test outcome.
    script = (
        "print('  ✓  1 [chromium] › smoke/records.spec.ts:9:5 › opens a record @records (1.2s)');"
        "print('fill password synthetic-secret');"
        "print('  ✘  2 [chromium] › smoke/boards.spec.ts:7:5 › posts (3.0s)');"
        "print('  -  3 [chromium] › smoke/manage.spec.ts:4:5 › skipped case')"
    )
    shown: list[str] = []
    with (tmp_path / "process.log").open("w") as log:
        run_streamed([sys.executable, "-c", script], tmp_path, dict(os.environ), log, shown=shown)

    assert runner_console.playwright_results(shown) == [
        {
            "status": "passed",
            "location": "smoke/records.spec.ts:9:5",
            "title": "opens a record @records",
            "duration": "1.2s",
        },
        {
            "status": "failed",
            "location": "smoke/boards.spec.ts:7:5",
            "title": "posts",
            "duration": "3.0s",
        },
        {
            "status": "skipped",
            "location": "smoke/manage.spec.ts:4:5",
            "title": "skipped case",
            "duration": None,
        },
    ]
    assert "synthetic-secret" not in "".join(shown)
