"""Fail CI on a retried test that the flaky ledger does not cover.

CI allows one retry (docs/plans/ci-stability.md D1). A test that passes only on its
retry is "flaky" in the native Playwright JSON report. Each flaky test needs a current
entry in frontend/tests/flaky.json with an owner and an expiry at most 14 days after
it was added; otherwise this check fails. The job summary lists every flaky test.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

MAX_ENTRY_DAYS = 14
FIELDS = ("test", "owner", "added", "expires", "reason")


@dataclass(frozen=True)
class Entry:
    test: str
    owner: str
    added: date
    expires: date
    reason: str


def flaky_tests(report: dict[str, Any]) -> list[str]:
    """Return '<file> › <describe…> › <title>' for each test with status 'flaky'."""

    found: list[str] = []

    def walk(suite: dict[str, Any], titles: tuple[str, ...]) -> None:
        for spec in suite.get("specs", []):
            if any(test.get("status") == "flaky" for test in spec.get("tests", [])):
                found.append(" › ".join((spec["file"], *titles, spec["title"])))
        for child in suite.get("suites", []):
            walk(child, (*titles, child["title"]))

    for top in report.get("suites", []):
        # The top suite is the file itself; its title repeats the file name.
        walk(top, ())
    return sorted(set(found))


def load_ledger(path: Path) -> tuple[dict[str, Entry], list[str]]:
    entries: dict[str, Entry] = {}
    errors: list[str] = []
    for index, raw in enumerate(json.loads(path.read_text(encoding="utf-8"))["tests"]):
        missing = [name for name in FIELDS if not str(raw.get(name, "")).strip()]
        if missing:
            errors.append(f"{path}: entry {index} lacks {', '.join(missing)}")
            continue
        entry = Entry(
            test=raw["test"],
            owner=raw["owner"],
            added=date.fromisoformat(raw["added"]),
            expires=date.fromisoformat(raw["expires"]),
            reason=raw["reason"],
        )
        if entry.expires - entry.added > timedelta(days=MAX_ENTRY_DAYS):
            errors.append(
                f"{path}: {entry.test} expires more than {MAX_ENTRY_DAYS} days after it was added"
            )
        entries[entry.test] = entry
    return entries, errors


def check(flaky: list[str], entries: dict[str, Entry], today: date) -> tuple[list[str], list[str]]:
    """Return (summary lines, failures)."""

    lines: list[str] = []
    failures: list[str] = []
    for test in flaky:
        entry = entries.get(test)
        if entry is None:
            failures.append(f"{test}: passed only on retry and has no flaky.json entry")
            lines.append(f"- ❌ `{test}`: not in the flaky ledger")
        elif entry.expires < today:
            failures.append(f"{test}: passed only on retry; its entry expired on {entry.expires}")
            lines.append(f"- ❌ `{test}`: entry expired on {entry.expires} ({entry.owner})")
        else:
            lines.append(
                f"- ⚠️ `{test}`: known until {entry.expires} ({entry.owner}): {entry.reason}"
            )
    return lines, failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--today", type=date.fromisoformat, default=datetime.now(UTC).date())
    args = parser.parse_args(argv)

    entries, failures = load_ledger(args.ledger)
    if not args.report.is_file():
        print(f"No report at {args.report}; the test identity step reports the missing file.")
        flaky: list[str] = []
    else:
        flaky = flaky_tests(json.loads(args.report.read_text(encoding="utf-8")))
    lines, flaky_failures = check(flaky, entries, args.today)
    failures += flaky_failures

    summary = [f"## Flaky tests in `{args.report.name}`", ""]
    summary += lines or ["No test passed only on its retry."]
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    text = "\n".join(summary) + "\n"
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)
    for failure in failures:
        print(f"::error title=Flaky test ledger::{failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
