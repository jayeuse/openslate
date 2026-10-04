"""Terminal progress and stop handling for the disposable-stack test runners."""

import io
import os
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
    line = progress_line(f"tests/files/test_clamav.py::test_id[{'x' * 26_000_000}] PASSED [  3%]")

    assert line is not None and line.startswith("  3% PASSED  tests/files/test_clamav.py")
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


def test_a_streamed_command_logs_everything_and_shows_only_results(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    script = "print('secret=synthetic'); print('tests/a.py::test_b PASSED [100%]')"
    with (tmp_path / "process.log").open("w") as log:
        run_streamed([sys.executable, "-c", script], tmp_path, dict(os.environ), log)

    assert capsys.readouterr().out == "100% PASSED  tests/a.py::test_b\n"
    assert "secret=synthetic" in (tmp_path / "process.log").read_text()


def test_a_failed_streamed_command_raises_like_a_checked_run(tmp_path: Path) -> None:
    with (
        (tmp_path / "process.log").open("w") as log,
        pytest.raises(subprocess.CalledProcessError) as failure,
    ):
        run_streamed([sys.executable, "-c", "raise SystemExit(3)"], tmp_path, {}, log)

    assert failure.value.returncode == 3


def test_e2e_browsers_are_visible_locally_and_headless_in_ci(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("OPENSLATE_E2E_HEADED", raising=False)
    assert e2e_browser_flags() == ["--reporter=list", "--headed"]
    monkeypatch.setenv("OPENSLATE_E2E_HEADED", "0")
    assert e2e_browser_flags() == ["--reporter=list"]
    monkeypatch.delenv("OPENSLATE_E2E_HEADED")
    monkeypatch.setenv("CI", "true")
    assert e2e_browser_flags() == ["--reporter=list"]


def test_a_stopped_runner_still_runs_its_cleanup() -> None:
    # TaskStop and `kill` send SIGTERM; Python's default action skipped every finally
    # block, so the disposable Supabase stack and scanner kept running.
    saved = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGHUP)}
    cleaned = []
    try:
        runner_console.stop_on_signals()
        with pytest.raises(KeyboardInterrupt):
            try:
                os.kill(os.getpid(), signal.SIGTERM)
            finally:
                cleaned.append(True)
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

    assert log.getvalue() == " 50% PASSED  tests/a.py::test_b\n"
    assert capsys.readouterr().out == "[2/3]  50% PASSED  tests/a.py::test_b\n"


class _Installed(Exception):
    pass


def _refuse_to_continue() -> None:
    raise _Installed


@pytest.mark.parametrize(
    ("module", "arguments"),
    [("fullstack_runner", (["--backend-coverage-only"],)), ("smoke_runner", ())],
)
def test_each_runner_handles_a_stop_before_it_creates_a_stack(
    monkeypatch: pytest.MonkeyPatch, module: str, arguments: tuple[list[str], ...]
) -> None:
    runner = __import__(f"tests.{module}", fromlist=["main"])
    monkeypatch.setattr(runner, "stop_on_signals", _refuse_to_continue)
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda **_: pytest.fail("stack started"))

    with pytest.raises(_Installed):
        runner.main(*arguments)


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
