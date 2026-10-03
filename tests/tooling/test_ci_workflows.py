"""Static contracts for the required GitHub Actions checks."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class CiWorkflowContractTests(unittest.TestCase):
    def source(self, name: str) -> str:
        return (ROOT / ".github/workflows" / name).read_text()

    def jobs(self, source: str) -> list[str]:
        return re.findall(r"(?m)^  ([a-z][a-z0-9-]*):\n", source.split("jobs:\n", 1)[1])

    def test_frontend_runs_check_build_and_sharded_tests_in_parallel(self):
        source = self.source("frontend.yml")

        self.assertEqual(self.jobs(source), ["changes", "check", "build", "test", "verify"])
        self.assertEqual(source.count("npm ci --prefer-offline --no-audit --no-fund"), 3)
        self.assertIn("npm run check", source)
        self.assertIn("npm run build", source)
        self.assertIn("npm test -- ${{ matrix.args }}", source)
        self.assertIn("args: --project=isolated", source)
        for shard in range(1, 5):
            with self.subTest(shard=shard):
                self.assertIn(f"args: --project=http --shard={shard}/4", source)
        self.assertIn("fail-fast: false", source)

    def test_frontend_verify_preserves_the_required_check(self):
        source = self.source("frontend.yml")
        verify = source.split("\n  verify:\n", 1)[1]

        self.assertIn("needs: [changes, check, build, test]", verify)
        self.assertIn("if: ${{ always() }}", verify)
        self.assertIn('test "$CHANGES" = "success"', verify)
        for result in ("CHECK", "BUILD", "TEST"):
            with self.subTest(result=result):
                self.assertIn(f'test "${result}" = "success"', verify)
                self.assertIn(f'test "${result}" = "skipped"', verify)

    def test_frontend_installs_the_locked_playwright_chromium_browser(self):
        source = self.source("frontend.yml")

        self.assertIn("npm exec --no -- playwright install --with-deps chromium", source)
        self.assertIn("path: ~/.cache/ms-playwright", source)
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

        for job in (
            "changes",
            "quality",
            "coverage",
            "coverage-gate",
            "reset-acceptance",
            "container",
            "verify",
        ):
            self.assertRegex(source, rf"(?m)^  {re.escape(job)}:\n")
        verify = source.split("\n  verify:\n", 1)[1]
        needs = re.findall(r"(?m)^      - ([a-z-]+)$", verify.split("    if:", 1)[0])
        self.assertEqual(
            needs,
            ["changes", "quality", "coverage", "coverage-gate", "reset-acceptance", "container"],
        )
        self.assertIn("if: ${{ always() }}", source)
        self.assertIn("CHANGES: ${{ needs.changes.result }}", source)
        self.assertIn('test "$CHANGES" = "success"', source)
        for result in ("COVERAGE", "COVERAGE_GATE", "RESET"):
            with self.subTest(result=result):
                self.assertIn(f'test "${result}" = "success"', source)
        self.assertIn("run_server_image", source)
        self.assertIn("scope=openslate-server", source)
        self.assertIn("Build unified FastAPI server image", source)

    def test_backend_coverage_shards_combine_before_the_gate(self):
        source = self.source("backend.yml")
        coverage = source.split("\n  coverage:\n", 1)[1].split("\n  coverage-gate:\n", 1)[0]
        gate = source.split("\n  coverage-gate:\n", 1)[1].split("\n  reset-acceptance:\n", 1)[0]

        self.assertIn("shard: [1, 2, 3, 4]", coverage)
        self.assertIn("fail-fast: false", coverage)
        self.assertIn(
            "tests.fullstack_runner --backend-coverage-shard ${{ matrix.shard }}/4", coverage
        )
        self.assertIn("name: backend-coverage-shard-${{ matrix.shard }}", coverage)
        self.assertIn("needs: [changes, coverage]", gate)
        self.assertIn("fetch-depth: 0", gate)
        self.assertIn("pattern: backend-coverage-shard-*", gate)
        self.assertIn("tests/backend_coverage.py combine", gate)
        self.assertIn("--shards 4", gate)
        self.assertIn("COVERAGE_BASE_REF: ${{ needs.changes.outputs.base }}", gate)

    def test_backend_requires_a_separate_destructive_reset_acceptance_run(self):
        source = self.source("backend.yml")
        command = "uv run python -m tests.fullstack_runner --reset-acceptance-only"
        reset = source.split("\n  reset-acceptance:\n", 1)[1].split("\n  container:\n", 1)[0]
        self.assertIn(command, reset)
        self.assertNotIn("--backend-coverage", reset)

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
