"""Contract tests for the test-change guard (plan item 14)."""

from __future__ import annotations

import subprocess
import tempfile
import time
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


class RegexLiteralTests(unittest.TestCase):
    def test_regex_literals_keep_their_full_match(self):
        for literal in ("/a[b]c/g", r"/x\/y/", "/[/]/", "/a]b/", "/[[]/"):
            match = guard._TS_REGEX.match(literal)
            self.assertIsNotNone(match, literal)
            self.assertEqual(match.group(), literal)

    def test_unterminated_bracket_pairs_do_not_backtrack_exponentially(self):
        # CodeQL py/redos: "[]" matched both as an empty class and as two characters.
        started = time.perf_counter()
        self.assertIsNone(guard._TS_REGEX.match("/" + "[]" * 26))
        self.assertLess(time.perf_counter() - started, 0.5)


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

    def test_unrelated_additions_do_not_cover_removed_assertions(self):
        for path, removed, added in (
            (
                "backend/tests/a/test_x.py",
                ["    assert denied.status_code == 403"],
                ["    assert allowed.status_code == 200"],
            ),
            (
                "frontend/tests/http/a.spec.ts",
                ["expect(denied.status()).toBe(403);"],
                ["expect(allowed.status()).toBe(200);"],
            ),
            (
                "backend/tests/a/test_x.py",
                ["    assert denied.status_code == 403"] * 2,
                ["    assert denied.status_code == 403", "    assert allowed.status_code == 200"],
            ),
        ):
            with self.subTest(path=path, removed=removed):
                violations = self.analyze([change(path, removed=removed, added=added)])
                self.assertEqual(len(violations), 1, violations)
                self.assertIn("1 assertion(s) removed, 0 recorded", violations[0])

    def test_unkeyable_ts_assertion_requires_only_its_ledger_owner(self):
        path = "frontend/tests/http/a.spec.ts"
        closing_block = (
            "await expect.poll(() => {\n"
            "  let matched = false;\n"
            "  if (!ready) { return false; }\n"
            "  /a b/.test(value) && (matched = true);\n"
            "  return matched;\n"
            "}).toBe(true);\n"
        )
        quoted_brace = 'expect(value).toBe(`${destination.replace("}", "#")}`);'
        escaped_argument = r'expect(value).toBe(`${destination.replace("\\", "#")}`);'
        nested_backtick = 'expect(value).toBe(`${destination.replace(`#`, "#")}`);'
        for expression, edited_expression in (
            ("expect<Result>(value).toBe(3);", "expect<Result>(value).toBe(3);"),
            (
                "expect.poll(() => { if (ready) /a b/.test(value); return ready; }).toBe(true);",
                "expect.poll(() => { if (ready) /a b/.test(value); return ready; }).toBe(true);",
            ),
            (closing_block, closing_block.replace("/a b/", "/a  b/")),
            (quoted_brace, quoted_brace),
            (escaped_argument, escaped_argument),
            (nested_backtick, nested_backtick),
        ):
            with self.subTest(expression=expression):
                source = expression + "\nexpect(other).toBe(4);\n"
                item = change(path)
                item.before_source = source
                item.after_source = source.replace(expression, edited_expression).replace(
                    "expect(other).toBe(4);", "expect(other)\n  .toBe(4);"
                )
                violations = self.analyze([item])
                self.assertEqual(len(violations), 1, violations)
                self.assertIn("1 assertion(s) removed, 0 recorded", violations[0])
                row = guard.LedgerRow(path, 1, "backend/tests/a/test_owner.py::test_owner", "D1")
                self.assertEqual(self.analyze([item], [row]), [])

    def test_flat_quoted_template_interpolation_keeps_literal_protection(self):
        assertion = (
            'await expect(page).toHaveURL(new RegExp(`${destination.replace("#", "#")}$`));\n'
        )
        for after, removals in (
            (assertion, 0),
            (assertion.replace('replace("#", "#")', 'replace( "#", "#" )'), 0),
            (assertion.replace('replace("#", "#")', 'replace("#", "?")'), 1),
            (assertion.replace('replace("#", "#")', 'replace("#", "# ")'), 1),
            ("", 1),
        ):
            with self.subTest(after=after):
                item = change(
                    "frontend/tests/http/a.spec.ts", removed=["// before"], added=["// after"]
                )
                item.before_source = assertion + "// before\n"
                item.after_source = after + "// after\n"
                violations = self.analyze([item])
                self.assertEqual(len(violations), removals, violations)
                if removals:
                    self.assertIn("1 assertion(s) removed, 0 recorded", violations[0])

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

    def test_timing_options_do_not_change_assertion_ownership(self):
        for before, after, removals in (
            (
                "await expect(row).toBeVisible({ timeout: 30_000 });",
                "await expect(row).toBeVisible({ timeout: 20_000 });",
                0,
            ),
            (
                "await expect(row).toBeVisible({ timeout: 30_000 });",
                "await expect(row).toBeVisible();",
                0,
            ),
            (
                "await expect.poll(() => ready, { timeout: 60_000 }).toBe(true);",
                "await expect.poll(() => ready, { timeout: 20_000 }).toBe(true);",
                0,
            ),
            (
                "await expect.poll(() => api.read('ready', { timeout: 700 }), "
                "{ timeout: 5000, intervals: [100, 250] }).toBe(true);",
                "await expect.poll(() => api.read('ready', { timeout: 700 })).toBe(true);",
                0,
            ),
            (
                "await expect(row).toHaveText('Ready', { timeout: 5000, ignoreCase: true });",
                "await expect(row).toHaveText('Ready', { ignoreCase: true });",
                0,
            ),
            (
                "expect({ timeout: 30000 }).toEqual(value);",
                "expect({ timeout: 20000 }).toEqual(value);",
                1,
            ),
            (
                "expect(value).toEqual({ timeout: 30000, intervals: [100] });",
                "expect(value).toEqual({ timeout: 20000, intervals: [50] });",
                1,
            ),
            (
                "await expect(row).toHaveJSProperty('data', "
                "{ timeout: 30000 }, { timeout: 5000 });",
                "await expect(row).toHaveJSProperty('data', { timeout: 20000 });",
                1,
            ),
            (
                "await expect(row).not.toBeVisible({ timeout: 5000 });",
                "await expect(row).toBeVisible();",
                1,
            ),
            (
                "await expect(row).toBeVisible({ timeout: 5000 });",
                "await expect(row).toBeHidden();",
                1,
            ),
            (
                "await expect(row).toHaveText('Ready', { timeout: 5000 });",
                "await expect(row).toHaveText('Denied');",
                1,
            ),
            (
                "await expect(row).toHaveText('Ready', { timeout: 5000, ignoreCase: true });",
                "await expect(row).toHaveText('Ready', { ignoreCase: false });",
                1,
            ),
        ):
            with self.subTest(before=before, after=after):
                item = change("frontend/tests/http/a.spec.ts", removed=[before], added=[after])
                item.before_source, item.after_source = before, after
                violations = self.analyze([item])
                self.assertEqual(len(violations), removals, violations)
                if removals:
                    self.assertIn("1 assertion(s) removed, 0 recorded", violations[0])

    def test_equivalent_hidden_locator_assertions_keep_their_owner(self):
        invisible = "await expect(row).not.toBeVisible();"
        hidden = "await expect(row).toBeHidden();"
        for before, after, removals in (
            (invisible, hidden, 0),
            ("await expect(row).not.toBeVisible({ timeout: 5000 });", hidden, 0),
            (invisible, "await expect(other).toBeHidden();", 1),
            ("await expect(row).not.toBeVisible({ visible: false });", hidden, 1),
            (invisible, "await expect(row).not.toBeHidden();", 1),
            (invisible, "expect(row).toBeHidden();", 1),
            (
                "expect(() => row.not.toBeVisible()).toBe(1);\n"
                "expect(value).toEqual({ result: row.not.toBeVisible() });\n"
                "expect(value).toEqual('.not.toBeVisible()');",
                "expect(() => row.toBeHidden()).toBe(1);\n"
                "expect(value).toEqual({ result: row.toBeHidden() });\n"
                "expect(value).toEqual('.toBeHidden()');",
                3,
            ),
            (
                "await custom.expect(row).not.toBeVisible();",
                "await custom.expect(row).toBeHidden();",
                1,
            ),
            (
                "await expect(row).resolves.not.toBeVisible();",
                "await expect(row).resolves.toBeHidden();",
                1,
            ),
        ):
            with self.subTest(before=before, after=after):
                item = change("frontend/tests/http/a.spec.ts")
                item.before_source, item.after_source = before, after
                violations = self.analyze([item])
                self.assertEqual(len(violations), int(removals > 0), violations)
                if removals:
                    self.assertIn(f"{removals} assertion(s) removed, 0 recorded", violations[0])

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

    def test_suppression_with_an_inline_reason_is_rejected(self):
        for path, line in (
            (
                "backend/tests/a/test_x.py",
                "    value = call()  # noqa - explained here",
            ),
            (
                "backend/tests/a/test_x.py",
                "    assert x  # noqa: PT017 - either race outcome is valid",
            ),
            (
                "frontend/tests/http/a.spec.ts",
                "/* eslint-disable playwright/no-nth-methods -- the grid has no labels */",
            ),
            (
                "frontend/tests/http/a.spec.ts",
                "useGrid(); // eslint-disable-line playwright/no-nth-methods -- no labels",
            ),
            (
                "frontend/tests/http/a.spec.ts",
                "// eslint-disable-next-line playwright/no-nth-methods -- the grid has no labels",
            ),
        ):
            with self.subTest(path=path, line=line):
                violations = self.analyze([change(path, added=[line])])
                self.assertEqual(len(violations), 1, violations)

    def test_existing_forbidden_pattern_that_only_moves_is_not_new(self):
        line = "test.skip(browserName !== 'chromium', 'Chromium only');"
        violations = self.analyze(
            [change("frontend/tests/http/a.spec.ts", removed=[line], added=["  " + line])]
        )
        self.assertEqual(violations, [])

    def test_measured_marker_does_not_allow_timing_or_retries(self):
        for path, line in (
            ("backend/tests/a/test_x.py", "    time.sleep(0.5)  # measured: setup latency"),
            ("backend/tests/a/test_x.py", "    await asyncio.sleep(0.5)  # measured: latency"),
            (
                "frontend/tests/http/a.spec.ts",
                "await page.waitForTimeout(100); // measured: animation duration",
            ),
            (
                "frontend/tests/fullstack/a.spec.ts",
                "test.setTimeout(120_000); // measured: seeding takes 95 s on CI",
            ),
            ("frontend/tests/http/a.spec.ts", "test.slow(); // measured: takes 10 s on CI"),
            (
                "frontend/tests/http/a.spec.ts",
                "await expect(row).toBeVisible({ timeout: 15_000 }); // measured: load latency",
            ),
            ("frontend/playwright.config.ts", "  retries: 2, // measured: load failures"),
        ):
            with self.subTest(path=path, line=line):
                violations = self.analyze([change(path, added=[line])])
                self.assertEqual(len(violations), 1, violations)

    def test_only_zero_or_one_ci_retry_is_allowed_in_the_config(self):
        # docs/plans/ci-stability.md D1: one retry in CI only, zero everywhere else.
        for line, refused in (
            ("  retries: isCI ? 1 : 0,", False),
            ("            retries: 0,", False),
            ("  retries: isCI ? 2 : 0,", True),
            ("  retries: process.env.CI ? 1 : 0,", True),
            ("  retries: 1,", True),
        ):
            with self.subTest(line=line):
                violations = self.analyze([change("frontend/playwright.config.ts", added=[line])])
                self.assertEqual(len(violations), int(refused), violations)

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

    def test_only_the_real_service_comms_specs_may_raise_timeouts(self):
        measured = "frontend/tests/fullstack/comms-measurements.spec.ts"
        journey = "frontend/tests/fullstack/comms-two-account.spec.ts"
        for path, line, expected in (
            (measured, "test.setTimeout(1_200_000);", 0),
            (measured, "await expect(row).toBeVisible({ timeout: 200_000 });", 0),
            (journey, "test.setTimeout(300_000);", 0),
            (journey, "await page.waitForTimeout(100);", 1),
            (
                "frontend/tests/fullstack/sandbox-workspace.spec.ts",
                "await expect(row).toBeVisible({ timeout: 200_000 });",
                1,
            ),
            (measured, "test.skip('later', async () => {});", 1),
            (measured, "await page.waitForTimeout(100);", 1),
            (measured, "expect(value).toBeTruthy();", 1),
            (measured, "// eslint-disable-next-line playwright/no-wait-for-timeout", 1),
        ):
            with self.subTest(path=path, line=line):
                violations = self.analyze([change(path, added=[line])])
                self.assertEqual(len(violations), expected, violations)

    def test_only_the_live_preview_lane_may_poll_with_a_sleep(self):
        live = "backend/tests/realtime/comms_previews_live.py"
        for path, line, expected in (
            (live, "                time.sleep(0.05)", 0),
            (live, "    pytest.skip('later')", 1),
            (live, "    time.sleep(0.05)  # noqa: S311", 1),
            ("backend/tests/realtime/comms_live.py", "                time.sleep(0.05)", 1),
        ):
            with self.subTest(path=path, line=line):
                violations = self.analyze([change(path, added=[line])])
                self.assertEqual(len(violations), expected, violations)

    def test_measurement_spec_still_needs_ledger_rows_for_removed_assertions(self):
        violations = self.analyze(
            [
                change(
                    "frontend/tests/fullstack/comms-measurements.spec.ts",
                    removed=["expect(misses).toBe(3);"],
                )
            ]
        )
        self.assertEqual(len(violations), 1, violations)

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
    def test_tracked_test_sources_can_be_keyed(self):
        root = Path(guard.__file__).resolve().parents[1]
        tracked = subprocess.run(
            ["git", "ls-files"], cwd=root, check=True, capture_output=True, text=True
        ).stdout.splitlines()
        paths = [path for path in tracked if guard._is_python_test(path) or guard._is_ts_test(path)]
        self.assertTrue(paths, "the tracked test-source inventory must not be empty")
        for path in paths:
            with self.subTest(path=path):
                try:
                    guard._assertion_keys(path, (root / path).read_text(encoding="utf-8"))
                except ValueError as error:
                    self.fail(f"valid tracked test source was refused: {error}")

    def analyze_edit(self, path, before, after, renamed_path=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.run(
                    ["git", *args], cwd=root, check=True, capture_output=True, text=True
                )

            git("init", "-q")
            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI Test")
            file = root / path
            file.parent.mkdir(parents=True)
            comment = "//" if path.endswith(".ts") else "#"
            # Stable context also lets Git recognize formatting plus a rename.
            context = "".join(f"{comment} unchanged context {n}\n" for n in range(30))
            file.write_text(context + before)
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD").stdout.strip()
            if renamed_path:
                renamed = root / renamed_path
                renamed.parent.mkdir(parents=True, exist_ok=True)
                git("mv", str(file), str(renamed))
                file = renamed
            file.write_text(context + after)
            changes = guard.collect_changes(root, base)
            return guard.analyze(changes, [], root)

    def test_multiline_assertion_edits_require_an_owner(self):
        python_literal = (
            "def test_a():\n    assert (\n        response.status_code\n        == 403\n    )\n"
        )
        python_raises = (
            'def test_a():\n    with pytest.raises(\n        ValueError, match="denied access"\n'
            "    ):\n        call()\n"
        )
        python_mock = (
            "def test_a():\n    mock.assert_called_once_with(\n        granted=False,\n    )\n"
        )
        typescript = (
            "test('denied', async () => {\n  await expect(response)\n"
            "    .not.toHaveText('denied access');\n});\n"
        )
        for path, before, after in (
            ("backend/tests/test_a.py", python_literal, python_literal.replace("403", "200")),
            (
                "backend/tests/test_a.py",
                python_raises,
                python_raises.replace("denied access", "deniedaccess"),
            ),
            ("backend/tests/test_a.py", python_mock, python_mock.replace("False", "True")),
            ("frontend/tests/http/a.spec.ts", typescript, typescript.replace(".not", "")),
            (
                "frontend/tests/http/a.spec.ts",
                typescript,
                typescript.replace("toHaveText", "toContainText"),
            ),
            (
                "frontend/tests/http/a.spec.ts",
                typescript,
                typescript.replace("denied access", "deniedaccess"),
            ),
        ):
            with self.subTest(path=path, after=after):
                violations = self.analyze_edit(path, before, after)
                self.assertEqual(len(violations), 1, violations)
                self.assertIn("1 assertion(s) removed, 0 recorded", violations[0])

    def test_formatted_moved_and_renamed_assertions_keep_their_owner(self):
        for path, renamed_path, before, after in (
            (
                "backend/tests/test_a.py",
                "backend/tests/test_moved.py",
                "def test_a():\n    assert response.status_code == 403\n"
                '    assert message == "denied access"\n',
                'def test_moved():\n    assert (\n        message == "denied access"\n    )\n'
                "    assert (\n        response.status_code == 403\n    )\n",
            ),
            (
                "frontend/tests/http/a.spec.ts",
                "frontend/tests/isolated/moved.spec.ts",
                "test('a', async () => {\n"
                "  await expect(response).not.toHaveText('denied access');\n"
                "  expect(count).toBe(2);\n});\n",
                "test('moved', async () => {\n  expect(count).toBe(\n    2,\n  );\n"
                "  await expect(\n    response,\n  ).not.toHaveText(\n"
                '    "denied access",\n  );\n});\n',
            ),
            (
                "frontend/tests/http/a.spec.ts",
                "frontend/tests/isolated/moved.spec.ts",
                "expect(name).toBe(`report ${run.id}.csv`);\n",
                "expect(name).toBe(\n  `report ${ run.id /* formatting */ }.csv`,\n);\n",
            ),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.analyze_edit(path, before, after, renamed_path), [])

    def test_unclosed_assertion_expression_fails_closed(self):
        for path, before, after in (
            (
                "backend/tests/test_a.py",
                "def test_a():\n    assert value == 3\n",
                "def test_a():\n    assert (\n",
            ),
            ("frontend/tests/http/a.spec.ts", "expect(value).toBe(3);\n", "expect(value).toBe(\n"),
            (
                "frontend/tests/http/a.spec.ts",
                "expect(value).toBe(3);\n",
                "expect(value).toBe(3,\n",
            ),
        ):
            with self.subTest(path=path):
                self.assertTrue(self.analyze_edit(path, before, after))

    def test_typescript_literal_and_callback_changes_require_an_owner(self):
        for before, after in (
            (
                "await expect.poll(() => { return { ready: true }; }).toEqual({ ready: true });\n",
                "await expect.poll(() => { return { ready: true }; }).toEqual({ ready: false });\n",
            ),
            (
                "expect(name).toBe(`report ${run.id}.csv`);\n",
                "expect(name).toBe(`report${run.id}.csv`);\n",
            ),
            (
                r"expect(key).toMatch(/^[a-z ()]+$/);" + "\n",
                r"expect(key).toMatch(/^[a-z()]+$/);" + "\n",
            ),
            (
                "expect(value).toBe(2 + /a b/.source.length);\n",
                "expect(value).toBe(2 + /a  b/.source.length);\n",
            ),
        ):
            with self.subTest(before=before):
                violations = self.analyze_edit("frontend/tests/http/a.spec.ts", before, after)
                self.assertEqual(len(violations), 1, violations)
                self.assertIn("1 assertion(s) removed, 0 recorded", violations[0])

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
