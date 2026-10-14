"""Operator outcomes for the optional, checkpointed mutation lane (no campaign)."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "mutation", Path(__file__).resolve().parents[2] / "scripts/mutation.py"
)
assert spec is not None and spec.loader is not None
mutation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mutation)


class MutationTests(unittest.TestCase):
    def setUp(self):
        self.baseline = {"killed": 2, "survivors": ["old"]}
        self.data = {
            "selection_revision": "anchor",
            "modules": {
                "app/known.py": {"owners": ["tests/known.py"], "baseline": self.baseline},
                "app/unknown.py": {"owners": ["tests/unknown.py"], "baseline": None},
                "operations/sample/other.py": {"owners": ["tests/other.py"], "baseline": None},
            },
        }

    def test_initial_anchor_rescans_only_recorded_survivors(self):
        state = mutation.select(self.data, {}, "head", [])
        self.assertEqual(state["pending"], ["app/known.py"])
        self.assertEqual(state["modes"]["app/known.py"], "rescan")
        self.assertIsNone(state["last_success"])
        self.assertEqual(mutation.base(self.data, state), "anchor")

    def test_source_owner_selection_notes_unmapped_paths_and_keeps_excluded_out(self):
        state = mutation.select(
            self.data, {}, "head", ["backend/app/unknown.py", "backend/tests/other.py"]
        )
        self.assertEqual(
            state["pending"], ["app/known.py", "app/unknown.py", "operations/sample/other.py"]
        )
        self.assertEqual(state["modes"]["app/unknown.py"], "full")
        self.data["zero_hit_excluded"] = ["app/core/database/model_registry.py"]
        excluded = mutation.select(
            self.data,
            {"last_success": "prior"},
            "head",
            ["backend/app/core/database/model_registry.py"],
        )
        self.assertEqual(excluded["pending"], [])
        self.assertEqual(excluded["notes"], [])
        self.assertEqual(excluded["last_success"], "head")
        noted = mutation.select(
            self.data, {"last_success": "prior"}, "head", ["backend/tests/integration_only.py"]
        )
        self.assertEqual(noted["pending"], [])
        self.assertEqual(noted["notes"], ["unmapped test: backend/tests/integration_only.py"])
        with self.subTest(path="backend/tests/integration_only.py"):
            self.assertEqual(noted["last_success"], "prior")
        for path in ("backend/app/new_source.py", "backend/operations/sample/new_source.py"):
            with self.subTest(path=path):
                source = mutation.select(self.data, {"last_success": "prior"}, "head", [path])
                self.assertEqual(source["pending"], [])
                self.assertEqual(source["notes"], [f"unmapped source: {path}"])
                self.assertEqual(source["last_success"], "prior")

    def test_unmapped_owner_blocks_success_until_explicitly_classified(self):
        for path in ("backend/tests/new_owner.py", "backend/tests/integration_only.py"):
            with self.subTest(path=path):
                self.data["zero_hit_excluded"] = []
                blocked = mutation.select(self.data, {"last_success": "prior"}, "head", [path])
                self.assertEqual(blocked["pending"], [])
                self.assertEqual(blocked["notes"], [f"unmapped test: {path}"])
                self.assertEqual(blocked["last_success"], "prior")
                # An explicit classification, never the filename, may exempt an owner.
                self.data["zero_hit_excluded"] = [path.removeprefix("backend/")]
                classified = mutation.select(self.data, blocked, "head", [path])
                self.assertEqual(classified["pending"], [])
                self.assertEqual(classified["notes"], [])
                self.assertEqual(classified["last_success"], "head")

    def test_successful_mapped_work_only_advances_without_unmapped_changes(self):
        for extra, expected_success in (
            (None, "head"),
            ("backend/app/new_source.py", "prior"),
            ("backend/operations/sample/new_source.py", "prior"),
            ("backend/tests/new_owner.py", "prior"),
        ):
            with self.subTest(extra=extra):
                changed = ["backend/app/known.py"] + ([extra] if extra else [])
                state = mutation.select(self.data, {"last_success": "prior"}, "head", changed)
                self.assertEqual(state["pending"], ["app/known.py"])
                diagnostics = state["notes"].copy()
                result = mutation.compare({"a": 1, "b": 1, "old": 0}, self.baseline, "full", 0)
                self.assertTrue(result["complete"])
                self.assertEqual(result["errors"], [])
                mutation.finish(state, "app/known.py", result)
                self.assertEqual(state["pending"], [])
                self.assertEqual(state["failures"], {})
                self.assertEqual(state["results"]["app/known.py"]["revision"], "head")
                self.assertEqual(state["notes"], diagnostics)
                self.assertEqual(state["last_success"], expected_success)

    def test_workflow_gate_rejects_unmapped_notes_even_with_a_successful_checkpoint(self):
        workflow = mutation.ROOT / ".github/workflows/mutation.yml"
        gate = textwrap.dedent(workflow.read_text().rsplit("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for notes, expected_exit in (
                ({}, 0),
                ({"notes": []}, 0),
                ({"notes": ["unmapped source: backend/app/new_source.py"]}, 1),
            ):
                with self.subTest(notes=notes):
                    checkpoint = {
                        "pending": [],
                        "failures": {},
                        "last_success": "head",
                        "cycle": "head",
                        **notes,
                    }
                    (root / "state.json").write_text(json.dumps(checkpoint))
                    result = subprocess.run(
                        ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", gate],
                        cwd=root,
                        env={
                            "PATH": os.environ["PATH"],
                            "OUTPUT": str(root),
                            **{
                                key: "success"
                                for key in ("RESTORE", "PLAN", "SYNC", "NATIVE", "UPLOAD")
                            },
                        },
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(
                        result.returncode, expected_exit, result.stdout + result.stderr
                    )

    def test_pending_rolls_over_at_exact_revision_and_failures_prevent_advancement(self):
        state = mutation.select(self.data, {}, "cycle", ["backend/app/unknown.py"])
        failed = mutation.compare({"a": 1, "old": 0}, self.baseline, "full", 0)
        mutation.finish(state, "app/known.py", failed)
        resumed = mutation.select(self.data, state, "new-head", [])
        self.assertEqual(resumed["cycle"], "cycle")
        self.assertEqual(resumed["pending"], ["app/unknown.py"])
        mutation.finish(resumed, "app/unknown.py", mutation.compare({"u": 0}, None, "full", 0))
        self.assertEqual(set(resumed["failures"]), {"app/known.py", "app/unknown.py"})
        self.assertIsNone(resumed["last_success"])
        clean = mutation.select(self.data, {"last_success": "prior"}, "next", [])
        self.assertEqual(clean["last_success"], "next")

    def test_kill_drop_new_names_and_unknown_full_proposal_are_independent_failures(self):
        result = mutation.compare({"a": 1, "b": 1, "new": 0}, self.baseline, "full", 0)
        self.assertEqual(result["new_survivors"], ["new"])
        self.assertIn("new survivors", result["errors"])
        dropped = mutation.compare({"a": 1, "old": 0}, self.baseline, "full", 0)
        self.assertIn("killed count dropped", dropped["errors"])
        proposal = mutation.compare({"a": 1, "z": 0, "b": 0}, None, "full", 0)
        self.assertEqual(proposal["proposal"], {"killed": 1, "survivors": ["b", "z"]})
        self.assertIn("missing baseline", proposal["errors"])

    def test_failed_or_incomplete_native_results_never_complete_the_queue(self):
        for codes, exit_code in (({}, 0), ({"a": 1}, 1), ({"a": None}, 0), ({"a": 36}, 0)):
            with self.subTest(codes=codes, exit_code=exit_code):
                result = mutation.compare(codes, self.baseline, "full", exit_code)
                state = mutation.select(self.data, {}, "cycle", [])
                mutation.finish(state, "app/known.py", result)
                self.assertFalse(result["complete"])
                self.assertEqual(state["pending"], ["app/known.py"])
                self.assertIsNone(state["last_success"])
        separated = mutation.compare({"k": 1, "n": 33, "t": 36}, None, "full", 0)
        self.assertEqual(separated["killed"], 1)
        self.assertEqual(separated["no_tests"], ["n"])
        self.assertEqual(separated["timeouts"], ["t"])
        # A terminal failure (including an exhausted one-alone timeout retry)
        # must not trap the entire cycle at an old SHA. Keep the failure, not
        # an endless pending entry; a later cycle re-runs it at its own SHA.
        separated["settled"] = True
        state = mutation.select(self.data, {}, "failed-cycle", [])
        mutation.finish(state, "app/known.py", separated)
        self.assertEqual(state["pending"], [])
        self.assertIn("app/known.py", state["failures"])
        self.assertIsNone(state["last_success"])
        next_cycle = mutation.select(self.data, state, "repair", [])
        self.assertEqual(next_cycle["cycle"], "repair")
        self.assertEqual(next_cycle["modes"]["app/known.py"], "full")
        rescan = mutation.compare({"old": 0}, self.baseline, "rescan", 0)
        self.assertEqual(rescan["errors"], [])
        missing = mutation.compare({"other": 0}, self.baseline, "rescan", 0)
        self.assertFalse(missing["complete"])

    def test_native_deadline_including_forced_kill_preserves_the_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            baseline = root / "baseline.json"
            baseline.write_text(json.dumps(self.data))
            meta = root / "mutants/app/known.py.meta"
            meta.parent.mkdir(parents=True)
            meta.write_text(json.dumps({"exit_code_by_key": {"old": None}}))
            for code in (124, 137):
                (root / "state.json").write_text(
                    json.dumps(mutation.select(self.data, {}, "cycle", []))
                )
                with (
                    patch.object(mutation, "OUTPUT", root),
                    patch.object(mutation, "BASELINE", baseline),
                    patch.object(mutation, "prepare", return_value=root),
                    patch.object(mutation.subprocess, "check_output", return_value="cycle\n"),
                    patch.object(
                        sys, "argv", ["mutation.py", "compare", "app/known.py", str(code)]
                    ),
                ):
                    mutation.main()
                saved = json.loads((root / "state.json").read_text())
                self.assertEqual(saved["pending"], ["app/known.py"])
                self.assertIn("app/known.py", saved["failures"])
                self.assertIsNone(saved["last_success"])

    def test_precomparison_failure_requeues_without_old_credit(self):
        for stage in ("sync", "prepare"):
            with self.subTest(stage=stage):
                state = mutation.select(
                    self.data,
                    {"last_success": "prior"},
                    "broken",
                    ["backend/app/known.py", "backend/app/unknown.py", "backend/tests/other.py"],
                )
                failed = mutation.compare({"a": 1, "old": 0}, self.baseline, "full", 0)
                mutation.finish(state, "app/known.py", failed)
                original = json.loads(json.dumps(state))
                mutation.pre_failure(state, stage, 17, "broken", "app/unknown.py")
                self.assertEqual(state["results"], original["results"])
                self.assertEqual(state["failures"], original["failures"])
                self.assertEqual(
                    state["precomparison_failure"],
                    {
                        "stage": stage,
                        "exit_code": 17,
                        "revision": "broken",
                        "module": "app/unknown.py",
                    },
                )
                marked = json.loads(json.dumps(state))
                mutation.pre_failure(state, stage, 99, "broken")
                self.assertEqual(mutation.select(self.data, state, "broken", []), marked)
                candidate = mutation.select(self.data, state, "repair", [])
                self.assertEqual(candidate["cycle"], "repair")
                self.assertEqual(
                    candidate["pending"],
                    ["app/known.py", "app/unknown.py", "operations/sample/other.py"],
                )
                self.assertEqual(candidate["results"], {})
                self.assertEqual(candidate["last_success"], "prior")
                self.assertEqual(candidate["failures"], original["failures"])
                self.assertIsNone(candidate.get("precomparison_failure"))
                self.assertEqual(candidate["precomparison_receipts"], [marked])
                # A fresh comparison cannot overwrite the old failure's receipt.
                passed = mutation.compare({"a": 1, "b": 1, "old": 0}, self.baseline, "full", 0)
                mutation.finish(candidate, "app/known.py", passed)
                self.assertEqual(candidate["results"]["app/known.py"]["revision"], "repair")
                self.assertEqual(candidate["precomparison_receipts"], [marked])
                self.assertEqual(
                    candidate["precomparison_receipts"][0]["failures"]["app/known.py"]["revision"],
                    "broken",
                )
                self.assertEqual(candidate["last_success"], "prior")

    def test_unmarked_rollover_and_late_failure_keep_exact_revision(self):
        # The existing 124/137 CLI test protects native exit/settled handling.
        for outcome in ("budget", 124, 137, "report", "diff"):
            with self.subTest(outcome=outcome):
                state = mutation.select(
                    self.data, {"last_success": "prior"}, "cycle", ["backend/app/unknown.py"]
                )
                if outcome in (124, 137):
                    result = mutation.compare({"old": None}, None, "full", outcome)
                    mutation.finish(state, "app/unknown.py", result)
                elif outcome in ("report", "diff"):
                    with self.assertRaises(ValueError):
                        mutation.pre_failure(state, outcome, 9, "cycle", "app/unknown.py")
                resumed = mutation.select(self.data, state, "repair", [])
                self.assertIsNone(resumed.get("precomparison_failure"))
                self.assertEqual(resumed["cycle"], "cycle")
                self.assertEqual(resumed["pending"], ["app/unknown.py"])
                self.assertEqual(resumed["last_success"], "prior")

    def test_retirement_requires_both_revision_boundaries_and_retains_receipt(self):
        module = "app/known.py"
        path = "backend/app/known.py"
        failure = {"revision": "old", "errors": ["unresolved native run"]}
        for case in (
            (True, True, False, False, False, False, True),
            (True, True, True, False, False, False, False),
            (True, True, False, True, False, False, False),
            (True, True, True, True, False, False, False),
            (False, True, False, False, False, False, False),
            (True, False, False, False, False, False, False),
            (True, True, False, False, True, False, False),
            (True, True, False, False, False, True, True),
        ):
            old_source, old_entry, source, entry, unavailable, rename, retire = case
            for unfinished in (False, True):
                with self.subTest(case=case, unfinished=unfinished):
                    data = json.loads(json.dumps(self.data))
                    if not entry:
                        del data["modules"][module]
                    state = {
                        "cycle": "old" if unfinished else "queue",
                        "last_success": "prior",
                        "results": {},
                        "modes": {module: "full"},
                        "pending": [module] if unfinished else [],
                        "failures": {} if unfinished else {module: failure},
                    }
                    if unfinished:
                        mutation.pre_failure(state, "sync", 1, "old", module)
                    before = json.dumps({"modules": {module: {}} if old_entry else {}})
                    after = json.dumps({"modules": {module: {}} if entry else {}})
                    facts = {
                        "old": (before, path + "\n" if old_source else ""),
                        "head": (after, path + "\n" if source else ""),
                    }
                    facts["later"] = facts["head"]
                    boundary = (
                        subprocess.CalledProcessError(128, "git")
                        if unavailable
                        else lambda args, facts=facts, **_: facts[
                            args[2].split(":")[0] if args[1] == "show" else args[3]
                        ][args[1] == "ls-tree"]
                    )
                    changed = [path] + (["backend/app/renamed.py"] if rename else [])
                    with patch.object(mutation.subprocess, "check_output", side_effect=boundary):
                        result = mutation.select(data, state, "head", changed)
                        self.assertEqual(
                            result["last_success"], "head" if retire and not rename else "prior"
                        )
                        self.assertEqual(result["results"], {})
                        if retire:
                            self.assertEqual(result["failures"], {})
                            self.assertEqual(result["pending"], [])
                            receipt = {
                                "module": module,
                                "original_revision": "old",
                                "retirement_revision": "head",
                                "unfinished": unfinished,
                                "failure": None if unfinished else failure,
                            }
                            self.assertEqual(result["retirement_receipts"], [receipt])
                            again = mutation.select(data, result, "head", changed)
                            self.assertEqual(again["retirement_receipts"], [receipt])
                            self.assertEqual(again["notes"], result["notes"])
                            if rename:
                                self.assertEqual(
                                    result["notes"], ["unmapped source: backend/app/renamed.py"]
                                )
                                later = mutation.select(data, result, "later", changed)
                                self.assertEqual(later["notes"], result["notes"])
                        else:
                            self.assertEqual(
                                result["pending"] if unfinished else result["failures"][module],
                                [module] if unfinished else failure,
                            )
                            self.assertEqual(result.get("retirement_receipts", []), [])
                            if entry:
                                self.assertEqual(result["modes"][module], "full")

    def test_scheduled_sample_preparation_includes_declared_controls_owner(self):
        backend = mutation.BACKEND
        module = "operations/sample/controls/access_verification.py"
        owners = json.loads(mutation.BASELINE.read_text())["modules"][module]["owners"]
        self.assertTrue(owners)
        project = (backend / "pyproject.toml").read_text()
        helper = mutation.runpy.run_path(str(backend / "tests/sample_mutation.py"))
        standalone_text = helper["sample_pyproject"](project)
        standalone = tomllib.loads(standalone_text)["tool"]["mutmut"]
        self.assertEqual(
            standalone["only_mutate"],
            ["operations/sample/episodes.py", "operations/sample/history.py"],
        )
        self.assertIn(
            "--ignore=tests/operations/sample/controls", standalone["pytest_add_cli_args"]
        )
        with tempfile.TemporaryDirectory() as directory:
            fixture_backend = Path(directory)
            for name in helper["LINKED"]:
                (fixture_backend / name).symlink_to(backend / name)
            (fixture_backend / "pyproject.toml").write_text(project)
            with patch.object(mutation, "BACKEND", fixture_backend):
                root = mutation.prepare({"cycle": "controls-owner"}, module)
            config = tomllib.loads((root / "pyproject.toml").read_text())["tool"]["mutmut"]
            self.assertEqual(config["only_mutate"], [module])
            self.assertTrue((root / module).is_file())
            args = config["pytest_add_cli_args"]
            self.assertIn("--no-cov", args)
            self.assertEqual(args[args.index("-m") + 1], "not integration")
            selected = [root / path for path in config["pytest_add_cli_args_test_selection"]]
            ignored = [
                root / arg.removeprefix("--ignore=") for arg in args if arg.startswith("--ignore=")
            ]
            self.assertIn(
                root / "tests/operations/sample/verification/test_frontend_route_coverage.py",
                ignored,
            )
            for owner in owners:
                with self.subTest(owner=owner):
                    path = root / owner
                    self.assertTrue(path.is_file())
                    self.assertTrue(any(path.is_relative_to(selection) for selection in selected))
                    self.assertFalse(
                        any(path.is_relative_to(exclusion) for exclusion in ignored),
                        f"Scheduled runner excludes declared owner {owner}",
                    )
        self.assertEqual(helper["sample_pyproject"](project), standalone_text)


if __name__ == "__main__":
    unittest.main()
