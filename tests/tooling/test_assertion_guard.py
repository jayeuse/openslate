"""Contract tests for the test-change guard (plan item 14)."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import assertion_guard as guard


def change(path: str, removed: list[str] = (), added: list[str] = (), status: str = "M"):
    return guard.FileChange(path=path, status=status, removed=list(removed), added=list(added))


class AssertionCountTests(unittest.TestCase):
    def test_counts_python_assertions(self):
        lines = [
            "    assert response.status_code == 201",
            "    with pytest.raises(ValueError, match='blank'):",
            "    mock.assert_called_once_with(1)",
            "    value = assertion_helper()",
        ]
        self.assertEqual(guard.count_assertions("backend/tests/a/test_x.py", lines), 3)

    def test_counts_an_expectation_split_across_lines(self):
        lines = [
            "  await expect",
            "    .poll(() => reads)",
            "    .toBe(2);",
            '  import { expect, test } from "@playwright/test";',
        ]
        self.assertEqual(guard.count_assertions("frontend/tests/http/a.spec.ts", lines), 1)

    def test_counts_typescript_expectations_once_per_expect(self):
        lines = [
            "  await expect(page.getByRole('heading')).toHaveText('Boards');",
            "  await expect.poll(() => reads).toBe(2);",
            "  expect.soft(value).toEqual(3);",
            "  const expected = 4;",
        ]
        self.assertEqual(guard.count_assertions("frontend/tests/http/a.spec.ts", lines), 3)


class LedgerTests(unittest.TestCase):
    def test_parses_rows_and_ignores_header_and_separator(self):
        rows = guard.parse_ledger_rows(
            [
                "| Removed from | Assertions | Owner | Rule |",
                "| --- | --- | --- | --- |",
                "| backend/tests/a/test_x.py | 2 | backend/tests/a/test_y.py::test_owner | D1 |",
            ]
        )
        self.assertEqual(
            rows,
            [
                guard.LedgerRow(
                    source="backend/tests/a/test_x.py",
                    count=2,
                    owner="backend/tests/a/test_y.py::test_owner",
                    rule="D1",
                )
            ],
        )


class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        owner = self.root / "backend/tests/a/test_owner.py"
        owner.parent.mkdir(parents=True)
        owner.write_text("def test_owner():\n    assert True\n")

    def tearDown(self):
        self.tempdir.cleanup()

    def analyze(self, changes, ledger=()):
        return guard.analyze(changes, list(ledger), self.root)

    def test_removed_assertion_without_ledger_row_fails(self):
        violations = self.analyze(
            [change("backend/tests/a/test_x.py", removed=["    assert total == 3"])]
        )
        self.assertEqual(len(violations), 1)
        self.assertIn("1 assertion(s) removed", violations[0])

    def test_reformatted_assertion_is_not_a_removal(self):
        violations = self.analyze(
            [
                change(
                    "frontend/tests/http/a.spec.ts",
                    removed=["  await expect(row).toHaveText('Saved');"],
                    added=["  await expect(row)", "    .toHaveText('Saved');"],
                )
            ]
        )
        self.assertEqual(violations, [])

    def test_ledger_row_with_existing_owner_covers_the_removal(self):
        violations = self.analyze(
            [
                change(
                    "backend/tests/a/test_x.py", removed=["    assert a == 1", "    assert b == 2"]
                )
            ],
            [
                guard.LedgerRow(
                    "backend/tests/a/test_x.py",
                    2,
                    "backend/tests/a/test_owner.py::test_owner",
                    "D1",
                )
            ],
        )
        self.assertEqual(violations, [])

    def test_ledger_row_for_the_old_path_covers_a_renamed_file(self):
        renamed = guard.FileChange(
            path="frontend/tests/isolated/a.spec.ts",
            status="M",
            removed=["  expect(a).toBe(1);", "  expect(b).toBe(2);"],
            old_path="frontend/tests/http/a.spec.ts",
        )
        ledger = [
            guard.LedgerRow(
                "frontend/tests/http/a.spec.ts",
                2,
                "backend/tests/a/test_owner.py::test_owner",
                "D3",
            )
        ]
        self.assertEqual(self.analyze([renamed], ledger), [])
        self.assertEqual(len(self.analyze([renamed])), 1)

    def test_ledger_row_with_missing_owner_file_fails(self):
        violations = self.analyze(
            [change("backend/tests/a/test_x.py", removed=["    assert a == 1"])],
            [
                guard.LedgerRow(
                    "backend/tests/a/test_x.py", 1, "backend/tests/a/test_gone.py::t", "D1"
                )
            ],
        )
        self.assertTrue(any("owner" in violation for violation in violations))

    def test_ledger_row_with_too_small_count_fails(self):
        violations = self.analyze(
            [
                change(
                    "backend/tests/a/test_x.py", removed=["    assert a == 1", "    assert b == 2"]
                )
            ],
            [
                guard.LedgerRow(
                    "backend/tests/a/test_x.py", 1, "backend/tests/a/test_owner.py", "D1"
                )
            ],
        )
        self.assertEqual(len(violations), 1)

    def test_deleted_file_needs_ledger_rows_for_every_assertion(self):
        violations = self.analyze(
            [
                change(
                    "frontend/tests/http/old.spec.ts",
                    status="D",
                    removed=["  expect(a).toBe(1);", "  expect(b).toBe(2);"],
                )
            ]
        )
        self.assertIn("2 assertion(s) removed", violations[0])

    def test_non_test_files_are_ignored(self):
        violations = self.analyze(
            [change("backend/app/x.py", removed=["    assert invariant"], added=["time.sleep(1)"])]
        )
        self.assertEqual(violations, [])

    def test_forbidden_patterns_in_added_test_lines_fail(self):
        cases = {
            "frontend/tests/http/a.spec.ts": [
                "test.skip('later', async () => {});",
                "test.fixme('broken', async () => {});",
                "await page.waitForTimeout(100);",
                "test.setTimeout(60_000);",
                "// eslint-disable-next-line playwright/no-wait-for-timeout",
                "expect(value).toBeTruthy();",
                "await expect(row).toBeVisible({ timeout: 15_000 });",
            ],
            "frontend/playwright.config.ts": ["  retries: 2,"],
            "backend/tests/a/test_x.py": [
                "@pytest.mark.skip(reason='later')",
                "@pytest.mark.xfail",
                "    time.sleep(0.5)",
                "    value = call()  # noqa: B018",
            ],
        }
        for path, lines in cases.items():
            for line in lines:
                with self.subTest(path=path, line=line):
                    violations = self.analyze([change(path, added=[line])])
                    self.assertEqual(len(violations), 1, violations)

    def test_suppression_with_an_inline_reason_is_allowed(self):
        for path, line in (
            (
                "backend/tests/a/test_x.py",
                "    assert x  # noqa: PT017 - either race outcome is valid",
            ),
            (
                "frontend/tests/http/a.spec.ts",
                "// eslint-disable-next-line playwright/no-nth-methods -- the grid has no labels",
            ),
        ):
            with self.subTest(line=line):
                self.assertEqual(self.analyze([change(path, added=[line])]), [])

    def test_existing_forbidden_pattern_that_only_moves_is_not_new(self):
        line = "test.skip(browserName !== 'chromium', 'Chromium only');"
        violations = self.analyze(
            [change("frontend/tests/http/a.spec.ts", removed=[line], added=["  " + line])]
        )
        self.assertEqual(violations, [])

    def test_measured_marker_allows_a_timing_value(self):
        violations = self.analyze(
            [
                change(
                    "frontend/tests/fullstack/a.spec.ts",
                    added=["test.setTimeout(120_000); // measured: seeding takes 95 s on CI"],
                )
            ]
        )
        self.assertEqual(violations, [])

    def test_short_timeouts_are_allowed(self):
        violations = self.analyze(
            [
                change(
                    "frontend/tests/http/a.spec.ts",
                    added=["await expect(a).toBeVisible({ timeout: 2_000 });"],
                )
            ]
        )
        self.assertEqual(violations, [])

    def test_changed_snapshot_needs_a_snapshot_ledger_row(self):
        snapshot = "frontend/tests/http/a.spec.ts-snapshots/board.aria.yml"
        self.assertEqual(len(self.analyze([change(snapshot, added=["- heading"])])), 1)
        self.assertEqual(
            self.analyze(
                [change(snapshot, added=["- heading"])],
                [
                    guard.LedgerRow(
                        snapshot, 0, "backend/tests/a/test_owner.py", "snapshot reviewed"
                    )
                ],
            ),
            [],
        )

    def test_the_guard_test_file_itself_is_exempt(self):
        violations = self.analyze(
            [
                change(
                    "tests/tooling/test_assertion_guard.py",
                    added=["test.skip('x')", "time.sleep(1)"],
                )
            ]
        )
        self.assertEqual(violations, [])


class GitCollectionTests(unittest.TestCase):
    def test_collects_committed_unstaged_untracked_and_deleted_test_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = lambda *args: subprocess.run(  # noqa: E731
                ["git", *args], cwd=root, check=True, capture_output=True, text=True
            )
            git("init", "-q")
            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI Test")
            kept = root / "backend/tests/test_kept.py"
            gone = root / "backend/tests/test_gone.py"
            kept.parent.mkdir(parents=True)
            kept.write_text("def test_a():\n    assert 1 == 1\n    assert 2 == 2\n")
            gone.write_text("def test_b():\n    assert 3 == 3\n")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD").stdout.strip()

            kept.write_text("def test_a():\n    assert 1 == 1\n")
            gone.unlink()
            (root / "frontend/tests").mkdir(parents=True)
            (root / "frontend/tests/new.spec.ts").write_text("test.skip('x', () => {});\n")

            changes = {item.path: item for item in guard.collect_changes(root, base)}
            self.assertEqual(changes["backend/tests/test_kept.py"].removed, ["    assert 2 == 2"])
            self.assertEqual(changes["backend/tests/test_gone.py"].status, "D")
            self.assertEqual(
                changes["frontend/tests/new.spec.ts"].added, ["test.skip('x', () => {});"]
            )

    def test_a_committed_rename_keeps_its_old_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git = lambda *args: subprocess.run(  # noqa: E731
                ["git", *args], cwd=root, check=True, capture_output=True, text=True
            )
            git("init", "-q")
            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI Test")
            old = root / "frontend/tests/http/a.spec.ts"
            old.parent.mkdir(parents=True)
            body = "".join(f"test('t{n}', () => {{ expect({n}).toBe({n}); }});\n" for n in range(9))
            old.write_text(body)
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD").stdout.strip()

            new = root / "frontend/tests/isolated/a.spec.ts"
            new.parent.mkdir(parents=True)
            git("mv", str(old), str(new))
            new.write_text(body.replace("test('t8', () => { expect(8).toBe(8); });\n", ""))
            git("commit", "-qam", "move")

            changes = {item.path: item for item in guard.collect_changes(root, base)}
            moved = changes["frontend/tests/isolated/a.spec.ts"]
            self.assertEqual(moved.old_path, "frontend/tests/http/a.spec.ts")
            self.assertEqual(moved.removed, ["test('t8', () => { expect(8).toBe(8); });"])


if __name__ == "__main__":
    unittest.main()
