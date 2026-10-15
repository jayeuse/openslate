"""Per-test unique coverage for test consolidation (Tier 2.5 plan item 4).

Reads coverage data recorded with ``--cov-context=test`` and reports, for each test,
how many executed lines no other test executes. A test with zero unique lines is a
deletion *candidate* only (rule D1 in tdd-workflow references/consolidation.md):
database guarantees and authorization outcomes are invisible to line coverage.

Record the data serially with the C tracer (sys.monitoring cannot record contexts,
and dynamic contexts break under pytest-xdist), for example from backend/:

    COVERAGE_CORE=ctrace COVERAGE_FILE=test-results/contexts/unit.data \\
        uv run pytest -m "not integration" -p no:xdist --cov=app --cov-context=test \\
        --cov-report= --cov-fail-under=0 tests/<area>
    uv run python tests/coverage_contexts.py test-results/contexts/unit.data

Integration areas use the batch runner: ``--backend-batch --contexts <targets>``.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from coverage import CoverageData


def _test_name(context: str) -> str:
    # pytest-cov names contexts "<node id>|setup", "|run" or "|teardown".
    return context.rsplit("|", 1)[0]


def unique_lines(data_file: Path) -> dict[str, int]:
    """Map each test to the number of lines that only it executes."""

    data = CoverageData(basename=str(data_file))
    data.read()
    tests = {_test_name(context) for context in data.measured_contexts() if context}
    unique: dict[str, int] = dict.fromkeys(tests, 0)
    for path in data.measured_files():
        for contexts in data.contexts_by_lineno(path).values():
            owners = {_test_name(context) for context in contexts if context}
            if len(owners) == 1:
                unique[owners.pop()] += 1
    return unique


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("data_file", type=Path)
    parser.add_argument("--output", type=Path)
    options = parser.parse_args(arguments)
    unique = unique_lines(options.data_file)
    zero = sorted(test for test, count in unique.items() if count == 0)
    output = options.output or options.data_file.with_suffix(".unique.json")
    output.write_text(
        json.dumps(
            {
                "tests": len(unique),
                "zero_unique": zero,
                "unique_lines": dict(sorted(unique.items())),
            },
            indent=2,
        )
        + "\n"
    )
    print(f"{len(unique)} tests; {len(zero)} with zero unique lines. Report: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
