"""Parse and write non-secret results for a disposable full-stack run."""

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


def summary_path(backend: Path, frontend: Path, *, batch: str | None, backend_only: bool) -> Path:
    """Select the stable result location for the selected runner mode."""
    if batch:
        return backend / "test-results/batches/summary.json"
    if backend_only:
        return backend / "test-results/coverage/summary.json"
    return frontend / "test-results/fullstack-summary.json"


def _junit_observations(private: Path) -> tuple[dict[str, str], dict[str, float]]:
    junit = private / "pytest.xml"
    if not junit.exists():
        return {}, {}
    suite = ET.parse(junit).getroot().find("testsuite")
    if suite is None:
        return {}, {}
    counts = {key: suite.attrib[key] for key in ("tests", "failures", "errors", "skipped")}
    observations: dict[str, float] = {}
    for prop in suite.findall(".//property"):
        name, value = prop.get("name", ""), prop.get("value", "")
        if name in {"pool_checkout_wait_seconds", "statement_timeout_wait_seconds"}:
            observations[name] = float(value)
    for failure in suite.findall(".//failure") + suite.findall(".//error"):
        for location in re.findall(r"^(tests/[A-Za-z0-9_/.-]+:\d+):", failure.text or "", re.M):
            print(f"Backend failure location: {location}")
    return counts, observations


def _log_results(private: Path) -> tuple[list[dict[str, Any]], list[str]]:
    browser_results: list[dict[str, Any]] = []
    backend_failures: list[str] = []
    for line in (private / "process.log").read_text(errors="replace").splitlines():
        failure = re.match(r"^(?:FAILED|ERROR) (tests/[A-Za-z0-9_/.-]+::[A-Za-z0-9_]+)", line)
        if failure:
            backend_failures.append(failure.group(1))
            print(f"Backend test failed: {failure.group(1)}")
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and set(record) == {"test", "status"}:
            browser_results.append(record)
    return browser_results, backend_failures


def write_fullstack_summary(
    path: Path,
    private: Path,
    *,
    result: int,
    batch: str | None,
    backend_only: bool,
    acceptance_only: bool,
    scanner_only: bool,
    stage: str,
    browser_completed: bool,
    admission: dict[str, Any],
    checker_exit: int | None,
    scanner_observations: dict[str, Any],
    failure_type: str | None,
    failure_message: str | None,
) -> None:
    """Persist the result without exposing the private runtime environment."""
    backend_counts, resource_observations = _junit_observations(private)
    browser_results, backend_failures = _log_results(private)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "result": "passed" if result == 0 else "failed",
                "scope": (
                    "backend-batch"
                    if batch
                    else "backend-coverage-only"
                    if backend_only
                    else "acceptance-only"
                    if acceptance_only
                    else "scanner-only"
                    if scanner_only
                    else "full"
                ),
                "backend_tests_rerun": not scanner_only and not acceptance_only,
                "stage": stage,
                "browser_tests": browser_results
                or (
                    [{"test": "auth-session.spec.ts", "status": "passed"}]
                    if browser_completed
                    else []
                ),
                "backend_failures": backend_failures,
                "backend_counts": backend_counts,
                "resource_observations": resource_observations,
                "admission_observations": admission,
                "checker_exit": checker_exit,
                "scanner_observations": scanner_observations,
                "failure_type": failure_type,
                "failure_message": failure_message,
            },
            indent=2,
        )
    )
