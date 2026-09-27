"""Fresh coverage artifacts for the disposable backend suite (no credentials)."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET


def source_inventory(backend):
    return {
        str(path.relative_to(backend)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((backend / "app").rglob("*.py"))
    }


def run_backend_coverage(run, backend, private, environment, run_id):
    if __package__:
        from .postgres_runtime import assert_runner_database_url
    else:
        from postgres_runtime import assert_runner_database_url

    output = backend / "test-results/coverage"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    before = source_inventory(backend)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=backend, text=True).strip()
    for name, role in (
        ("TEST_DATABASE_URL", "openslate_runtime"),
        ("MIGRATION_DATABASE_URL", "openslate_owner"),
    ):
        assert_runner_database_url(
            environment[name], environment, allowed_roles=frozenset({role})
        )
    env = {
        **environment,
        "OPENSLATE_REQUIRE_DATABASE_TESTS": "true",
        "COVERAGE_FILE": str(private / ".coverage"),
    }
    run([sys.executable, "tests/backend_coverage.py"], backend, env)
    gate_exit = 1
    try:
        run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "--cov=app",
                f"--cov-report=json:{private / 'coverage.json'}",
                f"--cov-report=xml:{private / 'coverage.xml'}",
                f"--cov-report=html:{private / 'html'}",
                f"--junitxml={private / 'pytest.xml'}",
            ],
            backend,
            env,
        )
    finally:
        counts = {}
        if (private / "pytest.xml").exists():
            suites = ET.parse(private / "pytest.xml").getroot().iter("testsuite")
            counts = {key: 0 for key in ("tests", "failures", "errors", "skipped")}
            for suite in suites:
                for key in counts:
                    counts[key] += int(suite.get(key, "0"))
        for name in ("coverage.json", "coverage.xml", "html"):
            source = private / name
            if source.is_dir():
                shutil.copytree(source, output / name)
            elif source.exists():
                shutil.copyfile(source, output / name)
        stable = before == source_inventory(backend)
        (output / "metadata.json").write_text(
            json.dumps(
                {
                    "revision": revision,
                    "base_ref": os.getenv("COVERAGE_BASE_REF"),
                    "run_id": run_id,
                    "source_hashes": before,
                    "source_stable": stable,
                    "test_counts": counts,
                },
                indent=2,
            )
        )
        gate = subprocess.run(
            [
                sys.executable,
                str(backend.parent / "scripts/check_coverage.py"),
                "--project",
                "backend",
                "--report",
                str(output / "coverage.json"),
                "--base-ref",
                os.getenv("COVERAGE_BASE_REF", ""),
                "--output",
                str(output / "gate.json"),
            ],
            cwd=backend.parent,
            capture_output=True,
            text=True,
        )
        gate_exit = gate.returncode
        if gate_exit and not (output / "gate.json").exists():
            try:
                diagnostic = json.loads(gate.stdout)
            except (ValueError, TypeError):
                diagnostic = {
                    "passed": False,
                    "error": "Coverage checker returned no JSON report",
                    "exit_code": gate_exit,
                }
            (output / "gate.json").write_text(json.dumps(diagnostic, indent=2))
    if (
        gate_exit
        or not stable
        or not counts.get("tests")
        or any(counts[k] for k in ("failures", "errors", "skipped"))
    ):
        raise RuntimeError("Backend coverage requires stable sources and a complete passing suite")
    # Operational tests still run above; report their denominator independently.
    run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-o",
            "addopts=",
            "tests/security_events/test_operational_checker.py",
            "--cov=operations.check_operational_health",
            "--cov-fail-under=0",
            f"--cov-report=json:{output / 'operational-coverage.json'}",
        ],
        backend,
        {**env, "COVERAGE_FILE": str(private / ".coverage-operational")},
    )


if __name__ == "__main__":
    if any(
        os.getenv(name) is None
        for name in (
            "TEST_DATABASE_URL",
            "MIGRATION_DATABASE_URL",
        )
    ):
        raise SystemExit("Coverage requires runner-owned PostgreSQL database URLs")
