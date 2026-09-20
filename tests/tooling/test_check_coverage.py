"""Coverage gates must fail closed without hiding untested or changed source."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.check_coverage import evaluate


class CoverageGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "backend/app/example.py"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("\n".join(f"value_{n} = {n}" for n in range(1, 11)) + "\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Coverage Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "baseline",
        )
        self.base = self.git("rev-parse", "HEAD").strip()
        self.report = self.root / "report.json"

    def git(self, *arguments):
        return subprocess.check_output(["git", *arguments], cwd=self.root, text=True)

    def backend_report(self, covered=range(1, 10), missing=(10,), extra=None):
        files = {
            "app/example.py": {
                "executed_lines": list(covered),
                "missing_lines": list(missing),
                "excluded_lines": [],
            }
        }
        files.update(extra or {})
        self.report.write_text(json.dumps({"files": files}))

    def test_test_only_changes_have_na_changed_coverage_and_exact_overall_threshold(self):
        self.backend_report()
        result = evaluate(self.root, "backend", self.report, self.base)
        self.assertTrue(result["passed"])
        self.assertEqual(result["overall"]["percent"], 90)
        self.assertIsNone(result["changed"]["percent"])

    def test_unchanged_covered_code_cannot_mask_uncovered_changed_line(self):
        self.backend_report()
        self.source.write_text(self.source.read_text().replace("value_10 = 10", "value_10 = 20"))
        result = evaluate(self.root, "backend", self.report, self.base)
        self.assertFalse(result["passed"])
        self.assertEqual(result["changed"]["percent"], 0)
        self.assertEqual(result["files"][0]["changed_uncovered"], [10])

    def test_new_untracked_source_counts_as_changed(self):
        new = self.source.with_name("new.py")
        new.write_text("new_value = 1\n")
        self.backend_report(
            covered=range(1, 11),
            missing=(),
            extra={"app/new.py": {"executed_lines": [], "missing_lines": [1]}},
        )
        result = evaluate(self.root, "backend", self.report, self.base)
        self.assertFalse(result["passed"])
        self.assertEqual(result["changed"]["total"], 1)

    def test_missing_source_or_out_of_scope_report_is_rejected(self):
        self.backend_report()
        self.source.with_name("unimported.py").write_text("untested = 1\n")
        with self.assertRaisesRegex(ValueError, "Missing coverage"):
            evaluate(self.root, "backend", self.report, self.base)
        self.source.with_name("unimported.py").unlink()
        self.backend_report(
            extra={"scripts/health.py": {"executed_lines": [1], "missing_lines": []}}
        )
        with self.assertRaisesRegex(ValueError, "outside"):
            evaluate(self.root, "backend", self.report, self.base)

    def test_missing_base_and_invalid_line_partitions_fail(self):
        self.backend_report()
        with self.assertRaisesRegex(ValueError, "base"):
            evaluate(self.root, "backend", self.report, "missing-reference")
        self.backend_report(covered=(1,), missing=(1,))
        with self.assertRaisesRegex(ValueError, "overlap"):
            evaluate(self.root, "backend", self.report, self.base)

    def test_frontend_merges_multiple_statements_on_one_line_and_lists_type_only(self):
        source = self.root / "frontend/src/example.ts"
        source.parent.mkdir(parents=True)
        source.write_text("export const value = 1; console.log(value);\n")
        source.with_name("types.ts").write_text("export type Name = string;\n")
        source.with_name("global.d.ts").write_text("declare const injected: string;\n")
        self.report.write_text(
            json.dumps(
                {
                    "src/example.ts": {
                        "statementMap": {"0": {"start": {"line": 1}}, "1": {"start": {"line": 1}}},
                        "s": {"0": 0, "1": 1},
                    },
                    "src/types.ts": {"statementMap": {}, "s": {}},
                }
            )
        )
        result = evaluate(self.root, "frontend", self.report, self.base)
        self.assertTrue(result["passed"])
        self.assertEqual(result["overall"]["total"], 1)
        self.assertEqual(result["changed"]["percent"], 100)
        self.assertEqual(result["non_executable_files"], ["frontend/src/types.ts"])


if __name__ == "__main__":
    unittest.main()
