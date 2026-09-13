"""Static contracts for the required GitHub Actions checks."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CiWorkflowContractTests(unittest.TestCase):
    def source(self, name: str) -> str:
        return (ROOT / ".github/workflows" / name).read_text()

    def test_frontend_keeps_stable_aggregator_and_four_allowlisted_coverage_parts(self):
        source = self.source("frontend.yml")

        self.assertRegex(source, r"(?m)^  verify:\n")
        self.assertRegex(source, r"(?m)^    if: \$\{\{ always\(\) \}\}\n")
        for job in (
            "changes",
            "quality",
            "prepare",
            "coverage-parts",
            "coverage-merge",
            "timing-notify",
            "smoke",
            "mobile",
            "extended",
            "verify",
        ):
            self.assertRegex(source, rf"(?m)^  {re.escape(job)}:\n")
        self.assertIn("coverage-merge", source)
        self.assertRegex(source, r"part:\s*\[core, chromium-1, chromium-2, chromium-3\]")
        self.assertIn("fail-fast: false", source)
        self.assertNotIn("fromJSON(needs.prepare.outputs", source)
        self.assertNotIn("coverage/*/playwright/", source)
        self.assertNotIn("coverage/*/node/", source)
        self.assertNotIn("coverage/*/browser/", source)
        self.assertIn("requires 92% migration headroom", source)
        self.assertIn("timing-summary.json", source)
        self.assertIn("summary.degradedRuns >= 3", source)
        self.assertIn("[CI] Frontend coverage timing is degraded", source)

    def test_frontend_prepares_one_runtime_and_runs_only_targeted_pr_browser_lanes(self):
        source = self.source("frontend.yml")

        self.assertRegex(source, r"(?m)^  prepare:\n")
        self.assertIn("frontend-runtime.tgz", source)
        self.assertIn("scripts/package-runtime.cjs", source)
        self.assertIn("test:e2e:smoke:production", source)
        self.assertIn("--project=mobile-chromium", source)
        self.assertIn("test:e2e:extended:production", source)
        self.assertNotRegex(source, r"project:\s*\[chromium, mobile-chromium, firefox, webkit\]")
        self.assertIn("scope=openslate-frontend", source)
        self.assertIn("DOCKER_BUILD_RECORD_UPLOAD: \"false\"", source)
        self.assertNotIn("video", source)

    def test_frontend_uses_explicit_npm_cache_and_short_lived_compact_artifacts(self):
        source = self.source("frontend.yml")

        self.assertIn("cache: npm", source)
        self.assertIn("npm ci --prefer-offline --no-audit --no-fund", source)
        self.assertIn("retention-days: 1", source)
        self.assertIn("retention-days: 14", source)
        self.assertNotIn("node_modules/", source)
        self.assertNotIn("playwright-report/", source)

    def test_compatibility_runs_main_and_nightly_and_manages_one_issue(self):
        source = self.source("frontend-compatibility.yml")

        self.assertIn("name: Frontend Compatibility", source)
        self.assertIn("cron: \"0 18 * * *\"", source)
        self.assertIn("[firefox, webkit]", source)
        self.assertIn("[chromium, mobile-chromium, firefox, webkit]", source)
        self.assertIn("issues: write", source)
        self.assertIn("[CI] Frontend compatibility is failing", source)
        self.assertIn("same business day", source.lower())
        self.assertIn("test:e2e:compatibility", source)
        self.assertNotIn("retain-on-failure", source)

    def test_backend_parallel_gates_feed_stable_verify_aggregator(self):
        source = self.source("backend.yml")

        for job in ("changes", "quality", "coverage", "container", "verify"):
            self.assertRegex(source, rf"(?m)^  {re.escape(job)}:\n")
        self.assertIn("needs: [changes, quality, coverage, container]", source)
        self.assertIn("if: ${{ always() }}", source)
        self.assertIn("CHANGES: ${{ needs.changes.result }}", source)
        self.assertIn('test "$CHANGES" = "success"', source)
        self.assertIn("scope=openslate-backend", source)

    def test_fullstack_keeps_stable_name_and_uses_acceptance_only(self):
        source = self.source("fullstack.yml")

        self.assertIn("name: Full-stack release gate", source)
        self.assertIn("--acceptance-only", source)
        self.assertIn("scripts/ci_scope.py", source)
        self.assertNotIn("python3 - <<'PY'", source)


if __name__ == "__main__":
    unittest.main()
