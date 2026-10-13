"""Focused CLI contracts for duration-weighted, whole-file CI assignment."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / ".agent-runtime/tier25-opencode/item12/balancing"


class PlaywrightShardTests(unittest.TestCase):
    def setUp(self):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=ARTIFACTS)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.files = [f"http/{name}.spec.ts" for name in "abcdefgh"]
        self.weights = {file: 100 for file in self.files[:-1]}
        self.weights.update({self.files[0]: 900, self.files[1]: 800, "http/deleted.spec.ts": 1000})

    def plan(self, shard=1, files=None):
        collection = {
            "errors": [],
            "suites": [
                {
                    "title": file,
                    "file": file,
                    "specs": [{"file": file, "title": "test", "tests": [{"projectName": "http"}]}],
                }
                for file in (self.files if files is None else files)
            ],
        }
        (self.root / "collection.json").write_text(json.dumps(collection))
        (self.root / "weights.json").write_text(
            json.dumps(
                {
                    "provenance": {
                        "run_id": "test",
                        "revision": "test",
                        "tree": "test",
                        "units": "ms",
                    },
                    "files": self.weights,
                }
            )
        )
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/playwright_shards.py"),
                "plan",
                "--collection",
                str(self.root / "collection.json"),
                "--weights",
                str(self.root / "weights.json"),
                "--shard",
                str(shard),
                "--shards",
                "6",
                "--test-list",
                str(self.root / "selected.txt"),
                "--receipt",
                str(self.root / "receipt.json"),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return (self.root / "selected.txt").read_text(), json.loads(
            (self.root / "receipt.json").read_text()
        )

    def test_six_native_lists_cover_current_files_once_without_deleted_history(self):
        selections = [self.plan(shard)[0].splitlines() for shard in range(1, 7)]
        union = [line for selection in selections for line in selection]
        self.assertEqual(sorted(union), [f"[http] › {file}" for file in self.files])
        self.assertEqual(len(union), len(set(union)))
        self.assertTrue(all(selections))
        _, receipt = self.plan()
        owners = {file: bin_["shard"] for bin_ in receipt["assignments"] for file in bin_["files"]}
        self.assertNotEqual(owners[self.files[0]], owners[self.files[1]])

    def test_assignment_is_deterministic_when_native_collection_order_changes(self):
        selection, receipt = self.plan(6)
        reordered_selection, reordered_receipt = self.plan(6, list(reversed(self.files)))
        self.assertEqual(reordered_selection, selection)
        self.assertEqual(reordered_receipt["assignments"], receipt["assignments"])

    def test_unmeasured_file_receives_positive_median_weight(self):
        _, receipt = self.plan()
        self.assertEqual(receipt["fallback_weight_ms"], 100)
        self.assertEqual(sum(bin_["weight_ms"] for bin_ in receipt["assignments"]), 2300)
        self.assertIn(
            self.files[-1], [file for bin_ in receipt["assignments"] for file in bin_["files"]]
        )


if __name__ == "__main__":
    unittest.main()
