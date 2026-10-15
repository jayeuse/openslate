"""Mutation runs for the sample-data engine in operations/sample (plan items 5 and 13, B2).

``[tool.mutmut]`` in backend/pyproject.toml mutates ``app/`` and leaves ``tests/operations``
out. mutmut reads its configuration only from ``./pyproject.toml``, so this command gives
operations/sample its own working root, ``test-results/mutation/sample``: links to
``app``, ``operations``, ``tests``, ``migrations``, ``alembic.ini`` and ``uv.lock``, and
a copy of backend/pyproject.toml whose ``[tool.mutmut]`` table is ``SAMPLE_CONFIG``.
mutmut then works in ``test-results/mutation/sample/mutants`` and never touches
``backend/mutants``.

``run`` starts from an empty ``mutants`` folder, so no verdict from earlier tests is
reused. From backend/, run one at a time and nothing else beside it (root rule zero):

    uv run python tests/sample_mutation.py run "operations.sample.episodes.*" \\
        "operations.sample.history.*"
    uv run python tests/sample_mutation.py results

Any other mutmut command and its arguments pass through unchanged.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND / "test-results/mutation/sample"
LINKED = ("app", "operations", "tests", "migrations", "alembic.ini", "uv.lock")

# Mutate only the planners under review; their owner tests are the stack-free sample
# tests. The control fault matrices (tests/operations/sample/controls) and the route
# coverage test, which reads the frontend route manifest outside the copy, stay out.
SAMPLE_CONFIG = """[tool.mutmut]
source_paths = ["operations/sample/"]
only_mutate = ["operations/sample/episodes.py", "operations/sample/history.py"]
also_copy = ["app/", "operations/", "migrations/", "alembic.ini"]
pytest_add_cli_args = [
    "--no-cov",
    "-q",
    "-m",
    "not integration",
    "--ignore=tests/operations/sample/controls",
    "--ignore=tests/operations/sample/verification/test_frontend_route_coverage.py",
]
pytest_add_cli_args_test_selection = ["tests/operations/sample"]
process_isolation = "forkserver"

"""


def sample_pyproject(text: str) -> str:
    """Return backend/pyproject.toml with its ``[tool.mutmut]`` table replaced."""

    table = re.compile(r"^\[tool\.mutmut\]\n.*?(?=^\[)", re.MULTILINE | re.DOTALL)
    replaced, count = table.subn(SAMPLE_CONFIG, text)
    if count != 1:
        raise SystemExit("backend/pyproject.toml has no single [tool.mutmut] table")
    return replaced


def prepare(fresh: bool) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for name in LINKED:
        link = ROOT / name
        if not link.is_symlink():
            link.symlink_to(BACKEND / name)
    (ROOT / "pyproject.toml").write_text(
        sample_pyproject((BACKEND / "pyproject.toml").read_text("utf-8")), "utf-8"
    )
    if fresh:
        shutil.rmtree(ROOT / "mutants", ignore_errors=True)


def main(arguments: list[str]) -> int:
    if not arguments:
        raise SystemExit(__doc__)
    prepare(fresh=arguments[0] == "run")
    # On macOS a forked worker aborts in the system proxy lookup that each new httpx client
    # makes. The sample tests use mock transports, so no proxy is ever needed.
    environment = {**os.environ, "no_proxy": "*"}
    command = [sys.executable, "-m", "mutmut", *arguments]
    return subprocess.run(command, cwd=ROOT, env=environment).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
