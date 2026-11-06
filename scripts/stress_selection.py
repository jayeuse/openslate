"""Select recently changed HTTP specs for the nightly stress job.

The job repeats each selected spec 20 times with zero retries, so a race shows before it
reaches a pull request (docs/plans/ci-stability.md S7). Specs changed most recently come
first; the selection stops at a wall-time budget, predicted from the shard weights. On
Sundays the heaviest specs come first, so the 7-day window cannot skip the heaviest spec.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import UTC, date, datetime
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
HTTP_PREFIX = "frontend/tests/http/"
# Wall-clock measurements run alone in the measure project, never under stress.
EXCLUDED = frozenset({"frontend/tests/http/comms-timeline-performance.spec.ts"})
REPEATS = 20
WORKERS = 4
# Wall time over (weight x REPEATS / WORKERS), slowest of 8 measured nights, against the
# current weights. Fast runners measured 1.5 to 1.8; sizing for those would time out on a
# slow runner, 3 nights in 8. Derive it again whenever the weights are refreshed.
WALL_MULTIPLIER = 2.9


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


def budget_ms(minutes: int) -> int:
    """Convert wall minutes to the summed shard weight that fills them on a slow runner."""

    return round(minutes * 60_000 * WORKERS / (REPEATS * WALL_MULTIPLIER))


def spec_weight(path: str, weights: dict[str, int]) -> float:
    fallback = median(weights.values()) if weights else 1
    return weights.get(path.removeprefix("frontend/tests/"), fallback)


def night_order(specs: list[str], weights: dict[str, int], budget: int, today: date) -> list[str]:
    """Put the heaviest first on Sundays; other nights leave out a spec above the budget.

    A spec above the budget listed first would otherwise use up every night.
    """

    if today.weekday() == 6:
        return sorted(specs, key=lambda path: spec_weight(path, weights), reverse=True)
    return [path for path in specs if spec_weight(path, weights) <= budget]


def select(specs: list[str], weights: dict[str, int], budget_ms: int) -> list[str]:
    """Keep specs in order while their summed weight fits the budget (at least one)."""

    chosen: list[str] = []
    used = 0.0
    for path in specs:
        weight = spec_weight(path, weights)
        if chosen and used + weight > budget_ms:
            continue
        chosen.append(path)
        used += weight
    return chosen


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since-days", type=int, default=7)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--budget-minutes", type=int, required=True)
    parser.add_argument("--today", type=date.fromisoformat, default=datetime.now(UTC).date())
    args = parser.parse_args(argv)
    weights = json.loads(args.weights.read_text(encoding="utf-8"))["files"]
    budget = budget_ms(args.budget_minutes)
    specs = night_order(changed_specs(args.since_days), weights, budget, args.today)
    for path in select(specs, weights, budget):
        print(path.removeprefix("frontend/"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
