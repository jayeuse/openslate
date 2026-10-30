"""Count failed and flaky Playwright tests across recent Frontend CI runs.

`collect` downloads the native JSON reports (`frontend-playwright-*` artifacts, kept for
14 days) of the latest completed Frontend runs on one branch. `summarize` reads a
downloaded folder and prints, per test, how many runs it failed in and how many runs it
passed only on its retry (docs/plans/ci-stability.md S0).
"""

from __future__ import annotations

import argparse
import json
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any


def test_statuses(report: dict[str, Any]) -> dict[str, str]:
    """Map '<file> › <describe…> › <title>' to its worst status in one report."""

    rank = {"unexpected": 3, "flaky": 2, "expected": 1, "skipped": 0}
    statuses: dict[str, str] = {}

    def walk(suite: dict[str, Any], titles: tuple[str, ...]) -> None:
        for spec in suite.get("specs", []):
            name = " › ".join((spec["file"], *titles, spec["title"]))
            for test in spec.get("tests", []):
                status = test.get("status", "skipped")
                if rank.get(status, 0) > rank.get(statuses.get(name, "skipped"), 0):
                    statuses[name] = status
                statuses.setdefault(name, status)
        for child in suite.get("suites", []):
            walk(child, (*titles, child["title"]))

    for top in report.get("suites", []):
        walk(top, ())
    return statuses


def summarize(folder: Path) -> str:
    runs = sorted(path for path in folder.iterdir() if path.is_dir())
    failed: Counter[str] = Counter()
    flaky: Counter[str] = Counter()
    red_runs = 0
    for run in runs:
        statuses: dict[str, str] = {}
        for report in sorted(run.rglob("*.json")):
            data = json.loads(report.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "suites" in data:
                statuses.update(test_statuses(data))
        failures = {name for name, status in statuses.items() if status == "unexpected"}
        failed.update(failures)
        flaky.update(name for name, status in statuses.items() if status == "flaky")
        red_runs += bool(failures)
    lines = [
        f"Runs read: {len(runs)}; runs with a failed test: {red_runs}",
        "",
        "| Test | Failed runs | Flaky runs |",
        "|---|---|---|",
    ]
    for name in sorted(set(failed) | set(flaky), key=lambda key: (-failed[key], -flaky[key], key)):
        lines.append(f"| `{name}` | {failed[name]} | {flaky[name]} |")
    if not failed and not flaky:
        lines.append("| (none) | 0 | 0 |")
    return "\n".join(lines) + "\n"


def collect(folder: Path, branch: str, limit: int) -> None:
    listing = subprocess.run(
        [
            "gh",
            "run",
            "list",
            "--workflow",
            "Frontend",
            "--branch",
            branch,
            "--status",
            "completed",
            "--limit",
            str(limit),
            "--json",
            "databaseId,conclusion",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    for run in json.loads(listing.stdout):
        if run["conclusion"] == "cancelled":
            continue
        target = folder / str(run["databaseId"])
        if target.exists():
            continue
        # Expired artifacts leave no folder; the summary counts only runs it can read.
        subprocess.run(
            [
                "gh",
                "run",
                "download",
                str(run["databaseId"]),
                "--dir",
                str(target),
                "--pattern",
                "frontend-playwright-*",
            ],
            check=False,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    collect_parser = commands.add_parser("collect")
    collect_parser.add_argument("folder", type=Path)
    collect_parser.add_argument("--branch", default="main")
    collect_parser.add_argument("--limit", type=int, default=20)
    summarize_parser = commands.add_parser("summarize")
    summarize_parser.add_argument("folder", type=Path)
    args = parser.parse_args(argv)
    if args.command == "collect":
        args.folder.mkdir(parents=True, exist_ok=True)
        collect(args.folder, args.branch, args.limit)
    print(summarize(args.folder), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
