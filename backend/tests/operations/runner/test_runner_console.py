"""Stop handling for the disposable-stack test runners."""

import os
import signal

import pytest

from tests import runner_console


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
