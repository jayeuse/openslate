"""Run the backend coverage gate as parallel shards on this machine, then combine them.

CI runs five shards on separate runners. Locally, three disposable stacks fit beside the
development stack (10 CPUs, 8 GB for Docker, six networks per stack from about 30 address
pools), and the gate takes about 11 minutes instead of 16. Each shard writes to its own
folder; the combine step applies the same 90% overall and changed-line gates as CI and
writes the usual test-results/coverage evidence.

From backend/:  uv run python -m tests.parallel_coverage [--shards 3]
Do not run it beside another heavy job (a live sample run, the frontend suite).
"""

import argparse
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

if __package__:
    from .backend_coverage import OUTPUT_OVERRIDE, combine_backend_coverage
    from .runner_console import relay, stop_on_signals
else:
    from backend_coverage import OUTPUT_OVERRIDE, combine_backend_coverage
    from runner_console import relay, stop_on_signals

BACKEND = Path(__file__).resolve().parents[1]
SHARDS_ROOT = BACKEND / "test-results/coverage-shards"


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shards", type=int, default=3, choices=range(2, 6))
    total = parser.parse_args(arguments).shards
    stop_on_signals()
    if SHARDS_ROOT.exists():
        shutil.rmtree(SHARDS_ROOT)
    SHARDS_ROOT.mkdir(parents=True)
    runs = []
    try:
        for group in range(1, total + 1):
            log = (SHARDS_ROOT / f"shard-{group}.log").open("w")
            environment = {**os.environ, OUTPUT_OVERRIDE: str(SHARDS_ROOT / f"shard-{group}")}
            command = [sys.executable, "-m", "tests.fullstack_runner"]
            command += ["--backend-coverage-shard", f"{group}/{total}"]
            process = subprocess.Popen(
                command,
                cwd=BACKEND,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            # Each shard prints one line per finished test; show them as they arrive.
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
        for _, process, _, _ in runs:
            if process.poll() is None:
                process.terminate()
        for _, process, _, _ in runs:
            process.wait()
    if failed:
        print(f"Backend coverage FAIL; shard logs are in {SHARDS_ROOT}")
        return 1
    return combine_backend_coverage(BACKEND, SHARDS_ROOT, total)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
