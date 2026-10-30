"""Generate whole-file HTTP shards from trusted native collection and CI weights.

Current collection owns membership; duration history supplies weights only.
Refresh the seed with the `weights` command from the six HTTP reports of one complete,
green CI run (the `frontend-playwright-http-*` artifacts). Predicted weight balance is
not measured wall time. Run each generated native --test-list without
also passing --shard or positional file filters.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import median
from typing import Any


def weights_from_reports(reports: Path, shards: int) -> dict[str, object]:
    """Sum each file's test durations (every attempt) across one run's shard reports."""

    metadata = sorted(reports.rglob("http-*.metadata.txt"))
    if len(metadata) != shards:
        raise SystemExit(f"expected {shards} shard reports, found {len(metadata)}")
    identities = set()
    files: dict[str, float] = {}
    for path in metadata:
        fields = dict(
            line.split("=", 1)
            for line in path.read_text(encoding="utf-8").splitlines()
            if "=" in line
        )
        identities.add((fields["run_id"], fields["revision"], fields["tree"]))
        report = json.loads(path.with_name(path.name.replace(".metadata.txt", ".json")).read_text())
        if report["stats"]["unexpected"]:
            raise SystemExit(f"{path.name}: the run has failed tests; use a green run")

        def walk(suite: dict[str, Any]) -> None:
            for spec in suite.get("specs", []):
                for test in spec.get("tests", []):
                    files[spec["file"]] = files.get(spec["file"], 0) + sum(
                        result["duration"] for result in test.get("results", [])
                    )
            for child in suite.get("suites", []):
                walk(child)

        for suite in report["suites"]:
            walk(suite)
    if len(identities) != 1:
        raise SystemExit("shard reports come from different runs or revisions")
    run_id, revision, tree = identities.pop()
    return {
        "provenance": {"run_id": run_id, "revision": revision, "tree": tree, "units": "ms"},
        "files": {file: round(files[file]) for file in sorted(files)},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    refresh = commands.add_parser("weights")
    refresh.add_argument("--reports", type=Path, required=True)
    refresh.add_argument("--shards", type=int, required=True)
    refresh.add_argument("--output", type=Path, required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--collection", type=Path, required=True)
    plan.add_argument("--weights", type=Path, required=True)
    plan.add_argument("--shard", type=int, required=True)
    plan.add_argument("--shards", type=int, required=True)
    plan.add_argument("--test-list", type=Path, required=True)
    plan.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "weights":
        seed = weights_from_reports(args.reports, args.shards)
        args.output.write_text(json.dumps(seed, indent=2) + "\n", encoding="utf-8")
        return
    if not 1 <= args.shard <= args.shards:
        parser.error("shard must be in the range 1..shards")

    collection = json.loads(args.collection.read_text(encoding="utf-8"))
    seed = json.loads(args.weights.read_text(encoding="utf-8"))
    files = sorted({suite["file"] for suite in collection["suites"]})
    weights = seed["files"]
    default = median(weights.values()) if weights else 1
    current_weights = {file: weights.get(file, default) for file in files}
    assignments = [
        {"shard": index + 1, "files": [], "weight_ms": 0} for index in range(args.shards)
    ]
    for file in sorted(files, key=lambda file: (-current_weights[file], file)):
        selected = min(assignments, key=lambda bin_: (bin_["weight_ms"], bin_["shard"]))
        selected["files"].append(file)
        selected["weight_ms"] += current_weights[file]

    partition = [file for bin_ in assignments for file in bin_["files"]]
    if sorted(partition) != files:
        parser.error("assignment differs from current native collection")
    selected = assignments[args.shard - 1]
    receipt = {
        "duration_shard": f"{args.shard}/{args.shards}",
        "provenance": seed["provenance"],
        "fallback_weight_ms": default,
        "assignments": assignments,
    }
    args.test_list.write_text(
        "".join(f"[http] › {file}\n" for file in sorted(selected["files"])), encoding="utf-8"
    )
    args.receipt.write_text(json.dumps(receipt, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "duration_shard": receipt["duration_shard"],
                "files": len(selected["files"]),
                "predicted_weight_ms": selected["weight_ms"],
            }
        )
    )


if __name__ == "__main__":
    main()
