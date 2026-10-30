"""Focused CLI contracts for duration-weighted, whole-file CI assignment."""

from __future__ import annotations

import json
import shutil
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

    def test_empty_history_assigns_current_files_once_with_uniform_positive_weight(self):
        self.weights = {}
        collection = list(reversed(self.files)) + [self.files[0]]
        plans = [self.plan(shard, collection) for shard in range(1, 7)]
        union = [line for selection, _ in plans for line in selection.splitlines()]
        self.assertEqual(
            sorted(union),
            [
                "[http] › http/a.spec.ts",
                "[http] › http/b.spec.ts",
                "[http] › http/c.spec.ts",
                "[http] › http/d.spec.ts",
                "[http] › http/e.spec.ts",
                "[http] › http/f.spec.ts",
                "[http] › http/g.spec.ts",
                "[http] › http/h.spec.ts",
            ],
        )
        self.assertEqual(len(union), len(set(union)))
        _, receipt = plans[0]
        fallback = receipt["fallback_weight_ms"]
        self.assertGreater(fallback, 0)
        self.assertEqual(
            [bin_["files"] for bin_ in receipt["assignments"]],
            [
                ["http/a.spec.ts", "http/g.spec.ts"],
                ["http/b.spec.ts", "http/h.spec.ts"],
                ["http/c.spec.ts"],
                ["http/d.spec.ts"],
                ["http/e.spec.ts"],
                ["http/f.spec.ts"],
            ],
        )
        self.assertEqual(
            [bin_["weight_ms"] for bin_ in receipt["assignments"]],
            [2 * fallback, 2 * fallback, fallback, fallback, fallback, fallback],
        )
        reordered_selection, reordered_receipt = self.plan()
        self.assertEqual(reordered_selection, plans[0][0])
        self.assertEqual(reordered_receipt["assignments"], receipt["assignments"])

    def write_shard_report(self, index, specs, revision="r1", unexpected=0):
        folder = self.root / f"reports/frontend-playwright-http-{index}"
        folder.mkdir(parents=True)
        report = {
            "stats": {"unexpected": unexpected},
            "suites": [
                {
                    "file": file,
                    "specs": [
                        {
                            "file": file,
                            "tests": [{"results": [{"duration": ms} for ms in durations]}],
                        }
                    ],
                    "suites": [],
                }
                for file, durations in specs.items()
            ],
        }
        (folder / f"http-{index}.json").write_text(json.dumps(report))
        (folder / f"http-{index}.metadata.txt").write_text(
            f"revision={revision}\ntree=t1\nrun_id=42\nrun_attempt=1\n"
        )

    def refresh(self, shards=2):
        return subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/playwright_shards.py"),
                "weights",
                "--reports",
                str(self.root / "reports"),
                "--shards",
                str(shards),
                "--output",
                str(self.root / "weights.json"),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_weights_sum_every_attempt_per_file_from_one_green_run(self):
        self.write_shard_report(0, {"http/a.spec.ts": [100.4, 50.2]})
        self.write_shard_report(1, {"http/b.spec.ts": [300.0]})

        result = self.refresh()

        self.assertEqual(result.returncode, 0, result.stderr)
        seed = json.loads((self.root / "weights.json").read_text())
        self.assertEqual(
            seed["provenance"], {"run_id": "42", "revision": "r1", "tree": "t1", "units": "ms"}
        )
        self.assertEqual(seed["files"], {"http/a.spec.ts": 151, "http/b.spec.ts": 300})

    def test_weights_refuse_a_red_run_mixed_revisions_or_a_missing_shard(self):
        for case, setup in (
            ("red", lambda: self.write_shard_report(1, {"http/b.spec.ts": [1]}, unexpected=1)),
            ("mixed", lambda: self.write_shard_report(1, {"http/b.spec.ts": [1]}, revision="r2")),
            ("missing", lambda: None),
        ):
            with self.subTest(case=case):
                shutil.rmtree(self.root / "reports", ignore_errors=True)
                self.write_shard_report(0, {"http/a.spec.ts": [1]})
                setup()
                self.assertNotEqual(self.refresh().returncode, 0)


if __name__ == "__main__":
    unittest.main()
