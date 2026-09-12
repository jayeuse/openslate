"""Focused contract tests for CI change classification."""

from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import ci_scope


class CiScopeTests(unittest.TestCase):
    def test_changed_paths_include_committed_staged_unstaged_and_untracked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._git(root, "init", "-q")
            self._git(root, "config", "user.email", "ci@example.invalid")
            self._git(root, "config", "user.name", "CI Test")
            self._write(root, "backend/base.py")
            self._git(root, "add", ".")
            self._git(root, "commit", "-qm", "base")
            base = self._git(root, "rev-parse", "HEAD").stdout.strip()

            self._write(root, "frontend/committed.ts")
            self._git(root, "add", ".")
            self._git(root, "commit", "-qm", "committed")
            self._write(root, "backend/staged.py")
            self._git(root, "add", "backend/staged.py")
            self._write(root, "frontend/unstaged.ts")
            self._write(root, "frontend/untracked.ts")

            self.assertEqual(
                ci_scope.collect_changed_paths(root, base),
                (
                    "backend/staged.py",
                    "frontend/committed.ts",
                    "frontend/unstaged.ts",
                    "frontend/untracked.ts",
                ),
            )

    def test_exact_sample_changes_keep_fullstack_as_a_noop(self):
        scope = ci_scope.classify_paths(
            [
                "frontend/src/components/sample/manage/index.tsx",
                "frontend/tests/browser/sample/manage.spec.ts",
                "frontend/tests/isolated/manage-state.spec.ts",
                "frontend/CONTROLS-ACCEPTANCE.md",
            ],
            base_ref="base",
        )

        self.assertTrue(scope.decisions["frontend"].run)
        self.assertTrue(scope.decisions["containers"].run)
        self.assertTrue(scope.decisions["frontend_container"].run)
        self.assertFalse(scope.decisions["backend_container"].run)
        self.assertFalse(scope.decisions["backend"].run)
        self.assertFalse(scope.decisions["fullstack"].run)
        self.assertTrue(scope.decisions["docs"].run)
        self.assertIn("local sample", scope.decisions["fullstack"].reason.lower())

    def test_shared_ci_paths_select_all_functional_gates(self):
        scope = ci_scope.classify_paths(
            ["scripts/prepush.py", ".github/workflows/frontend.yml"],
            base_ref="base",
        )

        for name in ("frontend", "backend", "containers", "fullstack"):
            with self.subTest(gate=name):
                self.assertTrue(scope.decisions[name].run)
        self.assertTrue(scope.decisions["frontend_container"].run)
        self.assertTrue(scope.decisions["backend_container"].run)
        self.assertFalse(scope.decisions["docs"].run)

    def test_unknown_paths_fail_closed_to_all_decisions(self):
        scope = ci_scope.classify_paths([".vscode/settings.json"], base_ref="base")

        for name in ci_scope.GATE_NAMES:
            with self.subTest(gate=name):
                self.assertTrue(scope.decisions[name].run)
        self.assertIn("unclassified", scope.decisions["fullstack"].reason.lower())

    def test_base_resolution_failure_fails_closed(self):
        scope = ci_scope.classify_changes(Path.cwd(), "definitely-not-a-revision")

        self.assertIsNotNone(scope.error)
        self.assertEqual(scope.paths, ())
        self.assertTrue(all(decision.run for decision in scope.decisions.values()))
        self.assertIn("classification failed", scope.decisions["frontend"].reason.lower())

    def test_app_specific_changes_only_rebuild_the_matching_image(self):
        frontend = ci_scope.classify_paths(
            ["frontend/src/components/sample/manage/index.tsx"], base_ref="base"
        )
        backend = ci_scope.classify_paths(
            ["backend/app/systems/users/service.py"], base_ref="base"
        )
        frontend_dockerfile = ci_scope.classify_paths(
            ["infra/docker/frontend.Dockerfile"], base_ref="base"
        )
        backend_dockerfile = ci_scope.classify_paths(
            ["infra/docker/backend.Dockerfile"], base_ref="base"
        )
        for scope in (frontend, frontend_dockerfile):
            self.assertTrue(scope.decisions["frontend_container"].run)
            self.assertFalse(scope.decisions["backend_container"].run)
        for scope in (backend, backend_dockerfile):
            self.assertFalse(scope.decisions["frontend_container"].run)
            self.assertTrue(scope.decisions["backend_container"].run)

    def test_shared_docker_context_rebuilds_both_images(self):
        scope = ci_scope.classify_paths([".dockerignore"], base_ref="base")

        self.assertTrue(scope.decisions["frontend_container"].run)
        self.assertTrue(scope.decisions["backend_container"].run)

    def test_frontend_image_helper_is_broad_tooling_and_runs_tooling_tests(self):
        scope = ci_scope.classify_paths(
            ["scripts/build_frontend_image.py"], base_ref="base"
        )

        self.assertTrue(scope.decisions["backend"].run)
        self.assertTrue(scope.decisions["frontend_container"].run)
        self.assertTrue(scope.decisions["backend_container"].run)
        self.assertIn("tooling", scope.decisions["backend"].reason.lower())

    def test_cli_invalid_base_succeeds_with_fail_closed_json_and_github_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "github-output"
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                result = ci_scope.main(
                    ["--base", "0" * 40, "--github-output", str(output_path)]
                )

            payload = json.loads(stdout.getvalue())
            output = dict(
                line.split("=", 1)
                for line in output_path.read_text().splitlines()
                if "=" in line
            )
            self.assertEqual(result, 0)
            self.assertEqual(payload["base"], None)
            self.assertTrue(all(item["run"] for item in payload["decisions"].values()))
            self.assertEqual(output["base"], "")
            self.assertEqual(output["run_fullstack"], "true")
            self.assertIn("all-zero", output["reason_fullstack"])

    def test_cli_valid_base_prints_json_and_stable_github_output_entries(self):
        scope = ci_scope.classify_paths(["README.md"], base_ref="verified-base")
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "github-output"
            stdout = io.StringIO()
            with patch.object(ci_scope, "classify_changes", return_value=scope), redirect_stdout(
                stdout
            ):
                result = ci_scope.main(
                    ["--base", "requested-base", "--github-output", str(output_path)]
                )

            payload = json.loads(stdout.getvalue())
            keys = [line.split("=", 1)[0] for line in output_path.read_text().splitlines()]
            self.assertEqual(result, 0)
            self.assertEqual(payload["base"], "verified-base")
            self.assertEqual(
                keys,
                [
                    "base",
                    "run_frontend",
                    "reason_frontend",
                    "run_backend",
                    "reason_backend",
                    "run_containers",
                    "reason_containers",
                    "run_frontend_container",
                    "reason_frontend_container",
                    "run_backend_container",
                    "reason_backend_container",
                    "run_fullstack",
                    "reason_fullstack",
                    "run_docs",
                    "reason_docs",
                ],
            )

    @staticmethod
    def _write(root: Path, relative: str) -> None:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# test\n")

    @staticmethod
    def _git(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *arguments],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
