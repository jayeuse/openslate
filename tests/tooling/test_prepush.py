"""Focused contract tests for the local pre-push orchestration plan."""

from __future__ import annotations

import io
import subprocess
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts import ci_scope, prepush


def all_gate_scope() -> ci_scope.ChangeScope:
    return ci_scope.classify_paths(["scripts/prepush.py"], base_ref="base")


class PrepushTests(unittest.TestCase):
    def test_plan_keeps_frontend_lean_and_backend_independent(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        names = [step.name for step in plan.steps]
        phases = [step.phase for step in plan.steps]

        self.assertEqual(phases, sorted(phases, key=("fast", "resource").index))
        self.assertLess(names.index("frontend-check"), names.index("frontend-tests"))
        self.assertLess(names.index("frontend-check"), names.index("frontend-browser-install"))
        self.assertLess(names.index("frontend-browser-install"), names.index("frontend-tests"))
        self.assertLess(names.index("frontend-tests"), names.index("frontend-container-build"))
        self.assertNotIn("frontend-build", names)
        self.assertLess(names.index("backend-ruff"), names.index("backend-coverage"))
        self.assertLess(names.index("backend-mypy"), names.index("backend-coverage"))
        self.assertIn("../scripts", plan.steps[names.index("backend-ruff")].command)
        self.assertIn("../tests/tooling", plan.steps[names.index("backend-ruff")].command)
        self.assertIn("operations", plan.steps[names.index("backend-mypy")].command)
        self.assertIn("../scripts/ci_scope.py", plan.steps[names.index("backend-mypy")].command)
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
            plan.steps[names.index("frontend-container-build")].command[:2],
            ("python3", "scripts/build_frontend_image.py"),
        )
        self.assertEqual(
            plan.steps[names.index("backend-coverage")].serial_group,
            "backend-postgres",
        )
        backend_lane = [step.name for step in plan.steps if step.lane == "backend"]
        self.assertLess(
            backend_lane.index("backend-coverage"),
            backend_lane.index("backend-container-build"),
        )
        self.assertNotIn("fullstack", names)
        self.assertNotIn("frontend-browser", names)
        self.assertNotIn("frontend-coverage-plan", names)

    def test_plan_runs_packaging_backup_lint_type_and_contract_checks(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        commands = {step.name: step.command for step in plan.steps}

        self.assertIn("../packaging/backup", commands["backend-ruff"])
        self.assertIn("../packaging/backup/backup_installation.py", commands["backend-mypy"])
        self.assertEqual(
            commands["packaging-backup-tests"],
            (
                "uv",
                "run",
                "pytest",
                "../packaging/backup/tests/test_backup_installation.py",
                "--no-cov",
                "--basetemp",
                ".backup-contracts",
            ),
        )

    def test_plan_builds_only_the_changed_application_image(self):
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
        self.assertNotIn("frontend-container-build", frontend_names)
        self.assertIn("frontend-build", frontend_names)
        self.assertNotIn("backend-container-build", frontend_names)
        self.assertNotIn("frontend-container-build", backend_names)
        self.assertIn("backend-container-build", backend_names)

    def test_container_only_frontend_change_builds_once_without_tests(self):
        plan = prepush.build_plan(
            ci_scope.classify_paths(["infra/docker/frontend.Dockerfile"], base_ref="base"),
            Path("/repo"),
        )
        names = [step.name for step in plan.steps]

        self.assertNotIn("frontend-check", names)
        self.assertNotIn("frontend-tests", names)
        self.assertNotIn("frontend-build", names)
        self.assertEqual(names.count("frontend-container-build"), 1)
        self.assertIn("frontend-container-boundary", names)

    def test_resource_lanes_run_serially_on_the_local_host(self):
        calls = []

        def run(command, **_kwargs):
            calls.append(tuple(command))
            return subprocess.CompletedProcess(command, 0)

        plan = prepush.PrepushPlan(
            scope=all_gate_scope(),
            steps=(
                prepush.Step(
                    "frontend-resource", "frontend", "resource", ".", ("front",), lane="frontend"
                ),
                prepush.Step(
                    "backend-resource", "backend", "resource", ".", ("back",), lane="backend"
                ),
            ),
        )

        self.assertEqual(prepush.execute_plan(plan, Path("/repo"), run=run), 0)
        self.assertEqual(calls, [("front",), ("back",)])

    def test_failed_lane_stops_later_resource_work(self):
        calls: list[tuple[str, ...]] = []

        def run(command, **_kwargs):
            calls.append(tuple(command))
            return subprocess.CompletedProcess(command, 7 if command == ["frontend-fails"] else 0)

        plan = prepush.PrepushPlan(
            scope=all_gate_scope(),
            steps=(
                prepush.Step(
                    "frontend-fails",
                    "frontend",
                    "resource",
                    ".",
                    ("frontend-fails",),
                    lane="frontend",
                ),
                prepush.Step(
                    "frontend-after",
                    "frontend",
                    "resource",
                    ".",
                    ("frontend-after",),
                    lane="frontend",
                ),
                prepush.Step(
                    "backend-first", "backend", "resource", ".", ("backend-first",), lane="backend"
                ),
                prepush.Step(
                    "backend-after", "backend", "resource", ".", ("backend-after",), lane="backend"
                ),
            ),
        )

        self.assertEqual(prepush.execute_plan(plan, Path("/repo"), run=run), 7)
        self.assertNotIn(("frontend-after",), calls)
        self.assertNotIn(("backend-first",), calls)
        self.assertNotIn(("backend-after",), calls)

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
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(prepush.main(["--base", "base"]), 130)

    def test_execution_returns_first_subprocess_exit_code(self):
        plan = prepush.build_plan(all_gate_scope(), Path("/repo"))
        calls: list[tuple[str, ...]] = []

        def run(command, **_kwargs):
            calls.append(tuple(command))
            return subprocess.CompletedProcess(command, 23)

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


if __name__ == "__main__":
    unittest.main()
