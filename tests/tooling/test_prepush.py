"""Focused contract tests for the local pre-push orchestration plan."""

from __future__ import annotations

import io
import signal
import subprocess
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts import ci_scope, prepush


def all_gate_scope() -> ci_scope.ChangeScope:
    return ci_scope.classify_paths(["scripts/prepush.py"], base_ref="base")


class PrepushTests(unittest.TestCase):
    def test_destructive_provider_reset_has_a_required_separate_backend_phase(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        names = [step.name for step in plan.steps]
        self.assertIn("provider-reset-acceptance", names)
        reset = plan.steps[names.index("provider-reset-acceptance")]
        self.assertEqual(
            reset.command,
            ("uv", "run", "python", "-m", "tests.fullstack_runner", "--reset-acceptance-only"),
        )
        self.assertEqual(
            (reset.cwd, reset.lane, reset.serial_group), ("backend", "backend", "backend-postgres")
        )
        self.assertLess(names.index("backend-coverage"), names.index(reset.name))

    def test_test_guard_runs_first_against_the_base_for_any_test_lane(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        guard = plan.steps[0]
        self.assertEqual(guard.name, "test-guard")
        self.assertEqual(guard.command, ("python3", "scripts/assertion_guard.py"))
        self.assertEqual((guard.cwd, guard.phase), (".", "fast"))
        self.assertTrue(guard.needs_base)

    def test_local_backend_coverage_runs_parallel_shards_and_combines_them(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        coverage = next(step for step in plan.steps if step.name == "backend-coverage")
        self.assertEqual(
            coverage.command,
            ("uv", "run", "python", "-m", "tests.parallel_coverage", "--shards", "3"),
        )
        self.assertTrue(coverage.needs_base)
        self.assertEqual(coverage.serial_group, "backend-postgres")

    def test_a_smaller_machine_runs_coverage_on_fewer_stacks_with_the_same_gates(self):
        def coverage_command(stacks):
            plan = prepush.build_plan(all_gate_scope(), Path("/repo"), coverage_stacks=stacks)
            return next(step for step in plan.steps if step.name == "backend-coverage").command

        self.assertEqual(
            coverage_command(1),
            ("uv", "run", "python", "-m", "tests.fullstack_runner", "--backend-coverage-only"),
        )
        self.assertEqual(coverage_command(2)[-2:], ("--shards", "2"))
        self.assertEqual(
            prepush._parser().parse_args(["--coverage-stacks", "1"]).coverage_stacks, 1
        )

    def test_release_smoke_runs_only_with_the_release_flag_and_after_backend_stacks(self):
        default = prepush.build_plan(all_gate_scope(), Path("/repo"))
        self.assertNotIn("release-smoke", [step.name for step in default.steps])
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"), release=True)
        names = [step.name for step in plan.steps]
        smoke = plan.steps[names.index("release-smoke")]
        self.assertEqual(smoke.command, ("uv", "run", "python", "-m", "tests.smoke_runner"))
        self.assertEqual(
            (smoke.cwd, smoke.lane, smoke.serial_group), ("backend", "backend", "backend-postgres")
        )
        self.assertLess(names.index("provider-reset-acceptance"), names.index("release-smoke"))

    def test_plan_keeps_frontend_lean_and_backend_independent(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        names = [step.name for step in plan.steps]
        phases = [step.phase for step in plan.steps]

        self.assertEqual(phases, sorted(phases, key=("fast", "resource").index))
        self.assertLess(names.index("frontend-check"), names.index("frontend-tests"))
        self.assertLess(names.index("frontend-check"), names.index("frontend-browser-install"))
        self.assertLess(names.index("frontend-browser-install"), names.index("frontend-tests"))
        # The browser tests run against the static export that the build writes.
        self.assertLess(names.index("frontend-build"), names.index("frontend-tests"))
        self.assertLess(names.index("backend-ruff"), names.index("backend-coverage"))
        self.assertLess(names.index("backend-mypy"), names.index("backend-coverage"))
        self.assertIn("../scripts", plan.steps[names.index("backend-ruff")].command)
        self.assertIn("../tests/tooling", plan.steps[names.index("backend-ruff")].command)
        self.assertIn("operations", plan.steps[names.index("backend-mypy")].command)
        self.assertIn("../scripts/ci_scope.py", plan.steps[names.index("backend-mypy")].command)
        self.assertIn("../scripts/environment.py", plan.steps[names.index("backend-mypy")].command)
        self.assertIn("../scripts/dev.py", plan.steps[names.index("backend-mypy")].command)
        self.assertIn("../scripts/run_tests.py", plan.steps[names.index("backend-mypy")].command)
        self.assertEqual(
            plan.steps[names.index("frontend-tests")].command,
            ("npm", "test"),
        )
        self.assertEqual(
            plan.steps[names.index("frontend-browser-install")].command,
            ("npm", "exec", "--no", "--", "playwright", "install", "chromium"),
        )
        self.assertEqual(
            plan.steps[names.index("backend-coverage")].serial_group,
            "backend-postgres",
        )
        backend_lane = [step.name for step in plan.steps if step.lane == "backend"]
        self.assertIn("backend-coverage", backend_lane)
        self.assertIn("server-image-build", names)
        self.assertNotIn("fullstack", names)
        self.assertNotIn("frontend-browser", names)
        self.assertNotIn("frontend-coverage-plan", names)

    def test_image_build_follows_the_frontend_build_and_coverage_gates_other_lanes(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"), coverage_stacks=3)
        names = [step.name for step in plan.steps]
        image = plan.steps[names.index("server-image-build")]
        coverage = plan.steps[names.index("backend-coverage")]

        self.assertEqual(image.lane, "frontend")
        self.assertLess(names.index("frontend-build"), names.index("server-image-build"))
        self.assertEqual(
            (coverage.ready_marker, coverage.ready_count),
            ("Full-stack: private Storage initialization", 3),
        )
        one_stack = prepush.build_plan(all_gate_scope(), Path("/repo"), coverage_stacks=1)
        self.assertEqual(
            next(s for s in one_stack.steps if s.name == "backend-coverage").ready_count, 1
        )
        image_only = prepush.build_plan(
            ci_scope.classify_paths(["infra/docker/backend.Dockerfile"], base_ref="base"),
            Path("/repo"),
        )
        self.assertEqual(image_only.steps[-1].lane, "server")

    def test_plan_runs_packaging_backup_lint_type_and_contract_checks(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        commands = {step.name: step.command for step in plan.steps}

        self.assertIn("../packaging/backup", commands["backend-ruff"])
        self.assertIn("../packaging/backup/backup_installation.py", commands["backend-mypy"])
        self.assertIn("../packaging/backup/restore_installation.py", commands["backend-mypy"])
        self.assertEqual(
            commands["packaging-backup-tests"],
            (
                "uv",
                "run",
                "pytest",
                "../packaging/backup/tests",
                "--no-cov",
                "--basetemp",
                ".backup-contracts",
            ),
        )

    def test_plan_builds_the_unified_server_image_for_each_application_change(self):
        frontend_scope = ci_scope.classify_paths(
            ["frontend/src/components/systems/manage/page.tsx"], base_ref="base"
        )
        backend_scope = ci_scope.classify_paths(
            ["backend/app/systems/users/service.py"], base_ref="base"
        )

        frontend_names = [
            step.name for step in prepush.build_plan(frontend_scope, Path("/repo")).steps
        ]
        backend_names = [
            step.name for step in prepush.build_plan(backend_scope, Path("/repo")).steps
        ]
        self.assertIn("frontend-build", frontend_names)
        self.assertIn("server-image-build", frontend_names)
        self.assertIn("server-image-build", backend_names)

    def test_server_image_only_change_builds_once_without_application_tests(self):
        plan = prepush.build_plan(
            ci_scope.classify_paths(["infra/docker/backend.Dockerfile"], base_ref="base"),
            Path("/repo"),
        )
        names = [step.name for step in plan.steps]

        self.assertNotIn("frontend-check", names)
        self.assertNotIn("frontend-tests", names)
        self.assertNotIn("frontend-build", names)
        self.assertEqual(names.count("server-image-build"), 1)

    def test_list_mode_prints_plan_without_executing_steps(self):
        scope = all_gate_scope()
        output = io.StringIO()
        with (
            patch.object(prepush, "classify_changes", return_value=scope),
            patch.object(prepush, "execute_plan") as execute,
            redirect_stdout(output),
        ):
            result = prepush.main(["--base", "base", "--list"])

        self.assertEqual(result, 0)
        execute.assert_not_called()
        self.assertIn('"frontend"', output.getvalue())
        self.assertNotIn('"fullstack"', output.getvalue())

    def test_main_returns_shell_interrupt_status_without_a_traceback(self):
        scope = all_gate_scope()
        with (
            patch.object(prepush, "classify_changes", return_value=scope),
            patch.object(prepush, "execute_plan", side_effect=KeyboardInterrupt),
            patch.object(prepush, "_stop_on_terminate"),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(prepush.main(["--base", "base"]), 130)

    def test_serial_flag_reaches_execution(self):
        with (
            patch.object(prepush, "classify_changes", return_value=all_gate_scope()),
            patch.object(prepush, "execute_plan", return_value=0) as execute,
            patch.object(prepush, "_stop_on_terminate"),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(prepush.main(["--base", "base", "--serial"]), 0)
            self.assertTrue(execute.call_args.kwargs["serial"])
            self.assertEqual(prepush.main(["--base", "base"]), 0)
            self.assertFalse(execute.call_args.kwargs["serial"])

    def test_sigterm_and_sighup_are_handled_like_an_interrupt(self):
        numbers = (signal.SIGTERM, signal.SIGHUP)
        previous = {number: signal.getsignal(number) for number in numbers}
        try:
            prepush._stop_on_terminate()
            for number in numbers:
                handler = signal.getsignal(number)
                assert callable(handler), signal.Signals(number).name
                with self.assertRaises(KeyboardInterrupt):
                    handler(number, None)
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)

    def test_stack_ready_marker_is_the_stage_line_printed_after_migrations(self):
        source = (
            Path(prepush.__file__).resolve().parents[1] / "backend/tests/fullstack_runner.py"
        ).read_text(encoding="utf-8")
        prefix, _, stage = prepush.STACK_READY_MARKER.partition(": ")
        # The runner prints this line as each stage's command starts.
        self.assertIn(f'print(f"{prefix}: {{stage}}", flush=True)', source)
        self.assertEqual(source.count(f'stage = "{stage}"'), 1)
        order = [
            source.index('stage = "migrations"'),
            source.index(f'stage = "{stage}"'),
            source.index('"backend regression and coverage gate"'),
        ]
        self.assertEqual(order, sorted(order))

    def test_execution_returns_first_subprocess_exit_code(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        calls: list[tuple[str, ...]] = []

        def run(command, **_kwargs):
            calls.append(tuple(command))
            return subprocess.CompletedProcess(command, 23)

        with redirect_stdout(io.StringIO()):
            self.assertEqual(prepush.execute_plan(plan, Path("/repo"), run=run), 23)
        self.assertEqual(len(calls), 1)

    def test_execution_reports_success_when_all_steps_pass(self):
        plan = prepush.build_plan(
            ci_scope.classify_paths(["README.md"], base_ref="base"), Path("/repo")
        )
        calls: list[tuple[str, ...]] = []

        def run(command, **_kwargs):
            calls.append(tuple(command))
            return subprocess.CompletedProcess(command, 0)

        self.assertEqual(prepush.execute_plan(plan, Path("/repo"), run=run), 0)
        self.assertEqual(calls, [])


def step(name: str, lane: str) -> prepush.Step:
    return prepush.Step(name, lane, "resource", ".", (name,), lane=lane)


class FakeProcess:
    """A Popen stand-in whose wait() runs a scripted behavior on the lane thread."""

    def __init__(self, command, behavior, options):
        self.pid = abs(hash(command[0])) % 100000 + 1
        self.command = command
        self.behavior = behavior
        self.options = options

    def wait(self):
        return self.behavior(self)


class LaneExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.logs = Path(self._directory.name)
        self.started: list[str] = []
        self.interrupted: list[str] = []

    def tearDown(self) -> None:
        self._directory.cleanup()

    def execute(self, behaviors, *steps, start_errors=None, **options) -> tuple[int, str]:
        def start(command, **kwargs):
            self.started.append(command[0])
            if command[0] in (start_errors or {}):
                raise start_errors[command[0]]
            return FakeProcess(command, behaviors[command[0]], kwargs)

        def interrupt(process):
            self.interrupted.append(process.command[0])

        def run(command, **_kwargs):
            self.started.append(command[0])
            return subprocess.CompletedProcess(command, behaviors[command[0]](None))

        plan = prepush.PrepushPlan(scope=all_gate_scope(), steps=steps)
        output = io.StringIO()
        with redirect_stdout(output):
            status = prepush.execute_plan(
                plan,
                Path("/repo"),
                run=run,
                start=start,
                interrupt=interrupt,
                log_dir=self.logs,
                heartbeat_seconds=0.05,
                **options,
            )
        return status, output.getvalue()

    def test_serial_flag_runs_lanes_one_after_another_on_the_terminal(self):
        status, _output = self.execute(
            {"front": lambda _p: 0, "back": lambda _p: 0},
            step("front", "frontend"),
            step("back", "backend"),
            serial=True,
        )
        self.assertEqual(status, 0)
        self.assertEqual(self.started, ["front", "back"])

    def test_lanes_run_concurrently_and_write_their_own_logs(self):
        all_running = threading.Barrier(3, timeout=5)

        def behavior(process):
            all_running.wait()
            process.options["stdout"].write(f"output from {process.command[0]}\n")
            return 0

        status, output = self.execute(
            {name: behavior for name in ("frontend-step", "backend-step", "server-step")},
            step("frontend-step", "frontend"),
            step("backend-step", "backend"),
            step("server-step", "server"),
        )

        self.assertEqual(status, 0)
        for lane in ("frontend", "backend", "server"):
            self.assertIn(f"output from {lane}-step", (self.logs / f"{lane}.log").read_text())
        self.assertIn("[backend] backend-step: PASS", output)
        self.assertIn("wall-clock", output)

    def test_a_failed_lane_lets_running_steps_finish_and_starts_nothing_new(self):
        both_running = threading.Barrier(2, timeout=5)
        frontend_failed = threading.Event()

        def fails(process):
            both_running.wait()
            process.options["stdout"].write("the failing assertion\n")
            frontend_failed.set()
            return 7

        def still_running(_process):
            both_running.wait()
            self.assertTrue(frontend_failed.wait(timeout=5))
            return 0

        status, output = self.execute(
            {"frontend-fails": fails, "backend-first": still_running},
            step("frontend-fails", "frontend"),
            step("frontend-after", "frontend"),
            step("backend-first", "backend"),
            step("backend-after", "backend"),
        )

        self.assertEqual(status, 7)
        self.assertEqual(sorted(self.started), ["backend-first", "frontend-fails"])
        self.assertEqual(self.interrupted, [])  # a failure never interrupts running steps
        self.assertIn("backend-first: PASS", output)
        self.assertIn("the failing assertion", output)  # tail of the failed lane's log
        self.assertIn("backend-after: SKIPPED", output)

    def test_a_stop_reaches_each_running_lane_once_and_waits_for_cleanup(self):
        both_running = threading.Barrier(3, timeout=5)
        stopped = threading.Event()
        cleaned: list[str] = []

        def runner(process):
            both_running.wait()
            self.assertTrue(stopped.wait(timeout=5))
            cleaned.append(process.command[0])  # teardown finishes before prepush returns
            return 130

        original = prepush._ParallelLanes.request_stop

        def request_stop(lanes):
            original(lanes)
            original(lanes)  # a repeated stop must not signal a runner mid-teardown
            stopped.set()

        heartbeats: list[int] = []

        def interrupt_once_lanes_run(*_args, **_kwargs):
            heartbeats.append(1)
            if len(heartbeats) > 1:
                return "[lanes] waiting for cleanup"
            both_running.wait()
            raise KeyboardInterrupt

        with (
            patch.object(prepush._ParallelLanes, "request_stop", request_stop),
            patch.object(prepush._ParallelLanes, "status_line", interrupt_once_lanes_run),
            self.assertRaises(KeyboardInterrupt),
        ):
            self.execute(
                {"backend-batch": runner, "frontend-http": runner},
                step("frontend-http", "frontend"),
                step("frontend-build", "frontend"),
                step("backend-batch", "backend"),
            )

        self.assertEqual(sorted(self.interrupted), ["backend-batch", "frontend-http"])
        self.assertEqual(sorted(cleaned), ["backend-batch", "frontend-http"])
        self.assertNotIn("frontend-build", self.started)

    def test_other_lanes_wait_until_every_backend_stack_has_booted(self):
        frontend_started = threading.Event()
        seen_at_start: list[str] = []
        marker = "Full-stack: private Storage initialization"

        def backend(process):
            log = process.options["stdout"]
            for shard in (1, 2):
                log.write(f"[{shard}/3] 10:00:00 {marker}\n")
                log.flush()
                self.assertFalse(frontend_started.wait(timeout=0.3))  # still held
            log.write(f"[3/3] 10:00:01 {marker}\n")
            log.flush()
            self.assertTrue(frontend_started.wait(timeout=5))  # released at the third
            return 0

        def frontend(_process):
            seen_at_start.append((self.logs / "backend.log").read_text())
            frontend_started.set()
            return 0

        gated = prepush.Step(
            "backend-coverage",
            "backend",
            "resource",
            ".",
            ("backend-coverage",),
            lane="backend",
            ready_marker=marker,
            ready_count=3,
        )
        status, output = self.execute(
            {"backend-coverage": backend, "frontend-tests": frontend},
            step("frontend-tests", "frontend"),
            gated,
        )

        self.assertEqual(status, 0)
        self.assertEqual(seen_at_start[0].count(marker), 3)
        self.assertIn("[frontend] waiting for backend stacks", output)

    def test_held_lanes_are_released_when_the_gating_step_ends_without_its_marker(self):
        gated = prepush.Step(
            "backend-coverage",
            "backend",
            "resource",
            ".",
            ("backend-coverage",),
            lane="backend",
            ready_marker="never printed",
            ready_count=3,
        )
        status, _output = self.execute(
            {"backend-coverage": lambda _p: 0, "frontend-tests": lambda _p: 0},
            step("frontend-tests", "frontend"),
            gated,
        )
        self.assertEqual(status, 0)
        self.assertEqual(sorted(self.started), ["backend-coverage", "frontend-tests"])

    def _execute_bounded(self, behaviors, *steps, **options):
        """Run execute() off-thread so a hang fails the test instead of wedging it."""
        runners: list[prepush._ParallelLanes] = []
        original_run = prepush._ParallelLanes.run

        def run(lanes, *args, **kwargs):
            runners.append(lanes)
            return original_run(lanes, *args, **kwargs)

        def release_lanes():
            for lanes in runners:
                lanes.stop.set()
                lanes.ready.set()

        self.addCleanup(release_lanes)
        outcome: dict[str, object] = {}

        def target():
            with patch.object(prepush._ParallelLanes, "run", run):
                try:
                    outcome["result"] = self.execute(behaviors, *steps, **options)
                except BaseException as error:  # surfaced by the assertion below
                    outcome["error"] = error

        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive(), "pre-push lanes hung")
        self.assertNotIn("error", outcome)
        return outcome["result"]

    def test_a_lane_whose_step_cannot_start_fails_the_gate(self):
        status, output = self._execute_bounded(
            {"frontend-step": lambda _p: 0},
            step("frontend-step", "frontend"),
            step("backend-step", "backend"),
            start_errors={"backend-step": ValueError("bad starter argument")},
        )

        self.assertNotEqual(status, 0)
        self.assertIn("Pre-push result: FAIL", output)
        self.assertNotIn("Pre-push result: PASS", output)
        self.assertIn("ValueError: bad starter argument", output)  # traceback in the tail
        self.assertIn("backend-step", output)

    def test_a_gating_backend_lane_that_dies_before_its_marker_fails_without_a_hang(self):
        gated = prepush.Step(
            "backend-coverage",
            "backend",
            "resource",
            ".",
            ("backend-coverage",),
            lane="backend",
            ready_marker="Full-stack: private Storage initialization",
            ready_count=3,
        )
        ticks = iter(range(1000))

        def clock():
            if threading.current_thread().name == "prepush-backend":
                raise RuntimeError("backend lane broke before its first step")
            return float(next(ticks))

        status, output = self._execute_bounded(
            {"frontend-tests": lambda _p: 0, "backend-coverage": lambda _p: 0},
            step("frontend-tests", "frontend"),
            gated,
            clock=clock,
        )

        self.assertNotEqual(status, 0)
        self.assertEqual(self.started, [])  # the held frontend lane never starts either
        self.assertIn("Pre-push result: FAIL", output)
        self.assertIn("RuntimeError: backend lane broke", output)

    def test_parallel_steps_start_in_their_own_process_group(self):
        with patch.object(prepush.subprocess, "Popen") as popen:
            prepush._start_in_own_group(["true"], cwd=Path("."))
        self.assertTrue(popen.call_args.kwargs["start_new_session"])


if __name__ == "__main__":
    unittest.main()
