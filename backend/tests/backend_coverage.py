"""Fresh coverage artifacts for the disposable backend suite (no credentials)."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

COUNT_KEYS = ("tests", "failures", "errors", "skipped")
# A local parallel run gives each shard its own folder; CI and single runs use the default.
OUTPUT_OVERRIDE = "OPENSLATE_COVERAGE_OUTPUT"


def coverage_output(backend):
    return Path(os.environ.get(OUTPUT_OVERRIDE) or backend / "test-results/coverage")


DURATIONS = "tests/.test_durations"
MAX_DURATION_ID = 500


def newest_durations(backend):
    """Split shards by the newest measured durations: the last local combined run, if it
    is newer than the committed file. New tests then stop falling back to the average."""
    candidates = [
        path
        for path in (backend / DURATIONS, backend / "test-results/coverage/test-durations.json")
        if path.exists()
    ]
    return max(candidates, key=lambda path: path.stat().st_mtime, default=None)


def source_inventory(backend):
    return {
        str(path.relative_to(backend)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((backend / "app").rglob("*.py"))
    }


def compact_durations(durations):
    """Keep the committed durations file to one line; backend files stay under 500 lines.

    Parametrized IDs can embed whole payloads (one is 26 MB); pytest-split gives a
    test without a stored duration the average, so long IDs are left out.
    """
    rounded = {
        test: round(seconds, 3)
        for test, seconds in durations.items()
        if len(test) <= MAX_DURATION_ID
    }
    return json.dumps(rounded, sort_keys=True, separators=(",", ":")) + "\n"


def parse_shard(value):
    """Read a CI shard as (group, total), both counted from one."""
    group, _, total = value.partition("/")
    if not (group.isdigit() and total.isdigit() and 1 <= int(group) <= int(total)):
        raise SystemExit("Shard must be GROUP/TOTAL, for example 1/4")
    return int(group), int(total)


def junit_counts(report):
    counts = dict.fromkeys(COUNT_KEYS, 0)
    for suite in ET.parse(report).getroot().iter("testsuite"):
        for key in counts:
            counts[key] += int(suite.get(key, "0"))
    return counts


def suite_passed(counts, stable):
    return (
        stable
        and bool(counts.get("tests"))
        and not any(counts[k] for k in ("failures", "errors", "skipped"))
    )


def run_gate(backend, output):
    """Enforce overall and changed-line coverage on one complete coverage.json."""
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
    if gate.returncode and not (output / "gate.json").exists():
        try:
            diagnostic = json.loads(gate.stdout)
        except (ValueError, TypeError):
            diagnostic = {
                "passed": False,
                "error": "Coverage checker returned no JSON report",
                "exit_code": gate.returncode,
            }
        (output / "gate.json").write_text(json.dumps(diagnostic, indent=2))
    return gate.returncode


def run_backend_coverage(run, backend, private, environment, run_id, shard=None):
    if __package__:
        from .postgres_runtime import assert_runner_database_url
    else:
        from postgres_runtime import assert_runner_database_url

    output = coverage_output(backend)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    before = source_inventory(backend)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=backend, text=True).strip()
    for name, role in (
        ("TEST_DATABASE_URL", "openslate_runtime"),
        ("MIGRATION_DATABASE_URL", "openslate_owner"),
    ):
        assert_runner_database_url(environment[name], environment, allowed_roles=frozenset({role}))
    env = {
        **environment,
        "OPENSLATE_REQUIRE_DATABASE_TESTS": "true",
        "COVERAGE_FILE": str(private / ".coverage"),
    }
    run([sys.executable, "tests/backend_coverage.py"], backend, env)
    if shard:
        # A shard measures part of the suite; the combine step owns the 90% gate.
        group, total = shard
        durations = output / "test-durations.json"
        source = newest_durations(backend)
        if source is not None:
            shutil.copyfile(source, durations)
        # Tests that need no stack run in the unit lane (run_unit_lane).
        reports = [
            "-m",
            "integration",
            f"--splits={total}",
            f"--group={group}",
            "--splitting-algorithm=least_duration",
            f"--durations-path={durations}",
            "--store-durations",
            "--clean-durations",
            "--cov-fail-under=0",
        ]
    else:
        reports = [
            f"--cov-report=json:{private / 'coverage.json'}",
            f"--cov-report=xml:{private / 'coverage.xml'}",
            f"--cov-report=html:{private / 'html'}",
        ]
    gate_exit = 1
    try:
        run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-v",
                "--cov=app",
                *reports,
                f"--junitxml={private / 'pytest.xml'}",
            ],
            backend,
            env,
        )
    finally:
        counts = {}
        if (private / "pytest.xml").exists():
            counts = junit_counts(private / "pytest.xml")
            if shard:
                shutil.copyfile(private / "pytest.xml", output / "pytest.xml")
        if shard and (private / ".coverage").exists():
            shutil.copyfile(private / ".coverage", output / "coverage.data")
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
                    "shard": list(shard) if shard else None,
                    "source_hashes": before,
                    "source_stable": stable,
                    "test_counts": counts,
                },
                indent=2,
            )
        )
        gate_exit = 0 if shard else run_gate(backend, output)
    if gate_exit or not suite_passed(counts, stable):
        raise RuntimeError("Backend coverage requires stable sources and a complete passing suite")
    if shard and shard[0] != 1:
        return
    # Operational tests still run above; report their denominator independently.
    run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-v",
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


def run_unit_lane(backend, output, workers):
    """Run every test not marked `integration` without a stack, in parallel.

    It writes shard-like evidence (coverage data, JUnit, metadata with
    lane "unit") that combine_backend_coverage merges with the stack shards.
    A test that needs a stack fails or skips here, and either fails the lane.
    """
    if any(os.getenv(name) for name in ("TEST_DATABASE_URL", "MIGRATION_DATABASE_URL")):
        raise SystemExit("The unit lane runs without a stack; unset the database URLs")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    before = source_inventory(backend)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=backend, text=True).strip()
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-m",
            "not integration",
            "-n",
            str(workers),
            "--dist",
            "worksteal",
            "--cov=app",
            "--cov-report=",
            "--cov-fail-under=0",
            f"--junitxml={output / 'pytest.xml'}",
        ],
        cwd=backend,
        env={**os.environ, "COVERAGE_FILE": str(output / "coverage.data")},
    )
    counts = junit_counts(output / "pytest.xml") if (output / "pytest.xml").exists() else {}
    stable = before == source_inventory(backend)
    (output / "metadata.json").write_text(
        json.dumps(
            {
                "revision": revision,
                "base_ref": os.getenv("COVERAGE_BASE_REF"),
                "lane": "unit",
                "source_hashes": before,
                "source_stable": stable,
                "test_counts": counts,
            },
            indent=2,
        )
    )
    passed = result.returncode == 0 and suite_passed(counts, stable)
    print(f"Backend unit lane {'PASS' if passed else 'FAIL'}: {counts}", flush=True)
    return 0 if passed else 1


def combine_backend_coverage(backend, shards_dir, total):
    """Merge every CI shard into one report, then apply the normal coverage gate."""
    from coverage import Coverage

    output = backend / "test-results/coverage"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shards = {}
    units = []
    for metadata_path in sorted(shards_dir.rglob("metadata.json")):
        metadata = json.loads(metadata_path.read_text())
        if metadata.get("lane") == "unit":
            units.append(metadata_path.parent)
            continue
        group = tuple(metadata.get("shard") or ())
        if len(group) != 2 or group[1] != total or group in shards:
            raise SystemExit(f"Unexpected or duplicate shard evidence: {metadata_path}")
        shards[group] = metadata_path.parent
    expected = {(group, total) for group in range(1, total + 1)}
    if set(shards) != expected:
        raise SystemExit(f"Expected {total} coverage shards, found {sorted(shards)}")
    if len(units) != 1:
        raise SystemExit(f"Expected one unit lane beside the shards, found {len(units)}")
    folders = [shards[group] for group in sorted(shards)] + units

    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=backend, text=True).strip()
    counts = dict.fromkeys(COUNT_KEYS, 0)
    stable = True
    durations = {}
    for folder in folders:
        metadata = json.loads((folder / "metadata.json").read_text())
        stable = stable and metadata["source_stable"] and metadata["revision"] == revision
        stable = stable and metadata["source_hashes"] == source_inventory(backend)
        for key, value in junit_counts(folder / "pytest.xml").items():
            counts[key] += value
        if (folder / "test-durations.json").exists():
            durations.update(json.loads((folder / "test-durations.json").read_text()))
        if (folder / "operational-coverage.json").exists():
            shutil.copyfile(
                folder / "operational-coverage.json", output / "operational-coverage.json"
            )

    coverage = Coverage(data_file=str(output / ".coverage"), source=[str(backend / "app")])
    coverage.combine([str(folder / "coverage.data") for folder in folders], keep=True)
    coverage.save()
    coverage.json_report(outfile=str(output / "coverage.json"))
    coverage.xml_report(outfile=str(output / "coverage.xml"))
    (output / ".coverage").unlink()
    (output / "test-durations.json").write_text(compact_durations(durations))
    (output / "metadata.json").write_text(
        json.dumps(
            {
                "revision": revision,
                "base_ref": os.getenv("COVERAGE_BASE_REF"),
                "shards": total,
                "source_stable": stable,
                "test_counts": counts,
            },
            indent=2,
        )
    )
    gate_exit = run_gate(backend, output)
    passed = not gate_exit and suite_passed(counts, stable)
    print(f"Backend coverage {'PASS' if passed else 'FAIL'}: {counts}")
    return 0 if passed else 1


if __name__ == "__main__":
    if sys.argv[1:2] == ["unit"]:
        parser = argparse.ArgumentParser(prog="backend_coverage.py unit")
        parser.add_argument("--workers", type=int, default=4)
        options = parser.parse_args(sys.argv[2:])
        backend = Path(__file__).resolve().parents[1]
        raise SystemExit(run_unit_lane(backend, coverage_output(backend), options.workers))
    if sys.argv[1:2] == ["combine"]:
        parser = argparse.ArgumentParser(prog="backend_coverage.py combine")
        parser.add_argument("shards_dir", type=Path)
        parser.add_argument("--shards", type=int, required=True)
        options = parser.parse_args(sys.argv[2:])
        backend = Path(__file__).resolve().parents[1]
        raise SystemExit(combine_backend_coverage(backend, options.shards_dir, options.shards))
    if any(
        os.getenv(name) is None
        for name in (
            "TEST_DATABASE_URL",
            "MIGRATION_DATABASE_URL",
        )
    ):
        raise SystemExit("Coverage requires runner-owned PostgreSQL database URLs")
