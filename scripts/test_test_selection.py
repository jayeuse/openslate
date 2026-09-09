"""Section selection must not silently omit affected safety checks."""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "section_runner", Path(__file__).with_name("test.py")
)
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TestSelectionTests(unittest.TestCase):
    def test_backend_auth_change_includes_security_audit_and_api(self):
        self.assertEqual(
            runner.affected_sections(
                "backend", ["backend/app/systems/users/service.py"]
            ),
            {"security", "audit", "api"},
        )

    def test_field_change_includes_record_consumers(self):
        self.assertEqual(
            runner.affected_sections("frontend", ["frontend/src/lib/field-schema.ts"]),
            {"catalog", "records"},
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
                "frontend", ["frontend/tests/browser/audit/logs.spec.ts"]
            ),
            {"audit"},
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
            {"catalog", "records", "audit"},
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

    def test_frontend_selection_respects_layer_and_excludes_fullstack(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [
                "frontend/tests/isolated/security/request-security.spec.ts",
                "frontend/tests/http/security/session-routes.spec.ts",
                "frontend/tests/browser/security/setup.spec.ts",
                "frontend/tests/fullstack/auth.spec.ts",
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
            self.assertEqual(len(selected), 3)

    def test_backend_selection_assigns_runtime_and_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for path in [
                "tests/runtime/test_readiness.py",
                "tests/migration_0015/test_static.py",
                "tests/test_legacy_delete_api.py",
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
                ["tests/migration_0015/test_static.py"],
            )


if __name__ == "__main__":
    unittest.main()
