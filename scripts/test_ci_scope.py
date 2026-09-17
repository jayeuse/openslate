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

    def test_frontend_changes_never_select_backend_or_container_by_default(self):
        for path in (
            "frontend/src/components/systems/manage/page.tsx",
            "frontend/tests/isolated/manage-state.spec.ts",
            ".github/workflows/frontend.yml",
            ".github/workflows/frontend-compatibility.yml",
            ".github/workflows/fullstack.yml",
        ):
            with self.subTest(path=path):
                scope = ci_scope.classify_paths([path], base_ref="base")
                self.assertTrue(scope.decisions["frontend"].run)
                self.assertFalse(scope.decisions["backend"].run)
                self.assertFalse(scope.decisions["containers"].run)
                self.assertFalse(scope.decisions["frontend_container"].run)
                self.assertFalse(scope.decisions["backend_container"].run)

    def test_frontend_container_inputs_are_narrow_and_explicit(self):
        for path in (
            "frontend/package-lock.json",
            "frontend/next.config.ts",
            "frontend/scripts/start-standalone.mjs",
            "frontend/src/lib/environment.ts",
            "infra/docker/frontend.Dockerfile",
            "scripts/build_frontend_image.py",
        ):
            with self.subTest(path=path):
                scope = ci_scope.classify_paths([path], base_ref="base")
                self.assertTrue(scope.decisions["frontend_container"].run)
                self.assertTrue(scope.decisions["containers"].run)
                self.assertFalse(scope.decisions["backend"].run)
                self.assertFalse(scope.decisions["backend_container"].run)

    def test_backend_changes_keep_backend_and_container_gates(self):
        scope = ci_scope.classify_paths(
            ["backend/app/systems/users/service.py"], base_ref="base"
        )
        self.assertTrue(scope.decisions["backend"].run)
        self.assertTrue(scope.decisions["backend_container"].run)
        self.assertTrue(scope.decisions["containers"].run)
        self.assertFalse(scope.decisions["frontend"].run)
        self.assertFalse(scope.decisions["frontend_container"].run)

    def test_shared_docker_context_rebuilds_both_images(self):
        scope = ci_scope.classify_paths([".dockerignore"], base_ref="base")
        self.assertTrue(scope.decisions["frontend_container"].run)
        self.assertTrue(scope.decisions["backend_container"].run)

    def test_shared_tooling_remains_fail_closed(self):
        scope = ci_scope.classify_paths(["scripts/prepush.py"], base_ref="base")
        for name in ci_scope.GATE_NAMES:
            if name != "docs":
                self.assertTrue(scope.decisions[name].run)

    def test_documentation_only_skips_functional_gates(self):
        scope = ci_scope.classify_paths(["README.md"], base_ref="base")
        self.assertTrue(scope.decisions["docs"].run)
        self.assertTrue(
            all(
                not decision.run
                for name, decision in scope.decisions.items()
                if name != "docs"
            )
        )

    def test_unknown_paths_fail_closed_to_every_decision(self):
        scope = ci_scope.classify_paths([".vscode/settings.json"], base_ref="base")
        self.assertTrue(all(decision.run for decision in scope.decisions.values()))
        self.assertIn("unclassified", scope.decisions["frontend"].reason.lower())

    def test_base_resolution_failure_fails_closed(self):
        scope = ci_scope.classify_changes(Path.cwd(), "definitely-not-a-revision")
        self.assertIsNotNone(scope.error)
        self.assertEqual(scope.paths, ())
        self.assertTrue(all(decision.run for decision in scope.decisions.values()))

    def test_cli_writes_only_the_lean_gate_outputs(self):
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
