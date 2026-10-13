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

    def test_source_consuming_workflows_checkout_the_event_head_consistently(self):
        ref = "${{ github.event.pull_request.head.sha || github.sha }}"
        for workflow in ("frontend.yml", "backend.yml"):
            checkouts = [
                step
                for step in re.split(r"(?m)^      - ", self.source(workflow))[1:]
                if re.search(r"(?m)^\s*uses: actions/checkout@", step)
            ]
            with self.subTest(workflow=workflow):
                self.assertTrue(checkouts)
            for index, checkout in enumerate(checkouts, 1):
                with self.subTest(workflow=workflow, checkout=index):
                    self.assertEqual(re.findall(r"(?m)^          ref: (.+)$", checkout), [ref])

    def test_frontend_runs_check_build_and_sharded_tests_in_parallel(self):
        source = self.source("frontend.yml")

        self.assertEqual(
            self.jobs(source), ["changes", "check", "build", "isolated", "test", "verify"]
        )
        self.assertEqual(source.count("npm ci --prefer-offline --no-audit --no-fund"), 4)
        self.assertIn("npm run check", source)
        self.assertIn("npm run build", source)
        self.assertIn("npm test -- --project=http --workers=2 --test-list=", source)
        isolated = source.split("\n  isolated:\n", 1)[1].split("\n  test:\n", 1)[0]
        self.assertIn("run: npm test -- --project=isolated", isolated)
        # One isolated test drives next dev in Chromium.
        self.assertIn("playwright install --with-deps chromium", isolated)
        self.assertNotIn("download-artifact", isolated)
        for shard in range(1, 7):
            with self.subTest(shard=shard):
                self.assertIn(f"duration-shard: {shard}", source)
        self.assertNotIn("--shard=", source)
        self.assertIn("--shard ${{ matrix.duration-shard }} --shards 6", source)
        self.assertIn("--weights tests/http/.test-durations.json", source)
        self.assertIn("--project=http --list --reporter=json", source)
        self.assertIn("python3 ../scripts/playwright_shards.py plan", source)
        self.assertIn("--project=http --workers=2 --test-list=test-results/ci/selected.txt", source)
        self.assertIn("fail-fast: false", source)

    def test_frontend_browser_tests_use_the_built_static_export(self):
        source = self.source("frontend.yml")
        build = source.split("\n  build:\n", 1)[1].split("\n  isolated:\n", 1)[0]
        test = source.split("\n  test:\n", 1)[1].split("\n  verify:\n", 1)[0]

        self.assertIn("name: frontend-export", build)
        self.assertIn("path: frontend/out/", build)
        self.assertIn("if-no-files-found: error", build)
        self.assertIn("needs: [changes, build]", test)
        self.assertIn("uses: actions/download-artifact@", test)
        self.assertIn("name: frontend-export", test)
        # The export server is the production StaticSite code from the backend.
        self.assertIn("run: uv sync --locked", test)
        self.assertIn('version: "0.12.x"', test)

    def test_frontend_verify_preserves_the_required_check(self):
        source = self.source("frontend.yml")
        verify = source.split("\n  verify:\n", 1)[1]

        self.assertIn("needs: [changes, check, build, isolated, test]", verify)
        self.assertIn("if: ${{ always() }}", verify)
        self.assertIn('test "$CHANGES" = "success"', verify)
        for result in ("CHECK", "BUILD", "ISOLATED", "TEST"):
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
            "timing-profile",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, source.lower())

    def test_frontend_uploads_the_export_reports_and_only_failed_test_context(self):
        source = self.source("frontend.yml")
        test = source.split("\n  test:\n", 1)[1].split("\n  verify:\n", 1)[0]
        upload = test.split("uses: actions/upload-artifact@", 1)

        # The export and two native reports supplement the existing failure context.
        self.assertEqual(source.count("upload-artifact"), 4)
        self.assertEqual(test.count("upload-artifact"), 2)
        self.assertIn("if: failure()", upload[0].rsplit("- name:", 1)[1])
        self.assertIn("path: frontend/test-results/playwright/", upload[1])

    def test_frontend_retains_native_reports_even_on_failure_and_requires_the_report(self):
        source = self.source("frontend.yml")
        isolated = source.split("\n  isolated:\n", 1)[1].split("\n  test:\n", 1)[0]
        http = source.split("\n  test:\n", 1)[1].split("\n  verify:\n", 1)[0]

        for job, suffix, artifact in (
            (isolated, "isolated", "frontend-playwright-isolated"),
            (
                http,
                "http-${{ strategy.job-index }}",
                "frontend-playwright-http-${{ strategy.job-index }}",
            ),
        ):
            with self.subTest(artifact=artifact):
                report = f"test-results/ci/{suffix}"
                identity, upload = job.split("- name: Keep the native Playwright report", 1)
                self.assertIn(f"PLAYWRIGHT_JSON_OUTPUT_NAME: {report}.json", job)
                self.assertIn("--reporter=line,json", job)
                # A metadata-only upload must not hide a missing native report.
                self.assertIn(f"test -s {report}.json", identity)
                self.assertIn('"$(git rev-parse HEAD)" "$(git rev-parse HEAD^{tree})"', identity)
                self.assertIn('"$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$GITHUB_JOB"', identity)
                self.assertIn("if: ${{ always() }}", upload)
                self.assertIn(f"name: {artifact}", upload)
                self.assertIn(f"frontend/{report}.json", upload)
                self.assertIn(f"frontend/{report}.metadata.txt", upload)
                self.assertIn("retention-days: 14", upload)
                self.assertIn("if-no-files-found: error", upload)
        self.assertIn("duration-shard=%s/6", http)
        self.assertIn("frontend/test-results/ci/assignment.json", http)

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
            "unit",
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
            [
                "changes",
                "quality",
                "unit",
                "coverage",
                "coverage-gate",
                "reset-acceptance",
                "container",
            ],
        )
        self.assertIn("if: ${{ always() }}", source)
        self.assertIn("CHANGES: ${{ needs.changes.result }}", source)
        self.assertIn('test "$CHANGES" = "success"', source)
        for result in ("UNIT", "COVERAGE", "COVERAGE_GATE", "RESET"):
            with self.subTest(result=result):
                self.assertIn(f'test "${result}" = "success"', source)
        self.assertIn("run_server_image", source)
        self.assertIn("scope=openslate-server", source)
        self.assertIn("Build unified FastAPI server image", source)

    def test_backend_coverage_shards_combine_before_the_gate(self):
        source = self.source("backend.yml")
        coverage = source.split("\n  coverage:\n", 1)[1].split("\n  coverage-gate:\n", 1)[0]
        gate = source.split("\n  coverage-gate:\n", 1)[1].split("\n  reset-acceptance:\n", 1)[0]

        self.assertIn("shard: [1, 2, 3, 4, 5]", coverage)
        self.assertIn("fail-fast: false", coverage)
        self.assertIn(
            "tests.fullstack_runner --backend-coverage-shard ${{ matrix.shard }}/5", coverage
        )
        self.assertIn("name: backend-coverage-shard-${{ matrix.shard }}", coverage)
        unit = source.split("\n  unit:\n", 1)[1].split("\n  coverage:\n", 1)[0]
        self.assertIn("tests/backend_coverage.py unit --workers 4", unit)
        self.assertIn("name: backend-coverage-unit", unit)
        self.assertNotIn("fullstack_runner", unit)
        self.assertIn("needs: [changes, unit, coverage]", gate)
        self.assertIn("fetch-depth: 0", gate)
        self.assertIn("pattern: backend-coverage-*", gate)
        self.assertIn("tests/backend_coverage.py combine", gate)
        self.assertIn("--shards 5", gate)
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
