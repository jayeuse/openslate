"""Select recently changed HTTP specs for the nightly stress job.

The job repeats each selected spec 20 times with zero retries, so a race shows before it
reaches a pull request (docs/plans/ci-stability.md S7). Specs changed most recently come
first; the selection stops at a test-time budget taken from the shard weights.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
HTTP_PREFIX = "frontend/tests/http/"
# Wall-clock measurements run alone in the measure project, never under stress.
EXCLUDED = frozenset({"frontend/tests/http/comms-timeline-performance.spec.ts"})


def changed_specs(since_days: int, root: Path = ROOT) -> list[str]:
    """Return HTTP spec paths changed in the window, newest change first, once each."""

    log = subprocess.run(
        [
            "git",
            "log",
            f"--since={since_days}.days",
            "--name-only",
            "--pretty=format:",
            "--",
            HTTP_PREFIX,
        ],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    seen: list[str] = []
    for line in log.splitlines():
        path = line.strip()
        if (
            path.endswith(".spec.ts")
            and path not in EXCLUDED
            and path not in seen
            and (root / path).is_file()
        ):
            seen.append(path)
    return seen


def select(specs: list[str], weights: dict[str, int], budget_ms: int) -> list[str]:
    """Keep specs in order while their summed weight fits the budget (at least one)."""

    fallback = median(weights.values()) if weights else 1
    chosen: list[str] = []
    used = 0.0
    for path in specs:
        weight = weights.get(path.removeprefix("frontend/tests/"), fallback)
        if chosen and used + weight > budget_ms:
            continue
        chosen.append(path)
        used += weight
    return chosen


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since-days", type=int, default=7)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--budget-seconds", type=int, required=True)
    args = parser.parse_args(argv)
    weights = json.loads(args.weights.read_text(encoding="utf-8"))["files"]
    for path in select(changed_specs(args.since_days), weights, args.budget_seconds * 1000):
        print(path.removeprefix("frontend/"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
