"""Run the backend coverage gate on this machine: the unit lane, then parallel stack shards.

CI runs five shards on separate runners. Locally, three disposable stacks fit beside the
development stack (10 CPUs, 8 GB for Docker); each test stack takes its own network block
outside Docker's default address pools. Each shard writes to its own folder; the combine
step applies the same 90% overall and changed-line gates as CI and writes the usual
test-results/coverage evidence. A stop (Ctrl-C, SIGTERM, SIGHUP) reaches each shard once
and waits for it to remove its stack.

From backend/:  uv run python -m tests.parallel_coverage [--shards 3]
The pre-push gate runs it beside the frontend lane once its stacks have booted. Do not
start another heavy job beside it (for example a live sample run).
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path

if __package__:
    from .backend_coverage import OUTPUT_OVERRIDE, combine_backend_coverage, run_unit_lane
    from .runner_console import relay, stop_on_signals, stop_process_groups
else:
    from backend_coverage import OUTPUT_OVERRIDE, combine_backend_coverage, run_unit_lane
    from runner_console import relay, stop_on_signals, stop_process_groups

BACKEND = Path(__file__).resolve().parents[1]
SHARDS_ROOT = BACKEND / "test-results/coverage-shards"
# A stopped shard stops pytest and removes its stack (several bounded Docker calls of up
# to 30 s each); after this long, its process group is killed.
SHARD_STOP_SECONDS = 180.0
# Tests that need no stack run first, in parallel on the host (measured: 3,032 tests in
# 218 s on 6 workers); the stack shards then run only `integration` tests.
UNIT_LANE_WORKERS = 6


def shard_command(group: int, total: int) -> list[str]:
    return [
        sys.executable,
        "-m",
        "tests.fullstack_runner",
        "--backend-coverage-shard",
        f"{group}/{total}",
    ]


def stop_shards(processes: list[subprocess.Popen[str]]) -> None:
    """Ask each running shard's group to stop once and wait for every teardown.

    A repeated Ctrl-C, SIGTERM, or SIGHUP must not abandon a shard mid-teardown.
    """
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), signal.SIG_IGN)
    stop_process_groups(processes, SHARD_STOP_SECONDS)


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shards", type=int, default=3, choices=range(2, 6))
    total = parser.parse_args(arguments).shards
    stop_on_signals()
    if SHARDS_ROOT.exists():
        shutil.rmtree(SHARDS_ROOT)
    SHARDS_ROOT.mkdir(parents=True)
    if run_unit_lane(BACKEND, SHARDS_ROOT / "unit", UNIT_LANE_WORKERS):
        print(f"Backend unit lane FAIL; evidence is in {SHARDS_ROOT / 'unit'}")
        return 1
    runs = []
    try:
        for group in range(1, total + 1):
            log = (SHARDS_ROOT / f"shard-{group}.log").open("w")
            environment = {**os.environ, OUTPUT_OVERRIDE: str(SHARDS_ROOT / f"shard-{group}")}
            process = subprocess.Popen(
                shard_command(group, total),
                cwd=BACKEND,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                # Its own group: a stop reaches each shard once, from stop_shards below,
                # never a second time through the caller's group signal mid-teardown.
                start_new_session=True,
            )
            # Show what each shard prints (stage names; test results on request) at once.
            reader = threading.Thread(
                target=relay, args=(process.stdout, log, f"[{group}/{total}]"), daemon=True
            )
            reader.start()
            runs.append((group, process, log, reader))
        failed = False
        for group, process, log, reader in runs:
            code = process.wait()
            reader.join()
            log.close()
            print(f"Shard {group}/{total}: exit {code}", flush=True)
            failed = failed or code != 0
    finally:
        # A stopped run stops every shard; each one then removes its own stack.
        running = [process for _, process, _, _ in runs if process.poll() is None]
        if running:
            stop_shards(running)
    if failed:
        print(f"Backend coverage FAIL; shard logs are in {SHARDS_ROOT}")
        return 1
    return combine_backend_coverage(BACKEND, SHARDS_ROOT, total)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
