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
        self.assertIn("npm run build -- --from-process", source)
        self.assertIn("timeout-minutes: 12", source)

    def test_frontend_has_no_browser_coverage_or_artifact_machinery(self):
        source = self.source("frontend.yml")

        for forbidden in (
            "playwright install",
            "test:e2e",
            "coverage",
            "chromium",
            "firefox",
            "webkit",
            "mobile",
            "upload-artifact",
            "download-artifact",
            "timing-profile",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source.lower())

    def test_frontend_container_remains_conditional_and_builds_once(self):
        source = self.source("frontend.yml")

        self.assertIn("run_frontend_container", source)
        self.assertEqual(source.count("docker/build-push-action@v6"), 1)
        self.assertIn("DOCKER_BUILD_RECORD_UPLOAD: \"false\"", source)
        self.assertIn("Assert the frontend container environment boundary", source)
        self.assertIn("scope=openslate-frontend", source)

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
        self.assertIn("scope=openslate-backend", source)

    def test_backend_quality_covers_packaging_backup_contracts(self):
        source = self.source("backend.yml")

        self.assertIn("../packaging/backup", source)
        self.assertIn("../packaging/backup/backup_installation.py", source)
        self.assertIn("../packaging/backup/tests/test_backup_installation.py --no-cov", source)
        self.assertIn("../tests/tooling", source)
        self.assertIn("../scripts/run_tests.py", source)


if __name__ == "__main__":
    unittest.main()
