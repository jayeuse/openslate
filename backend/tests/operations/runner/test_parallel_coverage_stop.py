"""A stopped parallel coverage run stops every shard and waits for its teardown.

Real processes and real signals: the shards are fake runners that use the runners' own
signal handling and take a moment to remove their (pretend) stack.
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[3]
SHARDS = 3

FAKE_SHARD = """
import os, signal, sys, time
from pathlib import Path
sys.path.insert(0, os.getcwd())
from tests.runner_console import stop_on_signals

state, group, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if mode == "stubborn":
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    stop_on_signals()
(state / f"pid-{group}").write_text(str(os.getpid()))
try:
    while True:
        time.sleep(0.05)
finally:
    (state / f"stopping-{group}").touch()
    time.sleep(0.5)  # a teardown that takes a moment, like removing a disposable stack
    (state / f"cleaned-{group}").touch()
"""

PARALLEL_COVERAGE = """
import sys
from pathlib import Path
from tests import parallel_coverage

state, fake, stubborn = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
parallel_coverage.SHARDS_ROOT = state / "shards"
parallel_coverage.SHARD_STOP_SECONDS = 2.0
parallel_coverage.shard_command = lambda group, total: [
    sys.executable, fake, str(state), str(group), "stubborn" if str(group) == stubborn else "ok"
]
raise SystemExit(parallel_coverage.main(["--shards", "3"]))
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_for(condition, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return condition()


@pytest.fixture
def coverage_run(tmp_path: Path):
    """Start parallel_coverage in its own process group, as the pre-push lane does."""
    fake = tmp_path / "fake_shard.py"
    fake.write_text(FAKE_SHARD)
    started: list[subprocess.Popen[bytes]] = []

    def start(stubborn: str = "") -> subprocess.Popen[bytes]:
        output = (tmp_path / "parallel.log").open("wb")
        process = subprocess.Popen(
            [sys.executable, "-c", PARALLEL_COVERAGE, str(tmp_path), str(fake), stubborn],
            cwd=BACKEND,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        started.append(process)
        assert _wait_for(
            lambda: all((tmp_path / f"pid-{group}").exists() for group in range(1, SHARDS + 1)),
            20,
        ), "fake shards did not start"
        return process

    yield start
    for group in range(1, SHARDS + 1):
        pid_file = tmp_path / f"pid-{group}"
        if pid_file.exists() and _alive(int(pid_file.read_text())):
            os.kill(int(pid_file.read_text()), signal.SIGKILL)
    for process in started:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


@pytest.mark.parametrize("number", [signal.SIGINT, signal.SIGTERM])
def test_a_stop_reaches_every_shard_once_and_waits_for_each_teardown(
    coverage_run, tmp_path: Path, number: int
) -> None:
    process = coverage_run()

    os.killpg(process.pid, number)  # what the pre-push lane stop sends to its step's group
    assert process.wait(timeout=30) != 0

    for group in range(1, SHARDS + 1):
        assert (tmp_path / f"cleaned-{group}").exists(), f"shard {group} teardown was cut short"
        assert _wait_for(lambda g=group: not _alive(int((tmp_path / f"pid-{g}").read_text())), 5)


def test_a_shard_that_ignores_the_stop_is_killed_after_the_bound(
    coverage_run, tmp_path: Path
) -> None:
    process = coverage_run(stubborn="2")

    os.killpg(process.pid, signal.SIGINT)
    assert process.wait(timeout=30) != 0

    assert (tmp_path / "cleaned-1").exists() and (tmp_path / "cleaned-3").exists()
    assert not (tmp_path / "stopping-2").exists()
    assert _wait_for(lambda: not _alive(int((tmp_path / "pid-2").read_text())), 5)
