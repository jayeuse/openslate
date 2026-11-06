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
NEXT_SUNDAY = date(2026, 11, 15)
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
        self.assertEqual(stress_selection.budget_ms(75), 236842)

    def test_a_spec_above_the_budget_takes_its_turn_on_sundays_only(self):
        small, big = "frontend/tests/http/small.spec.ts", "frontend/tests/http/big.spec.ts"
        weights = {"http/small.spec.ts": 100, "http/big.spec.ts": 900}

        for today, expected in ((SUNDAY, big), (SATURDAY, None)):
            with self.subTest(today=today):
                self.assertEqual(
                    stress_selection.large_spec_turn([small, big], weights, 500, today), expected
                )

    def test_no_spec_takes_a_turn_when_every_spec_fits_the_budget(self):
        path = "frontend/tests/http/small.spec.ts"

        self.assertIsNone(
            stress_selection.large_spec_turn([path], {"http/small.spec.ts": 100}, 500, SUNDAY)
        )

    def test_several_large_specs_take_turns_week_by_week(self):
        first, second = "frontend/tests/http/a.spec.ts", "frontend/tests/http/b.spec.ts"
        weights = {"http/a.spec.ts": 900, "http/b.spec.ts": 900}
        turns = {
            stress_selection.large_spec_turn([first, second], weights, 500, today)
            for today in (SUNDAY, NEXT_SUNDAY)
        }

        self.assertEqual(turns, {first, second})

    def test_a_large_spec_runs_alone_on_its_night_and_others_run_on_the_rest(self):
        small, big = "frontend/tests/http/small.spec.ts", "frontend/tests/http/big.spec.ts"
        with tempfile.TemporaryDirectory() as directory:
            weights = Path(directory) / "weights.json"
            weights.write_text(
                json.dumps({"files": {"http/small.spec.ts": 1000, "http/big.spec.ts": 300000}})
            )

            def selected(today: date) -> list[str]:
                output = io.StringIO()
                with (
                    mock.patch.object(stress_selection, "changed_specs", return_value=[small, big]),
                    contextlib.redirect_stdout(output),
                ):
                    stress_selection.main(
                        [
                            "--weights",
                            str(weights),
                            "--budget-minutes",
                            "75",
                            "--today",
                            today.isoformat(),
                        ]
                    )
                return output.getvalue().splitlines()

            self.assertEqual(selected(SUNDAY), ["tests/http/big.spec.ts"])
            self.assertEqual(selected(SATURDAY), ["tests/http/small.spec.ts"])

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
