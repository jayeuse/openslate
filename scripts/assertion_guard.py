"""Refuse test changes that weaken protection without evidence (Tier 2.5 plan item 14).

The guard compares a base revision with the working tree. For test files it:

- counts assertions per file; a file that loses assertions needs ledger rows in
  docs/plans/test-ledger.md that name an existing owner test for each one;
- refuses new skips, retries, sleeps, long timeouts, suppressions, and loose matchers;
- refuses a changed snapshot unless a ledger row records that it was reviewed.

Timing values are allowed when the same line carries a `measured:` note.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

LEDGER_PATH: Final = "docs/plans/test-ledger.md"
_EXEMPT: Final = frozenset({"scripts/assertion_guard.py", "tests/tooling/test_assertion_guard.py"})
_PY_TEST_PREFIXES: Final = ("backend/tests/", "tests/tooling/", "packaging/backup/tests/")
_TS_TEST_PREFIXES: Final = ("frontend/tests/",)
_TS_CONFIG_FILES: Final = frozenset(
    {"frontend/playwright.config.ts", "frontend/playwright.fullstack.config.ts"}
)
_SNAPSHOT: Final = re.compile(r"(-snapshots/|__snapshots__/|\.snap$|\.aria\.yml$)")
_MEASURED: Final = re.compile(r"measured:\s*\S")
_DEFAULT_TIMEOUT_MS: Final = 5_000

_PY_ASSERTIONS: Final = (
    re.compile(r"^\s*assert\b"),
    re.compile(r"\bpytest\.(raises|warns)\("),
    re.compile(r"\.assert_(called|not_called|awaited|has_calls|any_call)\w*\("),
)
_TS_ASSERTION: Final = re.compile(r"\bexpect(\.(soft|poll))?\(")

_PY_FORBIDDEN: Final = {
    "skip or xfail": re.compile(
        r"pytest\.mark\.(skip|skipif|xfail|flaky)\b|pytest\.(skip|xfail|importorskip)\("
    ),
    "rerun": re.compile(r"--reruns|\breruns\s*="),
    # A suppression is allowed only with a reason after its codes on the same line.
    "suppression without reason": re.compile(
        r"#\s*(noqa|type:\s*ignore)\b(:\s*[A-Z0-9, ]+|\[[\w, -]+\])?\s*$"
    ),
    "tautology": re.compile(r"^\s*assert\s+True\b"),
}
_PY_TIMING: Final = {"sleep": re.compile(r"\b(time|asyncio)\.sleep\(")}
_TS_FORBIDDEN: Final = {
    "skip or fixme": re.compile(r"\btest(\.describe)?\.(skip|fixme|fail)\("),
    "fixed wait": re.compile(r"\bwaitForTimeout\("),
    # ESLint takes a reason after "--"; TypeScript suppressions are never allowed.
    "suppression without reason": re.compile(
        r"eslint-disable(-next-line|-line)?(?![^\n]*--\s*\S)|@ts-(ignore|expect-error|nocheck)"
    ),
    "loose matcher": re.compile(r"\.(toBeTruthy|toBeFalsy|toBeDefined)\(\)|expect\.anything\(\)"),
    "retry": re.compile(r"\bretries\s*:\s*[1-9]"),
}
_TS_TIMING: Final = {"timeout raise": re.compile(r"\btest\.(setTimeout|slow)\(")}
_TS_TIMEOUT_VALUE: Final = re.compile(r"\btimeout\s*:\s*([\d_]+)")


@dataclass
class FileChange:
    path: str
    status: str
    removed: list[str] = field(default_factory=list)
    added: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class LedgerRow:
    source: str
    count: int
    owner: str
    rule: str


def _is_python_test(path: str) -> bool:
    return path.endswith(".py") and path.startswith(_PY_TEST_PREFIXES)


def _is_ts_test(path: str) -> bool:
    return path.endswith(".ts") and (path.startswith(_TS_TEST_PREFIXES) or path in _TS_CONFIG_FILES)


def count_assertions(path: str, lines: list[str]) -> int:
    if _is_python_test(path):
        return sum(1 for line in lines if any(p.search(line) for p in _PY_ASSERTIONS))
    if _is_ts_test(path):
        return sum(len(_TS_ASSERTION.findall(line)) for line in lines)
    return 0


def _pattern_hits(path: str, lines: list[str]) -> Counter[str]:
    hits: Counter[str] = Counter()
    if _is_python_test(path):
        forbidden, timing = _PY_FORBIDDEN, _PY_TIMING
    elif _is_ts_test(path):
        forbidden, timing = _TS_FORBIDDEN, _TS_TIMING
    else:
        return hits
    for line in lines:
        for name, pattern in forbidden.items():
            hits[name] += len(pattern.findall(line))
        if _MEASURED.search(line):
            continue
        for name, pattern in timing.items():
            hits[name] += len(pattern.findall(line))
        if _is_ts_test(path):
            for value in _TS_TIMEOUT_VALUE.findall(line):
                if int(value.replace("_", "")) > _DEFAULT_TIMEOUT_MS:
                    hits["timeout raise"] += 1
    return hits


def parse_ledger_rows(lines: list[str]) -> list[LedgerRow]:
    rows: list[LedgerRow] = []
    for line in lines:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 4 or not cells[1].isdigit():
            continue
        rows.append(LedgerRow(source=cells[0], count=int(cells[1]), owner=cells[2], rule=cells[3]))
    return rows


def analyze(changes: list[FileChange], ledger: list[LedgerRow], root: Path) -> list[str]:
    """Return one message per violation; an empty list means the change may merge."""

    violations: list[str] = []
    covered: Counter[str] = Counter()
    for row in ledger:
        owner_file = row.owner.split("::", 1)[0]
        if not (root / owner_file).is_file():
            violations.append(f"{LEDGER_PATH}: owner {row.owner!r} for {row.source} does not exist")
            continue
        covered[row.source] += row.count
    snapshot_rows = {row.source for row in ledger if row.rule.lower().startswith("snapshot")}

    for item in changes:
        if item.path in _EXEMPT:
            continue
        if _SNAPSHOT.search(item.path):
            if item.path not in snapshot_rows:
                violations.append(
                    f"{item.path}: snapshot changed; add a 'snapshot' ledger row after review"
                )
            continue
        deficit = count_assertions(item.path, item.removed) - count_assertions(
            item.path, item.added
        )
        if deficit > covered[item.path]:
            violations.append(
                f"{item.path}: {deficit} assertion(s) removed, {covered[item.path]} recorded in "
                f"{LEDGER_PATH} with an owner test"
            )
        new_hits = _pattern_hits(item.path, item.added) - _pattern_hits(item.path, item.removed)
        for name, count in sorted(new_hits.items()):
            violations.append(f"{item.path}: {count} new {name}")
    return violations


def _git(root: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments], cwd=root, check=True, capture_output=True, text=True
    ).stdout


def _parse_diff(text: str) -> list[FileChange]:
    changes: list[FileChange] = []
    current: FileChange | None = None
    old_path = ""
    in_header = False
    for line in text.splitlines():
        if line.startswith("diff --git "):
            current, old_path, in_header = None, "", True
        elif in_header and line.startswith("--- "):
            old_path = "" if line[4:] == "/dev/null" else line[6:]
        elif in_header and line.startswith("+++ "):
            new_path = line[4:]
            if new_path == "/dev/null":
                current = FileChange(path=old_path, status="D")
            else:
                current = FileChange(path=new_path[2:], status="M" if old_path else "A")
            changes.append(current)
        elif line.startswith("@@"):
            in_header = False
        elif current is not None and not in_header and line.startswith("-"):
            current.removed.append(line[1:])
        elif current is not None and not in_header and line.startswith("+"):
            current.added.append(line[1:])
    return changes


def collect_changes(root: Path, base: str) -> list[FileChange]:
    """Changes from *base* to the working tree, including untracked files."""

    diff = _git(root, "diff", "--no-color", "--no-ext-diff", "-M", "--unified=0", base, "--")
    changes = _parse_diff(diff)
    known = {item.path for item in changes}
    for path in _git(root, "ls-files", "--others", "--exclude-standard").splitlines():
        if path in known:
            continue
        file = root / path
        try:
            lines = file.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        changes.append(FileChange(path=path, status="A", added=lines))
    return changes


def ledger_rows_added(changes: list[FileChange]) -> list[LedgerRow]:
    for item in changes:
        if item.path == LEDGER_PATH:
            return parse_ledger_rows(item.added)
    return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--base",
        default=os.getenv("COVERAGE_BASE_REF") or os.getenv("GITHUB_BASE_REF"),
        help="Git revision to compare with the working tree",
    )
    args = parser.parse_args(argv)
    if not args.base:
        parser.error("--base is required")
    root = Path(__file__).resolve().parents[1]
    changes = collect_changes(root, args.base)
    violations = analyze(changes, ledger_rows_added(changes), root)
    for message in violations:
        print(f"test guard: {message}", file=sys.stderr)
    if violations:
        print(
            "test guard: FAIL. Fix the cause, or record evidence in "
            f"{LEDGER_PATH} (see tdd-workflow references/consolidation.md).",
            file=sys.stderr,
        )
        return 1
    print(f"test guard: PASS ({len(changes)} changed file(s) checked)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
