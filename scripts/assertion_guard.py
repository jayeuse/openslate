"""Refuse test changes that weaken protection without evidence (Tier 2.5 plan item 14).

The guard compares a base revision with the working tree. For test files it:

- pairs unchanged assertion expressions per file; every unpaired removal needs rows in
  docs/plans/test-ledger.md that name an existing owner test for each one;
- refuses new skips, retries, sleeps, long timeouts, suppressions, and loose matchers;
- refuses a changed snapshot unless a ledger row records that it was reviewed.

Inline reasons and measurement notes do not authorize forbidden patterns.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import subprocess
import sys
import textwrap
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
_DEFAULT_TIMEOUT_MS: Final = 5_000
# Owner-approved 2026-10-22: this file measures plan section-6 limits of 150 s (offline)
# and 5 minutes (Realtime token lifetime) against real services, so it may raise
# timeouts. The exemption covers only the "timeout raise" rule; assertion removal,
# skips, retries, fixed waits, suppressions and loose matchers stay refused there.
_LONG_TIMEOUT_EXEMPT: Final = frozenset({"frontend/tests/fullstack/comms-measurements.spec.ts"})

_PY_ASSERTIONS: Final = (
    re.compile(r"^\s*assert\b"),
    re.compile(r"\bpytest\.(raises|warns)\("),
    re.compile(r"\.assert_(called|not_called|awaited|has_calls|any_call)\w*\("),
)
# `expect(`, `expect.poll(`, `expect.soft(`, or `expect` ending a line whose call
# continues on the next line; an import of `expect` does not count.
_TS_ASSERTION: Final = re.compile(r"\bexpect(?=\s*(\(|\.(soft|poll)\b|$))")

_PY_FORBIDDEN: Final = {
    "skip or xfail": re.compile(
        r"pytest\.mark\.(skip|skipif|xfail|flaky)\b|pytest\.(skip|xfail|importorskip)\("
    ),
    "rerun": re.compile(r"--reruns|\breruns\s*="),
    # No noqa reason grants approval; preserve the existing type-ignore rule.
    "suppression": re.compile(
        r"#\s*noqa\b|#\s*type:\s*ignore\b(:\s*[A-Z0-9, ]+|\[[\w, -]+\])?\s*$"
    ),
    "tautology": re.compile(r"^\s*assert\s+True\b"),
}
_PY_TIMING: Final = {"sleep": re.compile(r"\b(time|asyncio)\.sleep\(")}
_TS_FORBIDDEN: Final = {
    "skip or fixme": re.compile(r"\btest(\.describe)?\.(skip|fixme|fail)\("),
    "fixed wait": re.compile(r"\bwaitForTimeout\("),
    "suppression": re.compile(
        r"eslint-disable(-next-line|-line)?|@ts-(ignore|expect-error|nocheck)"
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
    # The path before a rename; ledger rows may name either path.
    old_path: str = ""
    # Complete revisions expose edits below unchanged assertion-start lines.
    before_source: str | None = None
    after_source: str | None = None


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


_UNKEYED_TS: Final = "\x00unkeyed TS assertion"
_TS_TOKEN: Final = re.compile(
    r"\s+|//[^\n]*|/\*[\s\S]*?\*/|\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\])*'|"
    r"`(?:\\[\s\S]|[^`\\])*`|[\w$]+|===|!==|>>>?=?|<<=?|\*\*=?|=>|==|!=|<=|>=|"
    r"\?\.|\?\?=?|&&=?|\|\|=?|\+\+|--|[+*/%&|^!-]=|\.\.\.|[^\s]"
)
# "[" may only open a class; letting it also match as a plain character made
# "[]" ambiguous and the match exponential (CodeQL py/redos).
_TS_REGEX: Final = re.compile(r"/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n\[])+/[a-z]*")
_REGEX_PREFIX: Final = frozenset(
    [""]
    + (
        "( [ { = : , ; => ! ~ ? && || ?? + - * / % ** & | ^ < > <= >= == != === !== "
        "<< >> >>> += -= *= /= %= **= &= |= ^= <<= >>= >>>= &&= ||= ??= return throw case "
        "typeof void delete await yield in instanceof"
    ).split()
)
# Verified Playwright option positions; arbitrary expected objects are never options.
_TS_OPTION_ARGS: Final = {
    **dict.fromkeys(
        "toBeAttached toBeChecked toBeDisabled toBeEditable toBeEmpty toBeEnabled "
        "toBeFocused toBeHidden toBeInViewport toBeVisible toPass".split(),
        (0,),
    ),
    **dict.fromkeys(
        "toContainClass toContainText toHaveAccessibleDescription toHaveAccessibleErrorMessage "
        "toHaveAccessibleName toHaveClass toHaveCount toHaveId toHaveRole toHaveText "
        "toHaveValue toHaveValues toHaveTitle toHaveURL poll".split(),
        (1,),
    ),
    **dict.fromkeys("toHaveCSS toHaveJSProperty".split(), (2,)),
    "toHaveAttribute": (1, 2),
    "toHaveScreenshot": (0, 1),
    "toMatchAriaSnapshot": (0, 1),
}


def _ts_tokens(source: str) -> list[str]:
    """Only lexical assertion keys, not a TS parser; unsupported tokens stay unpaired."""
    tokens: list[str] = []
    pos, previous = 0, ""
    while pos < len(source):
        regex = previous in _REGEX_PREFIX and not source.startswith(("//", "/*"), pos)
        match = (_TS_REGEX.match(source, pos) if regex else None) or _TS_TOKEN.match(source, pos)
        assert match is not None  # The final lexical alternative consumes any non-whitespace.
        raw, pos = match.group(), match.end()
        if raw.isspace() or raw.startswith(("//", "/*")):
            continue
        value = raw
        if raw[0] in "'\"" and len(raw) > 1:
            value = "string:" + raw[1:-1]
        elif raw.startswith("`") and len(raw) > 1:
            value = re.sub(
                r"(?<!\\)\$\{((?:[^{}'\"`\\]|'[^{}'`\\]*'|\"[^{}\"`\\]*\")*)\}",
                lambda found: "\x00" + repr(_ts_tokens(found[1])),
                raw,
            )
            value = _UNKEYED_TS if "${" in value else "template:" + value
        tokens.append(value)
        previous = raw
    return tokens


def _ts_assertions(source: str) -> Counter[str]:
    tokens = _ts_tokens(source)

    def balanced(start: int, options: str = "") -> int:
        stack: list[tuple[str, bool]] = []
        arguments = [start + 1]
        for end in range(start, len(tokens)):
            token = tokens[end]
            if token in ("(", "[", "{"):
                stack.append((token, tokens[end - 1] in ("if", "while", "for", "with", "switch")))
            elif token in (")", "]", "}"):
                if not stack:
                    return 0
                opening, control = stack.pop()
                if opening != {")": "(", "]": "[", "}": "{"}[token] or (
                    (control or token == "}") and tokens[end + 1 : end + 2] == ["/"]
                ):
                    return 0
                if not stack:
                    last = end - (tokens[end - 1] == ",")
                    first = arguments[-1]
                    if len(arguments) - 1 in _TS_OPTION_ARGS.get(options, ()) and (
                        tokens[first] == "{" and balanced(first) == last
                    ):
                        cursor, kept = first + 1, False
                        while cursor < last - 1:
                            stop = cursor
                            while stop < last - 1 and tokens[stop] != ",":
                                stop = (
                                    balanced(stop) if tokens[stop] in ("(", "[", "{") else stop + 1
                                )
                                if not stop:
                                    return 0
                            names = {"timeout", "intervals"} if options == "poll" else {"timeout"}
                            if tokens[cursor].removeprefix("string:") in names and (
                                tokens[cursor + 1] == ":"
                            ):
                                ignored.update(range(cursor, min(stop + 1, last - 1)))
                            else:
                                kept = True
                            cursor = stop + 1
                        if not kept:
                            ignored.update(range(first - (len(arguments) > 1), end))
                    return end + 1
            elif token == "," and len(stack) == 1 and tokens[end + 1 : end + 2] != [")"]:
                arguments.append(end + 1)
        return 0

    assertions: Counter[str] = Counter()
    for start, token in enumerate(tokens):
        if token != "expect":
            continue
        end = start + 1
        if tokens[end : end + 2] in ([".", "soft"], [".", "poll"]):
            end += 2
        if end < len(tokens) and tokens[end] == "<":
            assertions[_UNKEYED_TS] += 1
            continue
        if end == len(tokens) or tokens[end] != "(":
            continue  # Imports/references to expect are not assertions.
        ignored: set[int] = set()
        end = balanced(end, "poll" if tokens[start + 1 : start + 3] == [".", "poll"] else "")
        matcher_start = end
        matcher = False
        while end and end < len(tokens) and tokens[end] in (".", "?."):
            end += 1
            if end == len(tokens) or not re.fullmatch(r"[\w$]+", tokens[end]):
                end = 0
                break
            name = tokens[end]
            end += 1
            if end < len(tokens) and tokens[end] == "(":
                end = balanced(end, name)
                matcher = bool(end)
            elif name not in ("not", "resolves", "rejects"):
                end = 0
                break
        begin = start - 1 if start and tokens[start - 1] == "await" else start
        if (
            not end
            or not matcher
            or any(t in (_UNKEYED_TS, "'", '"', "`") for t in tokens[begin:end])
        ):
            assertions[_UNKEYED_TS] += 1
            continue
        # Trailing argument/object commas are formatting, not literal whitespace.
        # Keep array holes (e.g. [a,,]) and consecutive commas distinct.
        values = [
            value for index, value in enumerate(tokens[begin:end], begin) if index not in ignored
        ]
        key = tuple(
            value
            for index, value in enumerate(values)
            if not (
                value == ","
                and index + 1 < len(values)
                and values[index + 1] in (")", "}", "]")
                and values[index - 1] not in ("(", "[", ",")
            )
        )
        # Pinned Locator predicates are complements; only this argument-free tail is proven.
        if (
            tokens[start + 1] == "("
            and tokens[start - 1 : start] not in (["."], ["?."])
            and [
                value
                for index, value in enumerate(tokens[matcher_start:end], matcher_start)
                if index not in ignored
            ]
            == [".", "not", ".", "toBeVisible", "(", ")"]
        ):
            key = key[:-6] + (".", "toBeHidden", "(", ")")
        assertions[repr(key)] += 1
    return assertions


def _assertion_keys(path: str, source: str) -> Counter[str]:
    if _is_ts_test(path):
        return _ts_assertions(source)
    if not _is_python_test(path):
        return Counter()
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise ValueError("cannot parse Python assertion source") from error
    assertions: Counter[str] = Counter()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assert):
            assertions[ast.dump(node, include_attributes=False)] += 1
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            func = node.func
            if (
                isinstance(func.value, ast.Name)
                and func.value.id == "pytest"
                and func.attr in ("raises", "warns")
            ) or re.fullmatch(
                r"assert_(called|not_called|awaited|has_calls|any_call)\w*", func.attr
            ):
                assertions[ast.dump(node, include_attributes=False)] += 1
    return assertions


def _unpaired_assertions(item: FileChange) -> int:
    def keys(source: str | None, lines: list[str]) -> Counter[str]:
        if source is None:
            # Synthetic callers provide complete assertion fragments or nonassertion lines.
            if not count_assertions(item.path, lines):
                return Counter()
            source = textwrap.dedent("\n".join(lines))
        return _assertion_keys(item.path, source)

    before, after = keys(item.before_source, item.removed), keys(item.after_source, item.added)
    after.pop(_UNKEYED_TS, None)  # Unkeyable additions never offset any removed protection.
    return (before - after).total()


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
        try:
            deficit = _unpaired_assertions(item)
        except ValueError as error:
            violations.append(f"{item.path}: assertion analysis refused: {error}")
            continue
        recorded = covered[item.path] + (covered[item.old_path] if item.old_path else 0)
        if deficit > recorded:
            violations.append(
                f"{item.path}: {deficit} assertion(s) removed, {recorded} recorded in "
                f"{LEDGER_PATH} with an owner test"
            )
        new_hits = _pattern_hits(item.path, item.added) - _pattern_hits(item.path, item.removed)
        if item.path in _LONG_TIMEOUT_EXEMPT:
            new_hits.pop("timeout raise", None)
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
                path = new_path[2:]
                current = FileChange(
                    path=path,
                    status="M" if old_path else "A",
                    old_path=old_path if old_path and old_path != path else "",
                )
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
    for item in changes:
        if item.path not in _EXEMPT and (_is_python_test(item.path) or _is_ts_test(item.path)):
            item.before_source = (
                ""
                if item.status == "A"
                else _git(root, "show", f"{base}:{item.old_path or item.path}")
            )
            item.after_source = (
                "" if item.status == "D" else (root / item.path).read_text(encoding="utf-8")
            )
    known = {item.path for item in changes}
    for path in _git(root, "ls-files", "--others", "--exclude-standard").splitlines():
        if path in known:
            continue
        file = root / path
        try:
            source = file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        changes.append(
            FileChange(
                path=path,
                status="A",
                added=source.splitlines(),
                before_source="",
                after_source=source,
            )
        )
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
