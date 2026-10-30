"""Contracts for the CI flake report (docs/plans/ci-stability.md S0)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts import ci_flake_report


def report(**statuses: str) -> dict[str, object]:
    return {
        "suites": [
            {
                "title": "http/a.spec.ts",
                "file": "http/a.spec.ts",
                "specs": [
                    {"title": title, "file": "http/a.spec.ts", "tests": [{"status": status}]}
                    for title, status in statuses.items()
                ],
            }
        ]
    }


class CiFlakeReportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write_run(self, run: str, shard: str, data: dict[str, object]) -> None:
        folder = self.root / run / f"frontend-playwright-{shard}"
        folder.mkdir(parents=True)
        (folder / f"{shard}.json").write_text(json.dumps(data))
        (folder / f"{shard}.metadata.txt").write_text("revision=abc\n")

    def test_counts_failed_and_flaky_runs_per_test(self):
        self.write_run("1", "http-0", report(opens="unexpected", saves="expected"))
        self.write_run("1", "http-1", report(closes="flaky"))
        self.write_run("2", "http-0", report(opens="flaky", saves="expected"))
        self.write_run("3", "http-0", report(opens="unexpected", saves="expected"))

        text = ci_flake_report.summarize(self.root)

        self.assertIn("Runs read: 3; runs with a failed test: 2", text)
        self.assertIn("| `http/a.spec.ts › opens` | 2 | 1 |", text)
        self.assertIn("| `http/a.spec.ts › closes` | 0 | 1 |", text)
        self.assertNotIn("saves", text)
        self.assertLess(text.index("opens"), text.index("closes"))

    def test_an_all_green_window_says_so(self):
        self.write_run("1", "http-0", report(saves="expected"))

        text = ci_flake_report.summarize(self.root)

        self.assertIn("runs with a failed test: 0", text)
        self.assertIn("| (none) | 0 | 0 |", text)


if __name__ == "__main__":
    unittest.main()
