"""Static contracts for the required GitHub Actions checks."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class CiWorkflowContractTests(unittest.TestCase):
    def source(self, name: str) -> str:
        return (ROOT / ".github/workflows" / name).read_text()

    def test_frontend_is_one_stable_job_with_one_dependency_install(self):
        source = self.source("frontend.yml")
        jobs = re.findall(r"(?m)^  ([a-z][a-z0-9-]*):\n", source.split("jobs:\n", 1)[1])

        self.assertEqual(jobs, ["verify"])
        self.assertEqual(source.count("npm ci --prefer-offline --no-audit --no-fund"), 1)
        self.assertIn("npm run check", source)
        self.assertIn("npm test", source)
        self.assertIn("npm run build", source)
        self.assertIn("timeout-minutes: 25", source)

    def test_frontend_installs_the_locked_playwright_chromium_browser(self):
        source = self.source("frontend.yml")

        self.assertIn("npm exec --no -- playwright install --with-deps chromium", source)
        for forbidden in (
            "test:e2e",
            "coverage",
            "firefox",
            "webkit",
            "mobile",
            "upload-artifact",
            "download-artifact",
            "timing-profile",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source.lower())

    def test_frontend_has_no_production_container_or_runtime_contract(self):
        source = self.source("frontend.yml")

        for forbidden in (
            "run_frontend_container",
            "docker/build-push-action",
            "frontend.Dockerfile",
            "NEXT_PUBLIC_",
            "openslate-frontend",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source)

    def test_removed_browser_workflows_do_not_exist(self):
        self.assertFalse((ROOT / ".github/workflows/frontend-compatibility.yml").exists())
        self.assertFalse((ROOT / ".github/workflows/fullstack.yml").exists())

    def test_backend_parallel_gates_are_unchanged(self):
        source = self.source("backend.yml")

        for job in ("changes", "quality", "coverage", "container", "verify"):
            self.assertRegex(source, rf"(?m)^  {re.escape(job)}:\n")
        self.assertIn("needs: [changes, quality, coverage, container]", source)
        self.assertIn("if: ${{ always() }}", source)
        self.assertIn("CHANGES: ${{ needs.changes.result }}", source)
        self.assertIn('test "$CHANGES" = "success"', source)
        self.assertIn("run_server_image", source)
        self.assertIn("scope=openslate-server", source)
        self.assertIn("Build unified FastAPI server image", source)

    def test_backend_requires_a_separate_destructive_reset_acceptance_run(self):
        source = self.source("backend.yml")
        command = "uv run python -m tests.fullstack_runner --reset-acceptance-only"
        self.assertIn(command, source)
        self.assertLess(source.index("--backend-coverage-only"), source.index(command))

    def test_backend_quality_covers_packaging_backup_contracts(self):
        source = self.source("backend.yml")

        self.assertIn("../packaging/backup", source)
        self.assertIn("../packaging/backup/backup_installation.py", source)
        self.assertIn("../packaging/backup/restore_installation.py", source)
        self.assertIn("uv run pytest ../packaging/backup/tests\n", source)
        self.assertIn("--no-cov --basetemp .backup-contracts", source)
        self.assertIn("../tests/tooling", source)
        self.assertIn("../scripts/environment.py", source)
        self.assertIn("../scripts/dev.py", source)
        self.assertIn("../scripts/run_tests.py", source)

    def test_unified_server_image_uses_injected_process_configuration(self):
        source = (ROOT / "infra/docker/backend.Dockerfile").read_text()
        runtime_stage = source.rsplit("FROM python:3.14-slim", 1)[1]

        self.assertIn("OPENSLATE_ENV_SOURCE=process", runtime_stage)
        self.assertNotIn("COPY .env", runtime_stage)


if __name__ == "__main__":
    unittest.main()
