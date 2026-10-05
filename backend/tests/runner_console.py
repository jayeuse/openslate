"""Run test commands for the disposable-stack runners; the full output stays in the private log.

Runs are quiet by default, because drawing thousands of result lines slowed the machine.
OPENSLATE_TEST_PROGRESS=1 shows one line per finished test (the private log can hold
provider credentials, so nothing else is shown). Runners also turn SIGTERM and SIGHUP into
an interrupt, so a stopped run still removes its disposable stack.
"""

import os
import re
import signal
import subprocess
import sys
import time
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
    shown: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run like subprocess.run(check=True); with OPENSLATE_TEST_PROGRESS=1, show results.

    `shown` collects the test-result lines either way; they hold no other output.
    """
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
    echo = os.environ.get("OPENSLATE_TEST_PROGRESS") == "1"
    try:
        for line in process.stdout:
            log.write(line)
            progress = progress_line(line)
            if progress is not None:
                if echo:
                    print(progress, flush=True)
                if shown is not None:
                    shown.append(progress)
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
    except PermissionError:
        # macOS answers EPERM when only unreaped zombies remain in our own group.
        pass


def stop_process_group(process: subprocess.Popen[str], timeout: float = 10) -> None:
    """Stop a group leader and everything it started; a group that has ended counts as stopped.

    The process must have started with start_new_session=True. An exited leader does not
    prove its group has ended, so the group is always signalled.
    """
    stop_process_groups([process], timeout)


def stop_process_groups(processes: list[subprocess.Popen[str]], timeout: float) -> None:
    """Stop several group leaders at once: SIGTERM each group once, wait for all of them
    against one deadline, then SIGKILL every group that is still running."""
    for process in processes:
        _signal_group(process.pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout
    for process in processes:
        try:
            process.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _signal_group(process.pid, signal.SIGKILL)
            process.wait()
    for process in processes:
        # Descendants that outlive the leader are still in its group.
        _signal_group(process.pid, signal.SIGKILL)


PLAYWRIGHT_OUTCOMES = {"✓": "passed", "ok": "passed", "✘": "failed", "x": "failed", "-": "skipped"}
PLAYWRIGHT_TEST = re.compile(
    r"^\s+(?P<mark>✓|✘|ok|x|-)\s+\d+ \[[^\]]+\] › (?P<location>\S+) › (?P<title>.+?)"
    r"(?: \((?P<duration>[\d.]+m?s)\))?$"
)


def playwright_results(lines: list[str]) -> list[dict[str, str | None]]:
    """Read test outcomes from Playwright list-reporter lines: status, place, title, time."""
    results = []
    for line in lines:
        match = PLAYWRIGHT_TEST.match(line)
        if match:
            results.append(
                {
                    "status": PLAYWRIGHT_OUTCOMES[match["mark"]],
                    "location": match["location"],
                    "title": match["title"],
                    "duration": match["duration"],
                }
            )
    return results


def e2e_browser_flags() -> list[str]:
    """List each test in the private log; open a visible browser only on request, never in CI."""
    headed = not os.environ.get("CI") and os.environ.get("OPENSLATE_E2E_HEADED") == "1"
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
    """Copy a shard's output to its log and to the terminal with the shard name in front.

    Each line carries its wall-clock time, so per-shard stage durations can be read back.
    """
    for line in lines:
        stamped = f"{time.strftime('%H:%M:%S')} {line}"
        log.write(stamped)
        log.flush()
        sys.stdout.write(f"{prefix} {stamped}")
        sys.stdout.flush()
