"""Run the repository's local pre-push checks from one fail-closed plan.

Fast checks run first on the terminal. The resource lanes (frontend, backend, server
image) then run concurrently, each with its own log, unless ``--serial`` is given.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from types import FrameType
from typing import IO, Final, Protocol

if __package__ in {None, ""}:  # Supports the documented direct CLI invocation.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.ci_scope import ChangeScope, classify_changes

CommandRunner = Callable[..., subprocess.CompletedProcess[object]]
SERIAL_BACKEND_STACK: Final[str] = "backend-postgres"
LOG_DIRECTORY: Final[str] = "backend/test-results/prepush"
LOG_TAIL_LINES: Final[int] = 60
# Printed once per disposable stack when its Storage initialization stage starts, after
# the stack has booted and its roles and migrations are in place.
STACK_READY_MARKER: Final[str] = "Full-stack: private Storage initialization"


@dataclass(frozen=True)
class Step:
    """One existing repository command in the pre-push plan."""

    name: str
    gate: str
    phase: str
    cwd: str
    command: tuple[str, ...]
    lane: str | None = None
    serial_group: str | None = None
    needs_base: bool = False
    # Other lanes start only after this many marker lines appear in this step's log (or
    # the step ends), so disposable stacks boot before heavy work shares the host.
    ready_marker: str | None = None
    ready_count: int = 1

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "command": list(self.command),
            "cwd": self.cwd,
            "gate": self.gate,
            "name": self.name,
            "phase": self.phase,
        }
        if self.serial_group is not None:
            result["serial_group"] = self.serial_group
        if self.lane is not None:
            result["lane"] = self.lane
        if self.needs_base:
            result["needs_base"] = True
        if self.ready_marker is not None:
            result["ready_marker"] = self.ready_marker
            result["ready_count"] = self.ready_count
        return result


@dataclass(frozen=True)
class PrepushPlan:
    """The immutable commands selected for a classified checkout."""

    scope: ChangeScope
    steps: tuple[Step, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            **self.scope.as_dict(),
            "steps": [step.as_dict() for step in self.steps],
        }


def _add_frontend_steps(steps: list[Step]) -> None:
    steps.extend(
        (
            Step(
                name="frontend-check",
                gate="frontend",
                phase="fast",
                cwd="frontend",
                command=("npm", "run", "check"),
            ),
            Step(
                name="frontend-browser-install",
                gate="frontend",
                phase="fast",
                cwd="frontend",
                command=("npm", "exec", "--no", "--", "playwright", "install", "chromium"),
            ),
            # Browser tests run against this build (the static export), so it
            # comes first.
            Step(
                name="frontend-build",
                gate="frontend",
                phase="resource",
                cwd="frontend",
                command=("npm", "run", "build"),
                lane="frontend",
            ),
            Step(
                name="frontend-tests",
                gate="frontend",
                phase="resource",
                cwd="frontend",
                command=("npm", "test"),
                lane="frontend",
            ),
        )
    )


def _add_test_guard_step(steps: list[Step]) -> None:
    # Plan item 14: refuse weakened tests before any lane spends time on them.
    steps.append(
        Step(
            name="test-guard",
            gate="tests",
            phase="fast",
            cwd=".",
            command=("python3", "scripts/assertion_guard.py"),
            needs_base=True,
        )
    )


def _add_backend_steps(steps: list[Step], coverage_stacks: int = 3) -> None:
    steps.extend(
        (
            Step(
                name="backend-ruff",
                gate="backend",
                phase="fast",
                cwd="backend",
                command=(
                    "uv",
                    "run",
                    "ruff",
                    "check",
                    ".",
                    "../scripts",
                    "../tests/tooling",
                    "../packaging/backup",
                ),
            ),
            Step(
                name="backend-mypy",
                gate="backend",
                phase="fast",
                cwd="backend",
                command=(
                    "uv",
                    "run",
                    "mypy",
                    "app",
                    "operations",
                    "../scripts/ci_scope.py",
                    "../scripts/prepush.py",
                    "../scripts/environment.py",
                    "../scripts/dev.py",
                    "../scripts/run_tests.py",
                    "../scripts/assertion_guard.py",
                    "../packaging/backup/backup_installation.py",
                    "../packaging/backup/restore_installation.py",
                ),
            ),
            Step(
                name="packaging-backup-tests",
                gate="backend",
                phase="fast",
                cwd="backend",
                command=(
                    "uv",
                    "run",
                    "pytest",
                    "../packaging/backup/tests",
                    "--no-cov",
                    "--basetemp",
                    ".backup-contracts",
                ),
            ),
            Step(
                name="tooling-tests",
                gate="backend",
                phase="fast",
                cwd="backend",
                command=(
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "unittest",
                    "discover",
                    "-s",
                    "../tests/tooling",
                    "-t",
                    "..",
                    "-p",
                    "test_*.py",
                ),
            ),
        )
    )
    steps.append(
        Step(
            name="backend-coverage",
            gate="backend",
            phase="resource",
            cwd="backend",
            # Shards on their own disposable stacks, combined under the same gates; one
            # stack runs the single coverage run for a machine with less memory.
            command=(
                ("uv", "run", "python", "-m", "tests.fullstack_runner", "--backend-coverage-only")
                if coverage_stacks == 1
                else (
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "tests.parallel_coverage",
                    "--shards",
                    str(coverage_stacks),
                )
            ),
            lane="backend",
            serial_group=SERIAL_BACKEND_STACK,
            needs_base=True,
            ready_marker=STACK_READY_MARKER,
            ready_count=coverage_stacks,
        )
    )
    steps.append(
        Step(
            name="provider-reset-acceptance",
            gate="backend",
            phase="resource",
            cwd="backend",
            command=(
                "uv",
                "run",
                "python",
                "-m",
                "tests.fullstack_runner",
                "--reset-acceptance-only",
            ),
            lane="backend",
            serial_group=SERIAL_BACKEND_STACK,
        )
    )


def _add_server_image_step(steps: list[Step], lane: str = "server") -> None:
    steps.append(
        Step(
            name="server-image-build",
            gate="server_image",
            phase="resource",
            cwd=".",
            command=(
                "docker",
                "build",
                "--file",
                "infra/docker/backend.Dockerfile",
                "--tag",
                "openslate-server:ci",
                ".",
            ),
            lane=lane,
        )
    )


def _add_release_smoke_step(steps: list[Step]) -> None:
    # Release gate only: Harbor Small through the seeder, then one browser path per screen.
    steps.append(
        Step(
            name="release-smoke",
            gate="release",
            phase="resource",
            cwd="backend",
            command=("uv", "run", "python", "-m", "tests.smoke_runner"),
            lane="backend",
            serial_group=SERIAL_BACKEND_STACK,
        )
    )


def build_plan(
    scope: ChangeScope, root: Path, *, release: bool = False, coverage_stacks: int = 3
) -> PrepushPlan:
    """Build the command plan without starting any subprocesses."""

    del root  # The plan uses repository-relative working directories.
    steps: list[Step] = []
    if scope.decisions["frontend"].run or scope.decisions["backend"].run:
        _add_test_guard_step(steps)
    if scope.decisions["frontend"].run:
        _add_frontend_steps(steps)
    if scope.decisions["backend"].run:
        _add_backend_steps(steps, coverage_stacks)
    if scope.decisions["server_image"].run:
        # After the frontend build: BuildKit beside three booting stacks made their
        # Storage containers miss the health window.
        frontend = scope.decisions["frontend"].run
        _add_server_image_step(steps, "frontend" if frontend else "server")
    if release:
        _add_release_smoke_step(steps)
    ordered = tuple(step for phase in ("fast", "resource") for step in steps if step.phase == phase)
    return PrepushPlan(scope=scope, steps=ordered)


def _step_environment(
    step: Step, scope: ChangeScope, *, unbuffered: bool = False
) -> dict[str, str]:
    environment = os.environ.copy()
    if step.needs_base and scope.base_ref is not None:
        environment["COVERAGE_BASE_REF"] = scope.base_ref
    if unbuffered:
        # Lane logs are files, not terminals; keep Python runner output current in them.
        environment["PYTHONUNBUFFERED"] = "1"
    return environment


StepTiming = tuple[str, float, int]


def _status_text(returncode: int) -> str:
    return "PASS" if returncode == 0 else f"FAIL ({returncode})"


def _execute_steps(
    steps: tuple[Step, ...],
    root: Path,
    scope: ChangeScope,
    command_runner: CommandRunner,
    clock: Callable[[], float],
) -> tuple[int, list[StepTiming]]:
    """Run one serial sequence on the terminal and stop it at its first failure."""

    timings: list[StepTiming] = []
    for step in steps:
        print(f"\n==> {step.name}: {' '.join(step.command)}", flush=True)
        started = clock()
        try:
            result = command_runner(
                list(step.command),
                cwd=root / step.cwd,
                env=_step_environment(step, scope),
                check=False,
            )
            returncode = int(result.returncode)
        except OSError as error:
            elapsed = max(0.0, clock() - started)
            print(f"{step.name}: ERROR ({elapsed:.2f}s): {error}", flush=True)
            timings.append((step.name, elapsed, 127))
            return 127, timings
        elapsed = max(0.0, clock() - started)
        timings.append((step.name, elapsed, returncode))
        print(f"{step.name}: {_status_text(returncode)} ({elapsed:.2f}s)", flush=True)
        if returncode != 0:
            return returncode, timings
    return 0, timings


class LaneProcess(Protocol):
    """The part of ``subprocess.Popen`` a parallel lane uses."""

    pid: int

    def wait(self) -> int: ...


ProcessStarter = Callable[..., LaneProcess]


def _start_in_own_group(command: list[str], **options: object) -> LaneProcess:
    # Each lane step leads its own process group, so a stop can reach everything the
    # step started (Playwright's dev server, the runners' Compose calls) and nothing
    # inside one lane can signal prepush or another lane.
    return subprocess.Popen(command, start_new_session=True, **options)  # type: ignore[call-overload,no-any-return]


def _interrupt_group(process: LaneProcess) -> None:
    try:
        os.killpg(process.pid, signal.SIGINT)
    except ProcessLookupError:
        pass


LANE_INCOMPLETE: Final[int] = 1


@dataclass
class _LaneResult:
    # A lane counts as failed until its thread finishes every step it was given.
    status: int = LANE_INCOMPLETE
    timings: list[StepTiming] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


class _ParallelLanes:
    """Run each lane on its own thread with its own log file.

    A failure stops every lane from *starting* another step; running steps finish.
    A stop request (SIGINT or SIGTERM to prepush) sends SIGINT once to each running
    step's process group and then waits: the disposable-stack runners own their teardown.
    """

    def __init__(
        self,
        root: Path,
        scope: ChangeScope,
        start: ProcessStarter,
        interrupt: Callable[[LaneProcess], None],
        clock: Callable[[], float],
        log_dir: Path,
    ) -> None:
        self.root = root
        self.scope = scope
        self.start = start
        self.interrupt = interrupt
        self.clock = clock
        self.log_dir = log_dir
        self.stop = threading.Event()
        self.ready = threading.Event()
        self.gate_lane: str | None = None
        self.interrupted = False
        self.lock = threading.Lock()
        self.active: dict[str, tuple[str, float, LaneProcess]] = {}
        self.results: dict[str, _LaneResult] = {}

    def log_path(self, lane: str) -> Path:
        return self.log_dir / f"{lane}.log"

    def _run_step(self, lane: str, step: Step, log: IO[str]) -> int | None:
        """Return the step's exit status, or None when a stop came before it started."""

        log.write(f"\n==> {step.name}: {' '.join(step.command)}\n")
        log.flush()
        with self.lock:
            if self.stop.is_set():
                return None
            try:
                process = self.start(
                    list(step.command),
                    cwd=self.root / step.cwd,
                    env=_step_environment(step, self.scope, unbuffered=True),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
            except OSError as error:
                log.write(f"{step.name}: could not start: {error}\n")
                return 127
            print(f"[{lane}] {step.name}: started", flush=True)
            self.active[lane] = (step.name, self.clock(), process)
        try:
            return int(process.wait())
        except Exception as error:  # Keep the lane's failure visible, never a silent thread.
            log.write(f"{step.name}: runner error: {type(error).__name__}: {error}\n")
            return 1
        finally:
            with self.lock:
                self.active.pop(lane, None)

    def _watch_ready(self, step: Step, path: Path, done: threading.Event) -> None:
        """Release held lanes once the step's log shows its marker often enough."""

        marker = step.ready_marker or ""
        while not done.wait(timeout=0.2):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if text.count(marker) >= step.ready_count:
                break
        self.ready.set()

    def _wait_until_ready(self, lane: str) -> None:
        if self.ready.is_set() or lane == self.gate_lane:
            return
        print(f"[{lane}] waiting for backend stacks to finish starting", flush=True)
        while not self.ready.wait(timeout=0.2):
            if self.stop.is_set():
                return

    def run_lane(self, lane: str, steps: tuple[Step, ...]) -> None:
        result = _LaneResult()
        self.results[lane] = result
        try:
            result.status = self._run_lane_steps(lane, steps, result)
        except BaseException:
            # A broken lane thread must fail the gate and release the other lanes,
            # never leave a PASS for steps that did not run or a lane held forever. The
            # result keeps its failed default (or the failing step's status).
            self._record_lane_error(lane, traceback.format_exc())
            self.stop.set()
            self.ready.set()

    def _record_lane_error(self, lane: str, details: str) -> None:
        message = f"\n[{lane}] lane error:\n{details}"
        try:
            with self.log_path(lane).open("a", encoding="utf-8") as log:
                log.write(message)
        except OSError:
            print(message, file=sys.stderr, flush=True)
        print(f"[{lane}] lane error; see {self.log_path(lane)}", flush=True)

    def _run_lane_steps(self, lane: str, steps: tuple[Step, ...], result: _LaneResult) -> int:
        """Run the lane's steps; return its failing exit status, or 0."""

        failure = 0
        self._wait_until_ready(lane)
        with self.log_path(lane).open("a", encoding="utf-8") as log:
            for step in steps:
                started = self.clock()
                watcher_done = threading.Event()
                if step.ready_marker is not None and not self.ready.is_set():
                    threading.Thread(
                        target=self._watch_ready,
                        args=(step, self.log_path(lane), watcher_done),
                        daemon=True,
                    ).start()
                try:
                    returncode = None if self.stop.is_set() else self._run_step(lane, step, log)
                finally:
                    watcher_done.set()
                if returncode is None:
                    result.skipped.append(step.name)
                    continue
                elapsed = max(0.0, self.clock() - started)
                result.timings.append((step.name, elapsed, returncode))
                print(
                    f"[{lane}] {step.name}: {_status_text(returncode)} ({elapsed:.2f}s)",
                    flush=True,
                )
                if returncode != 0:
                    failure = failure or returncode
                    result.status = failure
                    self.stop.set()
        return failure

    def request_stop(self) -> None:
        """Stop new steps and ask each running step's process group to stop, once."""

        with self.lock:
            self.stop.set()
            if self.interrupted:
                return
            self.interrupted = True
            running = list(self.active.values())
        for _name, _started, process in running:
            self.interrupt(process)

    def status_line(self) -> str:
        now = self.clock()
        with self.lock:
            running = [
                f"{lane}: {name} {max(0.0, now - started):.0f}s"
                for lane, (name, started, _process) in sorted(self.active.items())
            ]
        return "[lanes] running " + ("; ".join(running) if running else "nothing")

    def run(self, lanes: dict[str, tuple[Step, ...]], heartbeat_seconds: float) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.gate_lane = next(
            (lane for lane, steps in lanes.items() if steps and steps[0].ready_marker),
            None,
        )
        if self.gate_lane is None:
            self.ready.set()
        for lane in lanes:
            self.log_path(lane).write_text("", encoding="utf-8")
            print(f"[{lane}] log: {self.log_path(lane)}", flush=True)
        threads = [
            threading.Thread(target=self.run_lane, args=(lane, steps), name=f"prepush-{lane}")
            for lane, steps in lanes.items()
        ]
        for thread in threads:
            thread.start()
        interrupted = False
        while any(thread.is_alive() for thread in threads):
            try:
                next(thread for thread in threads if thread.is_alive()).join(
                    timeout=heartbeat_seconds
                )
                if any(thread.is_alive() for thread in threads):
                    print(self.status_line(), flush=True)
            except KeyboardInterrupt:
                # Never abandon a runner mid-teardown; a repeated stop only waits again.
                interrupted = True
                self.request_stop()
                print(
                    "\nStop requested; running steps were asked to stop and clean up. Waiting.",
                    flush=True,
                )
        if interrupted:
            raise KeyboardInterrupt

    def print_failed_tails(self) -> None:
        for lane, result in self.results.items():
            if result.status == 0:
                continue
            lines = self.log_path(lane).read_text(encoding="utf-8", errors="replace").splitlines()
            print(f"\n--- {lane} lane failed; last {LOG_TAIL_LINES} log lines ---")
            print("\n".join(lines[-LOG_TAIL_LINES:]))
            print(f"--- full log: {self.log_path(lane)} ---")


def _lane_groups(steps: tuple[Step, ...]) -> tuple[list[Step], dict[str, tuple[Step, ...]]]:
    lanes: dict[str, list[Step]] = {}
    unassigned: list[Step] = []
    for step in steps:
        if step.lane is None:
            unassigned.append(step)
        else:
            lanes.setdefault(step.lane, []).append(step)
    order: list[str] = [name for name in ("frontend", "backend", "server") if name in lanes]
    order += [name for name in lanes if name not in order]
    return unassigned, {name: tuple(lanes[name]) for name in order}


def execute_plan(
    plan: PrepushPlan,
    root: Path,
    *,
    run: CommandRunner | None = None,
    start: ProcessStarter | None = None,
    interrupt: Callable[[LaneProcess], None] = _interrupt_group,
    clock: Callable[[], float] = time.monotonic,
    serial: bool = False,
    log_dir: Path | None = None,
    heartbeat_seconds: float = 60.0,
) -> int:
    """Run fast checks, then the resource lanes concurrently (or serially)."""

    command_runner = run or subprocess.run
    if not plan.steps:
        print("No functional changes; no pre-push commands selected.")
        return 0

    started = clock()
    planned = [step.name for step in plan.steps]
    fast_steps = tuple(step for step in plan.steps if step.phase == "fast")
    resource_steps = tuple(step for step in plan.steps if step.phase == "resource")
    status, timings = _execute_steps(fast_steps, root, plan.scope, command_runner, clock)
    if status != 0:
        _print_timing_summary(timings, clock() - started, planned=planned)
        return status

    unassigned, lanes = _lane_groups(resource_steps)
    if unassigned:
        # Every current resource command has a lane. Keep a conservative sequential
        # fallback if a future step omits its lane.
        fallback_status, fallback_timings = _execute_steps(
            tuple(unassigned), root, plan.scope, command_runner, clock
        )
        timings.extend(fallback_timings)
        if fallback_status != 0:
            _print_timing_summary(timings, clock() - started, planned=planned)
            return fallback_status

    if not serial and len(lanes) > 1:
        print(f"\nRunning {len(lanes)} resource lanes concurrently.", flush=True)
        runner = _ParallelLanes(
            root,
            plan.scope,
            start or _start_in_own_group,
            interrupt,
            clock,
            log_dir or root / LOG_DIRECTORY,
        )
        try:
            runner.run(lanes, heartbeat_seconds)
        finally:
            skipped: list[str] = []
            for lane in lanes:
                unstarted = _LaneResult(skipped=[step.name for step in lanes[lane]])
                # A lane missing here never ran its thread; it keeps the failed default.
                result = runner.results.get(lane, unstarted)
                timings.extend(result.timings)
                skipped.extend(result.skipped)
                if status == 0 and result.status != 0:
                    status = result.status
            if status == 0 and not _all_passed(planned, timings):
                status = LANE_INCOMPLETE
            runner.print_failed_tails()
            _print_timing_summary(timings, clock() - started, skipped, planned)
        return status

    if lanes:
        print(f"\nRunning {len(lanes)} resource lane(s) serially on this host.", flush=True)
    for steps in lanes.values():
        lane_status, current_timings = _execute_steps(
            steps, root, plan.scope, command_runner, clock
        )
        timings.extend(current_timings)
        if lane_status != 0:
            _print_timing_summary(timings, clock() - started, planned=planned)
            return lane_status
    _print_timing_summary(timings, clock() - started, planned=planned)
    return 0 if _all_passed(planned, timings) else LANE_INCOMPLETE


def _all_passed(planned: list[str], timings: list[StepTiming]) -> bool:
    """True only when every planned step ran and exited 0."""

    passed = {name for name, _elapsed, returncode in timings if returncode == 0}
    failed = any(returncode != 0 for _name, _elapsed, returncode in timings)
    return not failed and all(name in passed for name in planned)


def _print_timing_summary(
    timings: list[StepTiming],
    wall_clock: float,
    skipped: list[str] | None = None,
    planned: list[str] | None = None,
) -> None:
    print("\nTiming summary:")
    for name, elapsed, returncode in timings:
        print(f"- {name}: {_status_text(returncode)}, {elapsed:.2f}s")
    for name in skipped or ():
        print(f"- {name}: SKIPPED (stopped before it started)")
    recorded = {name for name, _elapsed, _returncode in timings} | set(skipped or ())
    for name in planned or ():
        if name not in recorded:
            print(f"- {name}: NOT RUN")
    total = sum(elapsed for _, elapsed, _ in timings)
    final = (
        "PASS"
        if not skipped and _all_passed(planned or [n for n, _e, _r in timings], timings)
        else "FAIL"
    )
    print(
        f"Pre-push result: {final}; {len(timings)} command(s), "
        f"wall-clock {max(0.0, wall_clock):.2f}s, command time {total:.2f}s"
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base",
        default=os.getenv("COVERAGE_BASE_REF") or os.getenv("GITHUB_BASE_REF"),
        help="Verified Git revision used as the comparison base",
    )
    parser.add_argument(
        "--list",
        "--plan",
        dest="list_only",
        action="store_true",
        help="Print the classified plan without running checks",
    )
    parser.add_argument(
        "--release",
        action="store_true",
        help="Also run the release smoke suite (Harbor Small seed and browser paths)",
    )
    parser.add_argument(
        "--serial",
        action="store_true",
        help="Run the resource lanes one after another on the terminal",
    )
    parser.add_argument(
        "--coverage-stacks",
        type=int,
        default=3,
        choices=range(1, 6),
        help="Disposable stacks for backend coverage at once (default 3; 1 needs less memory)",
    )
    return parser


def _stop_on_terminate() -> None:
    """Treat SIGTERM and SIGHUP like Ctrl-C so running lanes clean up, not orphan stacks."""

    def interrupt(number: int, _frame: FrameType | None) -> None:
        raise KeyboardInterrupt(signal.Signals(number).name)

    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupt)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    scope = classify_changes(root, args.base)
    plan = build_plan(scope, root, release=args.release, coverage_stacks=args.coverage_stacks)
    if args.list_only:
        print(json.dumps(plan.as_dict(), indent=2, sort_keys=True))
        return 0
    _stop_on_terminate()
    try:
        return execute_plan(plan, root, serial=args.serial)
    except KeyboardInterrupt:
        print("\nPre-push interrupted; active checks were asked to stop.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
