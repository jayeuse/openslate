"""Contracts for the nightly stress job's spec selection (docs/plans/ci-stability.md S7)."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import stress_selection


class StressSelectionTests(unittest.TestCase):
    def test_selection_keeps_order_and_stops_at_the_budget(self):
        specs = [
            "frontend/tests/http/a.spec.ts",
            "frontend/tests/http/b.spec.ts",
            "frontend/tests/http/c.spec.ts",
        ]
        weights = {"http/a.spec.ts": 600, "http/b.spec.ts": 900, "http/c.spec.ts": 300}

        self.assertEqual(
            stress_selection.select(specs, weights, budget_ms=1000),
            ["frontend/tests/http/a.spec.ts", "frontend/tests/http/c.spec.ts"],
        )

    def test_one_spec_runs_even_when_it_exceeds_the_budget(self):
        self.assertEqual(
            stress_selection.select(
                ["frontend/tests/http/big.spec.ts"], {"http/big.spec.ts": 9000}, budget_ms=10
            ),
            ["frontend/tests/http/big.spec.ts"],
        )

    def test_changed_specs_are_newest_first_existing_and_never_the_measurement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*arguments: str) -> None:
                subprocess.run(["git", *arguments], cwd=root, check=True, capture_output=True)

            git("init", "-q")
            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI Test")
            http = root / "frontend/tests/http"
            http.mkdir(parents=True)
            for name in ("old", "new", "gone", "comms-timeline-performance"):
                (http / f"{name}.spec.ts").write_text("// first\n")
                (http / "helper.ts").write_text(name)
                git("add", ".")
                git("commit", "-qm", name)
            (http / "gone.spec.ts").unlink()
            git("add", ".")
            git("commit", "-qm", "remove gone")
            (http / "old.spec.ts").write_text("// second\n")
            git("add", ".")
            git("commit", "-qm", "touch old")

            self.assertEqual(
                stress_selection.changed_specs(7, root),
                ["frontend/tests/http/old.spec.ts", "frontend/tests/http/new.spec.ts"],
            )


if __name__ == "__main__":
    unittest.main()
