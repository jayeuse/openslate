"""Show test progress in the runner's terminal; the full output stays in the private log.

The private log can hold provider credentials, so the terminal gets only one line per
finished test and the final counts. Runners also turn SIGTERM and SIGHUP into an
interrupt, so a stopped run still removes its disposable stack.
"""

import os
import re
import signal
import subprocess
import sys
from pathlib import Path
from typing import IO

PYTEST_RESULT = re.compile(
    r"^(?P<test>.+?) (?P<outcome>PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)"
    r"\s+\[\s*(?P<percent>\d+)%\]\s*$"
)
PYTEST_TOTAL = re.compile(r"^=+ .*\b(passed|failed|errors?|skipped)\b.* in [\d.]+s.*=+$")
PLAYWRIGHT_RESULT = re.compile(r"^\s+(✓|✘|ok|x|-)\s+\d+ .*›")
PLAYWRIGHT_TOTAL = re.compile(r"^\s+\d+ (passed|failed|flaky|skipped|interrupted|did not run)\b")
# One parametrized ID embeds a 26 MB payload; the terminal gets a readable prefix.
TEST_LIMIT = 140
LINE_LIMIT = 200


def progress_line(line: str) -> str | None:
    """Return the terminal form of one output line, or None to keep it in the log only."""
    text = line.rstrip("\r\n")
    result = PYTEST_RESULT.match(text)
    if result:
        test = result["test"]
        if len(test) > TEST_LIMIT:
            test = test[: TEST_LIMIT - 1] + "…"
        return f"{result['percent']:>3}% {result['outcome']:<7} {test}"
    if PYTEST_TOTAL.match(text) or PLAYWRIGHT_RESULT.match(text) or PLAYWRIGHT_TOTAL.match(text):
        return text[:LINE_LIMIT]
    return None


def run_streamed(
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    log: IO[str],
    *,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run like subprocess.run(check=True), and echo test results while they finish."""
    if capture:
        return subprocess.run(
            command, cwd=cwd, env=env, check=True, stdout=subprocess.PIPE, stderr=log, text=True
        )
    # Its own process group: a stopped run can stop the command and everything it started.
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=True,
    )
    assert process.stdout is not None
    try:
        for line in process.stdout:
            log.write(line)
            shown = progress_line(line)
            if shown is not None:
                print(shown, flush=True)
        process.wait()
    except BaseException:
        # Interrupted: stop the group before the runner removes the services it uses.
        stop_process_group(process)
        raise
    finally:
        process.stdout.close()
        log.flush()
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command)
    return subprocess.CompletedProcess(command, process.returncode)


def _signal_group(group: int, number: int) -> None:
    try:
        os.killpg(group, number)
    except ProcessLookupError:
        pass  # The group has ended already.


def stop_process_group(process: subprocess.Popen[str], timeout: float = 10) -> None:
    """Stop a group leader and everything it started; a group that has ended counts as stopped.

    The process must have started with start_new_session=True.
    """
    if process.poll() is not None:
        return
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _signal_group(process.pid, signal.SIGKILL)
        process.wait()
    # Descendants that outlive the leader are still in its group.
    _signal_group(process.pid, signal.SIGKILL)


def e2e_browser_flags() -> list[str]:
    """List each test as it finishes; open a visible browser unless CI or opted out."""
    headed = not os.environ.get("CI") and os.environ.get("OPENSLATE_E2E_HEADED", "1") != "0"
    return ["--reporter=list", *(["--headed"] if headed else [])]


def stop_on_signals() -> None:
    """Raise KeyboardInterrupt on SIGTERM or SIGHUP so the runner's cleanup runs once."""

    def interrupt(number: int, frame: object) -> None:
        # A second signal must not interrupt the cleanup that the first one started.
        for name in ("SIGTERM", "SIGHUP"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_IGN)
        raise KeyboardInterrupt(signal.Signals(number).name)

    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupt)


def relay(lines: IO[str], log: IO[str], prefix: str) -> None:
    """Copy a shard's output to its log and to the terminal with the shard name in front."""
    for line in lines:
        log.write(line)
        log.flush()
        sys.stdout.write(f"{prefix} {line}")
        sys.stdout.flush()
