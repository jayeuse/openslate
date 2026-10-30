"""Contracts for the report-only CI measurement summary."""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from scripts import measure_summary


class MeasureSummaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write_metrics(self, name: str, newest_ms: float) -> None:
        folder = self.root / name
        folder.mkdir()
        report = {
            "newest50_ms": newest_ms,
            "opening": {"removedRows": 1},
            "scroll": {"long_tasks": [{}, {}]},
        }
        (folder / "timeline-metrics.json").write_text(json.dumps(report))

    def run_main(self, outcome: str, summary: Path) -> str:
        output = io.StringIO()
        with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}):
            with redirect_stdout(output):
                self.assertEqual(measure_summary.main([str(self.root), outcome]), 0)
        return output.getvalue()

    def test_a_failed_limit_warns_and_never_fails_the_job(self):
        self.write_metrics("timeline-measure", 315.8)
        summary = self.root / "summary.md"

        stdout = self.run_main("failure", summary)

        text = summary.read_text()
        self.assertIn("Measurement step: **failure**", text)
        self.assertIn("315.8 ms open-to-ready (limit 300 ms)", text)
        self.assertIn("1 removed rows, 2 long scroll tasks", text)
        self.assertIn("::warning title=Comms timeline measurement::", stdout)

    def test_a_passing_measurement_reports_without_a_warning(self):
        self.write_metrics("timeline-measure", 64.2)
        summary = self.root / "summary.md"

        stdout = self.run_main("success", summary)

        self.assertIn("64.2 ms open-to-ready", summary.read_text())
        self.assertEqual(stdout, "")

    def test_missing_metrics_are_reported(self):
        summary = self.root / "summary.md"

        self.run_main("failure", summary)

        self.assertIn("No `timeline-metrics.json` was written.", summary.read_text())


if __name__ == "__main__":
    unittest.main()
