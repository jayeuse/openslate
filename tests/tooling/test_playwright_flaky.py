"""Contracts for the CI flaky-test ledger check (docs/plans/ci-stability.md D1)."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from scripts import playwright_flaky

ROOT = Path(__file__).resolve().parents[2]
FLAKY = "http/a.spec.ts › Group › renews once"


def report(status: str) -> dict[str, object]:
    return {
        "suites": [
            {
                "title": "http/a.spec.ts",
                "file": "http/a.spec.ts",
                "specs": [
                    {
                        "title": "top level",
                        "file": "http/a.spec.ts",
                        "tests": [{"projectName": "http", "status": "expected"}],
                    }
                ],
                "suites": [
                    {
                        "title": "Group",
                        "file": "http/a.spec.ts",
                        "specs": [
                            {
                                "title": "renews once",
                                "file": "http/a.spec.ts",
                                "tests": [{"projectName": "http", "status": status}],
                            }
                        ],
                    }
                ],
            }
        ]
    }


class PlaywrightFlakyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.summary = self.root / "summary.md"

    def run_check(self, status: str, entries: list[dict[str, str]]) -> tuple[int, str]:
        (self.root / "report.json").write_text(json.dumps(report(status)))
        (self.root / "flaky.json").write_text(json.dumps({"tests": entries}))
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(self.summary)}):
            with redirect_stdout(output):
                code = playwright_flaky.main(
                    [
                        str(self.root / "report.json"),
                        "--ledger",
                        str(self.root / "flaky.json"),
                        "--today",
                        "2026-11-05",
                    ]
                )
        return code, output.getvalue()

    @staticmethod
    def entry(expires: str = "2026-11-10", added: str = "2026-10-31") -> dict[str, str]:
        return {
            "test": FLAKY,
            "owner": "jayeuse",
            "added": added,
            "expires": expires,
            "reason": "focus listener race",
        }

    def test_an_unlisted_flaky_test_fails_the_check(self):
        code, stdout = self.run_check("flaky", [])

        self.assertEqual(code, 1)
        self.assertIn(f"::error title=Flaky test ledger::{FLAKY}: passed only on retry", stdout)
        self.assertIn("not in the flaky ledger", self.summary.read_text())

    def test_a_listed_flaky_test_passes_and_shows_in_the_summary(self):
        code, stdout = self.run_check("flaky", [self.entry()])

        self.assertEqual(code, 0)
        self.assertEqual(stdout, "")
        self.assertIn(
            "known until 2026-11-10 (jayeuse): focus listener race", self.summary.read_text()
        )

    def test_an_expired_entry_fails_when_the_test_flakes_again(self):
        code, stdout = self.run_check("flaky", [self.entry(expires="2026-11-04")])

        self.assertEqual(code, 1)
        self.assertIn("its entry expired on 2026-11-04", stdout)

    def test_an_expired_entry_for_a_stable_test_does_not_fail(self):
        code, _ = self.run_check("expected", [self.entry(expires="2026-11-04")])

        self.assertEqual(code, 0)
        self.assertIn("No test passed only on its retry.", self.summary.read_text())

    def test_an_entry_longer_than_fourteen_days_or_without_an_owner_is_refused(self):
        long_entry = self.entry(added="2026-10-20", expires="2026-11-10")
        no_owner = {**self.entry(), "test": "http/b.spec.ts › other", "owner": ""}

        code, stdout = self.run_check("expected", [long_entry, no_owner])

        self.assertEqual(code, 1)
        self.assertIn("expires more than 14 days after it was added", stdout)
        self.assertIn("lacks owner", stdout)

    def test_a_real_failure_is_not_a_flaky_test(self):
        code, _ = self.run_check("unexpected", [])

        self.assertEqual(code, 0)

    def test_the_committed_ledger_is_valid(self):
        entries, errors = playwright_flaky.load_ledger(ROOT / "frontend/tests/flaky.json")

        self.assertEqual(errors, [])
        self.assertIsInstance(entries, dict)


if __name__ == "__main__":
    unittest.main()
