"""Mutation runs for one app/ module in its own root (plan items 5 and 24).

``mutmut run "<module>.*"`` from backend/ still builds a copy of all of ``app/`` and
keeps one shared ``backend/mutants`` folder, so two modules cannot keep separate
results. This command gives each module its own working root,
``test-results/mutation/<name>``, the same way ``tests/sample_mutation.py`` does for
operations/sample: links to ``app``, ``operations``, ``tests``, ``migrations``,
``alembic.ini`` and ``uv.lock``, and a copy of backend/pyproject.toml whose
``[tool.mutmut]`` table mutates only the given file against the stack-free tests.

``run`` starts from an empty ``mutants`` folder, so no verdict from earlier tests is
reused. From backend/, run one at a time and nothing else beside it (root rule zero):

    uv run python tests/app_mutation.py fields app/systems/sandbox/fields/validation.py \\
        run --max-children 6
    uv run python tests/app_mutation.py fields app/systems/sandbox/fields/validation.py \\
        results --all true

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
LINKED = ("app", "operations", "tests", "migrations", "alembic.ini", "uv.lock")

APP_CONFIG = """[tool.mutmut]
source_paths = ["app/"]
only_mutate = ["{target}"]
also_copy = ["operations/", "migrations/", "alembic.ini"]
pytest_add_cli_args = [
    "--no-cov",
    "-q",
    "-m",
    "not integration",
    "--ignore=tests/operations",
    "--ignore=tests/auth/test_email_templates.py",
]
process_isolation = "forkserver"

"""


def module_pyproject(text: str, target: str) -> str:
    """Return backend/pyproject.toml with a ``[tool.mutmut]`` table for one file."""

    table = re.compile(r"^\[tool\.mutmut\]\n.*?(?=^\[)", re.MULTILINE | re.DOTALL)
    replaced, count = table.subn(APP_CONFIG.format(target=target), text)
    if count != 1:
        raise SystemExit("backend/pyproject.toml has no single [tool.mutmut] table")
    return replaced


def main(arguments: list[str]) -> int:
    if len(arguments) < 3:
        raise SystemExit(__doc__)
    name, target, *rest = arguments
    if not (BACKEND / target).is_file() or not target.startswith("app/"):
        raise SystemExit(f"{target} is not a file under backend/app")
    root = BACKEND / "test-results/mutation" / name
    root.mkdir(parents=True, exist_ok=True)
    for item in LINKED:
        link = root / item
        if not link.is_symlink():
            link.symlink_to(BACKEND / item)
    (root / "pyproject.toml").write_text(
        module_pyproject((BACKEND / "pyproject.toml").read_text("utf-8"), target), "utf-8"
    )
    if rest[0] == "run":
        shutil.rmtree(root / "mutants", ignore_errors=True)
    # On macOS a forked worker aborts in the system proxy lookup that each new httpx client
    # makes. The stack-free tests use mock transports, so no proxy is ever needed.
    environment = {**os.environ, "no_proxy": "*"}
    command = [sys.executable, "-m", "mutmut", *rest]
    return subprocess.run(command, cwd=root, env=environment).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
