"""Generate whole-file HTTP shards from trusted native collection and CI weights.

Current collection owns membership; duration history supplies weights only.
Refresh the seed manually from complete, verified CI reports. Predicted weight
balance is not measured wall time. Run each generated native --test-list without
also passing --shard or positional file filters.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import median


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan"])
    parser.add_argument("--collection", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--shard", type=int, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--test-list", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.shard <= args.shards:
        parser.error("shard must be in the range 1..shards")

    collection = json.loads(args.collection.read_text(encoding="utf-8"))
    seed = json.loads(args.weights.read_text(encoding="utf-8"))
    files = sorted({suite["file"] for suite in collection["suites"]})
    weights = seed["files"]
    default = median(weights.values())
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
