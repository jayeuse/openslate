"""Contracts for the nightly stress job's spec selection (docs/plans/ci-stability.md S7)."""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from scripts import stress_selection

SUNDAY = date(2026, 11, 8)
SATURDAY = date(2026, 11, 7)


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

    def test_the_budget_fills_75_wall_minutes_on_a_slow_runner(self):
        self.assertEqual(stress_selection.budget_ms(75), 310345)

    @staticmethod
    def selected(today: date, specs: list[str], weights: dict[str, int]) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "weights.json"
            path.write_text(json.dumps({"files": weights}))
            output = io.StringIO()
            with (
                mock.patch.object(stress_selection, "changed_specs", return_value=specs),
                contextlib.redirect_stdout(output),
            ):
                stress_selection.main(
                    ["--weights", str(path), "--budget-minutes", "75", "--today", today.isoformat()]
                )
        return output.getvalue().splitlines()

    def test_a_spec_above_the_budget_runs_alone_on_sundays_and_never_on_other_nights(self):
        small, big = "frontend/tests/http/small.spec.ts", "frontend/tests/http/big.spec.ts"
        weights = {"http/small.spec.ts": 1000, "http/big.spec.ts": 400000}

        # The order matters: a large spec listed first must not use up the other nights.
        for specs in ([small, big], [big, small]):
            with self.subTest(specs=specs):
                self.assertEqual(
                    self.selected(SUNDAY, specs, weights),
                    ["tests/http/big.spec.ts"],
                )
                self.assertEqual(
                    self.selected(SATURDAY, specs, weights),
                    ["tests/http/small.spec.ts"],
                )

    def test_sundays_reach_a_heavy_spec_that_newer_specs_crowd_out_on_other_nights(self):
        newer, new, heavy, light = (
            f"frontend/tests/http/{name}.spec.ts" for name in ("newer", "new", "heavy", "light")
        )
        weights = {
            "http/newer.spec.ts": 160000,
            "http/new.spec.ts": 160000,
            "http/heavy.spec.ts": 250000,
            "http/light.spec.ts": 50000,
        }
        specs = [newer, new, heavy, light]

        self.assertEqual(
            self.selected(SUNDAY, specs, weights),
            ["tests/http/heavy.spec.ts", "tests/http/light.spec.ts"],
        )
        self.assertEqual(
            self.selected(SATURDAY, specs, weights),
            ["tests/http/newer.spec.ts", "tests/http/light.spec.ts"],
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
