"""Static contracts for the required GitHub Actions checks."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CiWorkflowContractTests(unittest.TestCase):
    def source(self, name: str) -> str:
        return (ROOT / ".github/workflows" / name).read_text()

    def test_frontend_keeps_verify_aggregator_and_six_coverage_shards(self):
        source = self.source("frontend.yml")

        self.assertRegex(source, r"(?m)^  verify:\n")
        self.assertRegex(source, r"(?m)^    if: \$\{\{ always\(\) \}\}\n")
        self.assertIn("coverage-merge", source)
        self.assertIn("matrix:", source)
        self.assertRegex(source, r"shard:\s*\[1, 2, 3, 4, 5, 6\]")
        self.assertIn("fail-fast: false", source)
        self.assertNotIn("coverage/*/playwright/", source)
        self.assertNotIn("coverage/*/node/", source)
        self.assertNotIn("coverage/*/browser/", source)

    def test_frontend_reuses_one_build_across_parallel_browser_acceptance(self):
        source = self.source("frontend.yml")

        self.assertRegex(source, r"(?m)^  production-build:\n")
        self.assertRegex(source, r"(?m)^  browser:\n")
        self.assertRegex(source, r"project:\s*\[chromium, mobile-chromium, firefox, webkit\]")
        self.assertIn("frontend-production-build", source)
        self.assertIn("--project=${{ matrix.project }}", source)
        self.assertRegex(source, r"(?m)^  container:\n")
        self.assertIn("scope=openslate-frontend", source)

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
