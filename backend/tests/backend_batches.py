"""Focused pytest batches inside one runner-owned disposable stack."""

import argparse
import hashlib
import json
import shlex
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


def batch_targets(arguments, backend):
    if not arguments:
        raise ValueError("Choose test files, subdirectories, or pytest node IDs")
    for argument in arguments:
        path = (backend / argument.split("::", 1)[0]).resolve()
        if (
            argument.startswith("-")
            or not path.is_relative_to((backend / "tests").resolve())
            or path == (backend / "tests").resolve()
            or not path.exists()
        ):
            raise ValueError("Choose targets inside backend/tests; the full suite is pre-push")
        if path.is_file() and not (path.name.startswith("test_") and path.suffix == ".py"):
            raise ValueError("Batch files must be pytest test_*.py files")
    return list(arguments)


def parse_batch(arguments, backend):
    if not arguments or arguments[0] != "--backend-batch":
        return None
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument("--layer", choices=("all", "integration"), default="all")
    parser.add_argument("--match")
    parser.add_argument("targets", nargs="+")
    batch = vars(parser.parse_args(arguments[1:]))
    try:
        batch["targets"] = batch_targets(batch["targets"], backend)
        return batch
    except ValueError as error:
        raise SystemExit(str(error)) from error


def setup_fingerprint(backend):
    """Warm reuse cannot outlive schema, runtime configuration, or dependency edits."""
    paths = [backend / name for name in ("pyproject.toml", "uv.lock", "alembic.ini")]
    paths += [
        backend / "operations/provision_database_role.py",
        backend / "tests/postgres_runtime.py",
    ]
    paths += list((backend / "migrations").rglob("*.py"))
    paths += list((backend / "app/core/config").rglob("*.py"))
    paths += list((backend / "app").rglob("models.py"))
    return {
        str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()
    }


def run_backend_batches(run, backend, private, environment, run_id, batch):
    manifest = private / "database.json"
    manifest.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "urls": [
                    environment["TEST_DATABASE_URL"],
                    environment["MIGRATION_DATABASE_URL"],
                    environment["TEST_INSPECTOR_DATABASE_URL"],
                ],
            }
        )
    )
    manifest.chmod(0o600)
    env = {
        **environment,
        "OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest),
        "OPENSLATE_REQUIRE_DATABASE_TESTS": "true",
    }
    fingerprint = setup_fingerprint(backend)
    targets = batch["targets"]
    pending = set()
    history = []
    report = backend / "test-results/batches" / f"{run_id}.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    while True:
        if fingerprint != setup_fingerprint(backend):
            raise RuntimeError("Batch setup changed; start a fresh disposable session")
        junit = private / "pytest.xml"
        junit.unlink(missing_ok=True)
        started = time.monotonic()
        exit_code = 0
        filters = ["-m", "integration"] if batch.get("layer") == "integration" else []
        if batch.get("match"):
            filters += ["-k", batch["match"]]
        try:
            run(
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    "--no-cov",
                    "-q",
                    "-x",
                    f"--junitxml={junit}",
                    *filters,
                    *targets,
                ],
                backend,
                env,
            )
        except subprocess.CalledProcessError as error:
            exit_code = error.returncode
        counts = {key: 0 for key in ("tests", "failures", "errors", "skipped")}
        if junit.exists():
            for suite in ET.parse(junit).getroot().iter("testsuite"):
                for key in counts:
                    counts[key] += int(suite.get(key, "0"))
        passed = (
            not exit_code
            and counts["tests"] > 0
            and not any(counts[key] for key in ("failures", "errors", "skipped"))
        )
        selection = tuple(targets)
        if passed:
            pending.discard(selection)
        else:
            pending.add(selection)
        history.append(
            {
                "targets": targets,
                "passed": passed,
                "counts": counts,
                "seconds": round(time.monotonic() - started, 3),
            }
        )
        report.write_text(
            json.dumps(
                {"run_id": run_id, "coverage": "not collected", "batches": history}, indent=2
            )
        )
        print(
            f"Backend batch {'PASS' if passed else 'FAIL'}: {counts}; "
            f"{history[-1]['seconds']}s. Details: {report}",
            flush=True,
        )
        if not batch["interactive"]:
            return int(bool(pending))
        while True:
            try:
                answer = input("Enter: rerun batch; test paths: next batch; quit: clean up > ")
            except EOFError:
                return int(bool(pending))
            if answer.strip() == "quit":
                return int(bool(pending))
            try:
                targets = batch_targets(shlex.split(answer), backend) if answer.strip() else targets
                break
            except ValueError as error:
                print(error, flush=True)
