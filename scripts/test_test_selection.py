"""Section selection must not silently omit affected safety checks."""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "section_runner", Path(__file__).with_name("test.py")
)
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TestSelectionTests(unittest.TestCase):
    def invoke(self, *arguments):
        with patch.object(sys, "argv", ["test.py", *arguments]), patch.object(
            runner.subprocess, "call", return_value=0
        ) as call:
            self.assertEqual(runner.main(), 0)
            return call.call_args

    def test_local_frontend_batch_runs_only_retained_layers(self):
        call = self.invoke("frontend", "section", "security")
        command = call.args[0]
        self.assertIn("--project=isolated", command)
        self.assertIn("--project=http", command)
        self.assertFalse(any("chromium" in argument for argument in command))

    def test_full_frontend_preserves_configured_matrix(self):
        call = self.invoke("frontend", "full")
        self.assertFalse(any(arg.startswith("--project=") for arg in call.args[0]))
        self.assertIn("tests/isolated/manage-state.spec.ts", call.args[0])
        self.assertIn("tests/http/security/session-routes.spec.ts", call.args[0])
        self.assertFalse(any("tests/browser/" in arg for arg in call.args[0]))
        root = Path(__file__).resolve().parents[1] / "frontend" / "tests"
        expected = {
            path.relative_to(root.parent).as_posix()
            for layer in runner.FRONTEND_LAYERS
            for path in (root / layer).rglob("*.spec.ts")
            if runner.frontend_section(path.relative_to(root.parent).as_posix())
            in runner.SECTIONS["frontend"]
        }
        self.assertEqual({arg for arg in call.args[0] if arg.endswith(".spec.ts")}, expected)

    def test_backend_named_case_disables_coverage_and_stops_at_failure(self):
        call = self.invoke("backend", "section", "security", "--layer", "isolated",
                           "--match", "invitation")
        self.assertIn("--no-cov", call.args[0])
        self.assertIn("-x", call.args[0])
        self.assertEqual(call.args[0][call.args[0].index("-k") + 1], "invitation")

    def test_full_mode_rejects_local_filters(self):
        with (
            patch.object(sys, "argv", ["test.py", "frontend", "full", "--match", "login"]),
            self.assertRaises(SystemExit) as raised,
        ):
            runner.main()
        self.assertEqual(raised.exception.code, 2)

    def test_backend_integration_batch_owns_its_database_and_can_stay_warm(self):
        call = self.invoke("backend", "section", "runtime", "--layer", "integration",
                           "--interactive", "--match", "readiness")
        command = call.args[0]
        self.assertEqual(command[:5], ["uv", "run", "python", "-m", "tests.fullstack_runner"])
        self.assertIn("--backend-batch", command)
        self.assertIn("--interactive", command)
        self.assertIn("--layer=integration", command)
        self.assertIn("--match=readiness", command)

    def test_backend_auth_change_includes_security_audit_and_api(self):
        self.assertEqual(
            runner.affected_sections(
                "backend", ["backend/app/systems/users/service.py"]
            ),
            {"security", "audit", "api"},
        )

    def test_sample_changes_include_connected_workspace_and_canvas_checks(self):
        for path in [
            "frontend/src/components/sample/access/model.ts",
            "frontend/src/components/sample/comms/message-policy.ts",
            "frontend/src/components/sample/sandbox/index.tsx",
            "frontend/src/app/(app)/(workspace)/[pillar]/page.tsx",
            "frontend/src/components/sandbox/sandbox-canvas.tsx",
            "frontend/src/lib/sandbox/model.ts",
        ]:
            with self.subTest(path=path):
                self.assertEqual(
                    runner.affected_sections("frontend", [path]),
                    {"sample", "sandbox"},
                )
                selected = runner.select_files(
                    Path(__file__).resolve().parents[1],
                    "frontend",
                    runner.affected_sections("frontend", [path]),
                    "all",
                )
                self.assertTrue({
                    f"tests/isolated/comms/{name}.spec.ts"
                    for name in ("notifications", "configuration", "tools", "message-policy")
                }.issubset(selected))

    def test_retained_redirects_include_workspace_and_navigation_checks(self):
        for path in [
            "frontend/src/app/(app)/departments/[...legacyPath]/page.tsx",
            "frontend/src/app/(app)/modules/[...legacyPath]/page.tsx",
            "frontend/src/app/(app)/administration/[...legacyPath]/page.tsx",
            "frontend/src/app/(app)/settings/workspace/page.tsx",
            "frontend/src/app/(app)/workspace/page.tsx",
        ]:
            with self.subTest(path=path):
                self.assertEqual(
                    runner.affected_sections("frontend", [path]),
                    {"sample", "shell"},
                )

    def test_shared_and_unknown_application_changes_select_every_section(self):
        for path in [
            "backend/app/core/config/settings.py",
            "backend/app/new_system.py",
        ]:
            self.assertEqual(
                runner.affected_sections("backend", [path]),
                set(runner.SECTIONS["backend"]),
            )
        self.assertEqual(
            runner.affected_sections("frontend", ["frontend/src/lib/api.ts"]),
            set(runner.SECTIONS["frontend"]),
        )

    def test_test_changes_stay_with_their_section(self):
        self.assertEqual(
            runner.affected_sections(
                "frontend", ["frontend/tests/isolated/access/controller.spec.ts"]
            ),
            {"sample"},
        )
        self.assertEqual(
            runner.affected_sections(
                "backend", ["backend/tests/runtime/test_boundaries.py"]
            ),
            {"runtime"},
        )

    def test_deleted_runtime_test_path_still_maps_to_runtime(self):
        self.assertEqual(
            runner.affected_sections(
                "backend", ["backend/tests/test_runtime_settings.py"]
            ),
            {"runtime"},
        )

    def test_shared_test_helpers_select_every_section(self):
        self.assertEqual(
            runner.affected_sections(
                "frontend", ["frontend/tests/helpers/test-secret.ts"]
            ),
            set(runner.SECTIONS["frontend"]),
        )
        self.assertEqual(
            runner.affected_sections("backend", ["backend/tests/conftest.py"]),
            set(runner.SECTIONS["backend"]),
        )

    def test_documentation_alone_does_not_select_tests(self):
        self.assertEqual(
            runner.affected_sections(
                "backend", ["README.md", "docs/architecture/16-testing-architecture.md"]
            ),
            set(),
        )

    def test_test_runner_changes_select_every_section(self):
        for project in runner.SECTIONS:
            self.assertEqual(
                runner.affected_sections(project, ["scripts/test.py"]),
                set(runner.SECTIONS[project]),
            )

    def test_backend_contract_change_selects_frontend_consumers(self):
        self.assertEqual(
            runner.affected_sections(
                "frontend", ["backend/app/systems/fields/validation.py"]
            ),
            set(runner.SECTIONS["frontend"]),
        )

    def test_login_and_setup_changes_include_public_route_checks(self):
        for path in [
            "frontend/src/app/login/page.tsx",
            "frontend/src/app/auth/setup/page.tsx",
        ]:
            self.assertEqual(
                runner.affected_sections("frontend", [path]), {"security", "public"}
            )

    def test_migration_changes_select_all_sections(self):
        for project in runner.SECTIONS:
            self.assertEqual(
                runner.affected_sections(
                    project, ["backend/migrations/versions/new_revision.py"]
                ),
                set(runner.SECTIONS[project]),
            )

    def test_cli_rejects_unknown_sections_and_incompatible_layers(self):
        for arguments in [
            ["backend", "section", "securty", "--list"],
            ["frontend", "section", "security", "--layer", "integration", "--list"],
            ["backend", "full", "security", "--list"],
            ["backend", "section", "--list"],
        ]:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("test.py")), *arguments],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2)

    def test_frontend_selection_respects_the_two_retained_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [
                "frontend/tests/isolated/security/request-security.spec.ts",
                "frontend/tests/http/security/session-routes.spec.ts",
            ]
            for path in paths:
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.touch()
            selected = runner.select_files(root, "frontend", {"security"}, "isolated")
            self.assertEqual(
                selected, ["tests/isolated/security/request-security.spec.ts"]
            )
            selected = runner.select_files(root, "frontend", {"security"}, "all")
            self.assertEqual(len(selected), 2)

    def test_backend_selection_assigns_runtime_and_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in [
                "tests/runtime/test_readiness.py",
                "tests/migration_0015/test_static.py",
                "tests/catalog/test_legacy_delete_api.py",
                "tests/operations/test_disposable_database_guard.py",
            ]:
                file = root / "backend" / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.touch()
            self.assertEqual(
                runner.select_files(root, "backend", {"runtime"}, "all"),
                ["tests/runtime/test_readiness.py"],
            )
            self.assertEqual(
                runner.select_files(root, "backend", {"database"}, "all"),
                [
                    "tests/migration_0015/test_static.py",
                    "tests/operations/test_disposable_database_guard.py",
                ],
            )
            self.assertEqual(
                runner.select_files(root, "backend", {"api"}, "all"),
                ["tests/catalog/test_legacy_delete_api.py"],
            )


if __name__ == "__main__":
    unittest.main()
