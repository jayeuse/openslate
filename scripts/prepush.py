"""Run the repository's local pre-push checks from one fail-closed plan."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final

if __package__ in {None, ""}:  # Supports the documented direct CLI invocation.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.ci_scope import ChangeScope, classify_changes

CommandRunner = Callable[..., subprocess.CompletedProcess[object]]
SERIAL_BACKEND_STACK: Final[str] = "backend-supabase"


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
                name="frontend-build",
                gate="frontend",
                phase="resource",
                cwd="frontend",
                command=("npm", "run", "build"),
                lane="frontend",
            ),
            Step(
                name="frontend-browser",
                gate="frontend",
                phase="resource",
                cwd="frontend",
                command=(
                    "npm",
                    "run",
                    "test:e2e:production",
                    "--",
                    "--workers=2",
                ),
                lane="frontend",
            ),
            Step(
                name="frontend-coverage-plan",
                gate="frontend",
                phase="resource",
                cwd="frontend",
                command=(
                    "npm",
                    "run",
                    "test:coverage:plan",
                    "--",
                    "--output=coverage/prepush-plan.json",
                ),
                lane="frontend",
                needs_base=True,
            ),
        )
    )


def _add_backend_steps(steps: list[Step]) -> None:
    steps.extend(
        (
            Step(
                name="backend-ruff",
                gate="backend",
                phase="fast",
                cwd="backend",
                command=("uv", "run", "ruff", "check", ".", "../scripts"),
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
                    "scripts",
                    "../scripts/ci_scope.py",
                    "../scripts/prepush.py",
                    "../scripts/build_frontend_image.py",
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
                    "../scripts",
                    "-p",
                    "test_*.py",
                ),
            ),
            Step(
                name="backend-coverage",
                gate="backend",
                phase="resource",
                cwd="backend",
                command=(
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "tests.fullstack_runner",
                    "--backend-coverage-only",
                ),
                lane="backend",
                serial_group=SERIAL_BACKEND_STACK,
                needs_base=True,
            ),
        )
    )


def _add_fullstack_step(steps: list[Step]) -> None:
    steps.append(
        Step(
            name="fullstack",
            gate="fullstack",
            phase="resource",
            cwd="backend",
            command=(
                "uv",
                "run",
                "python",
                "-m",
                "tests.fullstack_runner",
                "--acceptance-only",
            ),
            lane="backend",
            serial_group=SERIAL_BACKEND_STACK,
        )
    )


def _add_container_steps(
    steps: list[Step], *, frontend_container: bool, backend_container: bool
) -> None:
    boundary_check = (
        "test -z \"${BACKEND_URL+x}\" && "
        "test -z \"${SUPABASE_SERVER_URL+x}\" && "
        "test -z \"${DATABASE_URL+x}\" && "
        "test -z \"${MIGRATION_DATABASE_URL+x}\" && "
        "test -z \"${SUPABASE_SECRET_KEY+x}\" && "
        "test -z \"${SECURITY_EVENT_SERVER_KEY+x}\" && "
        "test -z \"${LOG_DIR+x}\" && "
        "test -z \"${NEXT_PUBLIC_SUPABASE_URL+x}\" && "
        "test -z \"${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY+x}\" && "
        "test -z \"${NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED+x}\""
    )
    if frontend_container:
        steps.extend(
            (
                Step(
                    name="frontend-container-build",
                    gate="containers",
                    phase="resource",
                    cwd=".",
                    command=(
                        "python3",
                        "scripts/build_frontend_image.py",
                        "--env-file",
                        "frontend/.env.local",
                        "--tag",
                        "openslate-frontend:ci",
                    ),
                    lane="frontend",
                ),
                Step(
                    name="frontend-container-boundary",
                    gate="containers",
                    phase="resource",
                    cwd=".",
                    command=(
                        "docker",
                        "run",
                        "--rm",
                        "--entrypoint",
                        "/bin/sh",
                        "openslate-frontend:ci",
                        "-c",
                        boundary_check,
                    ),
                    lane="frontend",
                ),
            )
        )
    if backend_container:
        steps.append(
            Step(
                name="backend-container-build",
                gate="containers",
                phase="resource",
                cwd=".",
                command=(
                    "docker",
                    "build",
                    "--file",
                    "infra/docker/backend.Dockerfile",
                    "--tag",
                    "openslate-backend:ci",
                    ".",
                ),
                lane="backend",
            )
        )


def build_plan(scope: ChangeScope, root: Path) -> PrepushPlan:
    """Build the command plan without starting any subprocesses."""

    del root  # The plan uses repository-relative working directories.
    steps: list[Step] = []
    if scope.decisions["frontend"].run:
        _add_frontend_steps(steps)
    if scope.decisions["backend"].run:
        _add_backend_steps(steps)
    if scope.decisions["fullstack"].run:
        _add_fullstack_step(steps)
    if scope.decisions["containers"].run:
        _add_container_steps(
            steps,
            frontend_container=scope.decisions["frontend_container"].run,
            backend_container=scope.decisions["backend_container"].run,
        )
    ordered = tuple(
        step for phase in ("fast", "resource") for step in steps if step.phase == phase
    )
    return PrepushPlan(scope=scope, steps=ordered)


def _step_environment(step: Step, scope: ChangeScope) -> dict[str, str]:
    environment = os.environ.copy()
    if step.needs_base and scope.base_ref is not None:
        environment["COVERAGE_BASE_REF"] = scope.base_ref
    return environment


StepTiming = tuple[str, float, int]


def _execute_steps(
    steps: tuple[Step, ...],
    root: Path,
    scope: ChangeScope,
    command_runner: CommandRunner,
    clock: Callable[[], float],
) -> tuple[int, list[StepTiming]]:
    """Run one serial sequence and stop it at its first failure."""

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
        status = "PASS" if returncode == 0 else f"FAIL ({returncode})"
        print(f"{step.name}: {status} ({elapsed:.2f}s)", flush=True)
        if returncode != 0:
            return returncode, timings
    return 0, timings


def execute_plan(
    plan: PrepushPlan,
    root: Path,
    *,
    run: CommandRunner | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Run fast checks, then resource lanes without host-level contention."""

    command_runner = run or subprocess.run
    if not plan.steps:
        print("No functional changes; no pre-push commands selected.")
        return 0

    fast_steps = tuple(step for step in plan.steps if step.phase == "fast")
    resource_steps = tuple(step for step in plan.steps if step.phase == "resource")
    status, timings = _execute_steps(
        fast_steps,
        root,
        plan.scope,
        command_runner,
        clock,
    )
    if status != 0:
        _print_timing_summary(timings)
        return status

    lanes: dict[str, list[Step]] = {}
    unassigned: list[Step] = []
    for step in resource_steps:
        if step.lane is None:
            unassigned.append(step)
        else:
            lanes.setdefault(step.lane, []).append(step)

    if unassigned:
        # All current resource commands belong to one of the two lanes. Keep a
        # conservative sequential fallback if a future step omits its lane.
        fallback_status, fallback_timings = _execute_steps(
            tuple(unassigned),
            root,
            plan.scope,
            command_runner,
            clock,
        )
        timings.extend(fallback_timings)
        if fallback_status != 0:
            _print_timing_summary(timings)
            return fallback_status

    lane_order: tuple[str, ...] = tuple(
        name for name in ("frontend", "backend") if name in lanes
    )
    extra_lanes = tuple(name for name in lanes if name not in lane_order)
    lane_order += extra_lanes
    if lane_order:
        print(
            f"\nRunning {len(lane_order)} resource lane(s) serially on this host.",
            flush=True,
        )
    for name in lane_order:
        lane_status, current_timings = _execute_steps(
            tuple(lanes[name]), root, plan.scope, command_runner, clock
        )
        timings.extend(current_timings)
        if lane_status != 0:
            _print_timing_summary(timings)
            return lane_status
    _print_timing_summary(timings)
    return 0


def _print_timing_summary(timings: list[tuple[str, float, int]]) -> None:
    print("\nTiming summary:")
    for name, elapsed, returncode in timings:
        status = "PASS" if returncode == 0 else f"FAIL ({returncode})"
        print(f"- {name}: {status}, {elapsed:.2f}s")
    total = sum(elapsed for _, elapsed, _ in timings)
    final = "PASS" if all(returncode == 0 for _, _, returncode in timings) else "FAIL"
    print(f"Pre-push result: {final}; {len(timings)} command(s), {total:.2f}s")


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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    scope = classify_changes(root, args.base)
    plan = build_plan(scope, root)
    if args.list_only:
        print(json.dumps(plan.as_dict(), indent=2, sort_keys=True))
        return 0
    try:
        return execute_plan(plan, root)
    except KeyboardInterrupt:
        print("\nPre-push interrupted; active checks were asked to stop.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
