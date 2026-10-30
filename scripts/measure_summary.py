"""Report the CI wall-clock measurements without making them a required check.

A shared runner cannot hold the 300 ms Comms opening limit (docs/plans/ci-stability.md
D2), so CI records the numbers in the job summary and warns on a failed limit. The
pre-push gate keeps the limit blocking on a free machine.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

LIMIT_MS = 300


def rows(results: Path) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for path in sorted(results.rglob("timeline-metrics.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        opening = report.get("opening", {})
        scroll = report.get("scroll") or {}
        found.append(
            (
                path.parent.name,
                f"{report['newest50_ms']:.1f} ms open-to-ready (limit {LIMIT_MS} ms), "
                f"{opening.get('removedRows', '?')} removed rows, "
                f"{len(scroll.get('long_tasks', []))} long scroll tasks",
            )
        )
    return found


def render(results: Path, outcome: str) -> str:
    lines = ["## Comms timeline measurement", "", f"Measurement step: **{outcome}**", ""]
    found = rows(results)
    if not found:
        lines.append("No `timeline-metrics.json` was written.")
    for name, text in found:
        lines.append(f"- `{name}`: {text}")
    lines += [
        "",
        "This job is report-only in CI. `prepush.py` enforces the limit on a free machine.",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("outcome")
    args = parser.parse_args(argv)
    summary = render(args.results, args.outcome)
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(summary)
    else:
        sys.stdout.write(summary)
    if args.outcome != "success":
        print(
            "::warning title=Comms timeline measurement::The measurement step ended with "
            f"{args.outcome}; see the job summary. CI does not block on it."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
