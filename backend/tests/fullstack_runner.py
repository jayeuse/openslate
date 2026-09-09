"""Run the release smoke suite against a newly created, disposable Supabase stack.

No existing stack, database, identity or personal environment is reused. All
secrets and raw process output stay in a private temporary directory.
"""

import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import tomllib
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import httpx
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
API = "http://127.0.0.1:8008"
AUTH = "http://127.0.0.1:55321"
WEB = "http://localhost:3008"


def measure_admission():
    """Exercise a bounded local burst and recovery; this is not a capacity target."""
    held = []
    try:
        # Hold idle accepted connections to deterministically reach Uvicorn's
        # configured admission limit without adding a production test endpoint.
        for _ in range(32):
            held.append(socket.create_connection(("127.0.0.1", 8008), timeout=2))
        if httpx.get(API + "/api/health", timeout=6).status_code != 503:
            raise RuntimeError("admission limit was not enforced")
    finally:
        for connection in held:
            connection.close()

    def request_health(_):
        started_at = time.perf_counter()
        response = httpx.get(API + "/api/health", timeout=6)
        if response.status_code not in (200, 503):
            raise RuntimeError("unexpected admission response")
        if response.status_code == 200 and "x-request-id" not in response.headers:
            raise RuntimeError("missing application diagnostic ID")
        return response.status_code, time.perf_counter() - started_at

    with ThreadPoolExecutor(max_workers=40) as workers:
        results = list(workers.map(request_health, range(64)))
    if httpx.get(API + "/api/health", timeout=6).status_code != 200:
        raise RuntimeError("admission did not recover")
    waits = sorted(elapsed for _, elapsed in results)
    return {
        "requests": len(results),
        "accepted": sum(status == 200 for status, _ in results),
        "overloaded": sum(status == 503 for status, _ in results),
        "p95_seconds": round(waits[int(len(waits) * 0.95)], 3),
        "recovered": True,
        "overload_rejected": True,
    }


def wait_for(url, process):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("application process exited")
        try:
            if httpx.get(url, timeout=2).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    raise RuntimeError("application startup deadline exceeded")


def seed(owner_url, secret_key, run_id):
    """Owner-only fixture setup, guarded by a brand-new empty application DB."""
    engine = create_engine(owner_url)
    identities = {}
    try:
        with engine.connect() as connection:
            if connection.scalar(text("SELECT count(*) FROM public.users")) != 0:
                raise RuntimeError("refusing to seed a nonempty database")
        headers = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}
        with httpx.Client(base_url=AUTH, headers=headers, timeout=10) as client:
            for role in ("admin", "member"):
                email = f"p5-{run_id}-{role}@example.com"
                password = f"P5-{secrets.token_urlsafe(24)}!9"
                response = client.post(
                    "/auth/v1/admin/users",
                    json={
                        "email": email,
                        "password": password,
                        "email_confirm": True,
                    },
                )
                response.raise_for_status()
                identity = response.json()["id"]
                with engine.begin() as connection:
                    result = connection.execute(
                        text(
                            "UPDATE public.users SET status='active', username=:username, "
                            "role_id=(SELECT id FROM public.roles WHERE role=:role), "
                            "invitation_sent_at=NULL, invitation_accepted_at=NULL WHERE id=:id"
                        ),
                        {"username": f"p5-{role}", "role": role, "id": identity},
                    )
                    if result.rowcount != 1:
                        raise RuntimeError("Auth trigger did not provision fixture profile")
                identities[role] = {"email": email, "password": password, "id": identity}
    finally:
        engine.dispose()
    return identities


def main():
    for port in (55321, 55322, 55323, 55324, 8008, 3008):
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", port))
            except OSError:
                print(f"Full-stack preflight failed: dedicated test port {port} is in use.")
                return 1
    run_id = uuid4().hex
    private = Path(tempfile.mkdtemp(prefix="openslate-p5-"))
    processes = []
    stage = "prepare"
    started = False
    result = 1
    admission = {}
    checker_exit = None
    summary_path = FRONTEND / "test-results/fullstack-summary.json"
    # Child programs receive allowlisted configuration, never the root .env.
    base_env = {
        name: os.environ[name]
        for name in ("PATH", "HOME", "TMPDIR", "UV_CACHE_DIR")
        if name in os.environ
    }
    (private / "tmp").mkdir(mode=0o700)
    base_env["TMPDIR"] = str(private / "tmp")
    log = (private / "process.log").open("w")

    def run(command, cwd, env=base_env, capture=False):
        print(f"Full-stack: {stage}", flush=True)
        return subprocess.run(
            command,
            cwd=cwd,
            env=env,
            check=True,
            stdout=subprocess.PIPE if capture else log,
            stderr=log,
            text=True,
        )

    try:
        shutil.copytree(
            ROOT / "supabase",
            private / "supabase",
            ignore=shutil.ignore_patterns(".temp", ".branches"),
        )
        config = private / "supabase/config.toml"
        source = config.read_text()
        source = source.replace('project_id = "openslate"', f'project_id = "p5-{run_id}"')
        source = re.sub(r"5432([0-9])", r"5532\1", source)
        source = source.replace("localhost:3000", "localhost:3008")
        # Real token expiry is exercised without waiting an hour in CI.
        source = source.replace("jwt_expiry = 3600", "jwt_expiry = 60")
        configured = tomllib.loads(source)
        if (
            configured["project_id"] != f"p5-{run_id}"
            or configured["db"]["port"] != 55322
            or configured["api"]["port"] != 55321
            or configured["auth"]["site_url"] != WEB
            or configured["auth"]["jwt_expiry"] != 60
        ):
            raise RuntimeError("disposable configuration rewrite did not match")
        config.write_text(source)
        stage = "Supabase startup"
        started = True
        run(["supabase", "start"], private)
        status = json.loads(run(["supabase", "status", "-o", "json"], private, capture=True).stdout)
        owner_url = status["DB_URL"].replace("postgresql://", "postgresql+psycopg://", 1)
        if ":55322/" not in owner_url or status["API_URL"] != AUTH:
            raise RuntimeError("unexpected disposable service tuple")
        publishable = status["PUBLISHABLE_KEY"]
        secret_key = status["SECRET_KEY"]
        env = {
            **base_env,
            "DATABASE_URL": owner_url,
            "MIGRATION_DATABASE_URL": owner_url,
            "SUPABASE_URL": AUTH,
            "SUPABASE_PUBLISHABLE_KEY": publishable,
            "SUPABASE_SECRET_KEY": secret_key,
            "SUPABASE_AUTH_REDIRECT_URL": WEB + "/auth/callback",
            "SUPABASE_JWT_ISSUER": AUTH + "/auth/v1",
            "SUPABASE_JWKS_URL": AUTH + "/auth/v1/.well-known/jwks.json",
            "ENVIRONMENT": "test",
            "LIFECYCLE_PURGE_ENABLED": "false",
            "SECURITY_EVENT_SERVER_KEY": secrets.token_urlsafe(32),
            "CORS_ORIGINS": json.dumps([WEB]),
        }
        stage = "migrations"
        run([sys.executable, "-m", "alembic", "upgrade", "head"], BACKEND, env)
        run([sys.executable, "-m", "alembic", "check"], BACKEND, env)
        stage = "runtime role"
        password = secrets.token_urlsafe(32)
        run(
            [sys.executable, "scripts/provision_database_role.py", "--confirm"],
            BACKEND,
            {**env, "OPENSLATE_DATABASE_PASSWORD": password},
        )
        env["DATABASE_URL"] = (
            f"postgresql+psycopg://openslate_runtime:{password}@127.0.0.1:55322/postgres"
        )
        stage = "backend regression and coverage gate"
        run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-q",
                "--cov=app",
                "--cov=scripts.check_operational_health",
                "--cov-report=term",
                f"--cov-report=json:{private / 'coverage.json'}",
                f"--junitxml={private / 'pytest.xml'}",
            ],
            BACKEND,
            {
                **env,
                "TEST_DATABASE_URL": env["DATABASE_URL"],
                "OPENSLATE_FULLSTACK_RUN_ID": run_id,
                "E2E_ALLOW_MUTATIONS": "true",
            },
        )
        coverage = json.loads((private / "coverage.json").read_text())
        print(f"Backend coverage: {coverage['totals']['percent_covered']:.2f}%", flush=True)
        stage = "dedicated identities"
        identities = seed(owner_url, secret_key, run_id)
        fixture = private / "fixture.json"
        fixture.write_text(
            json.dumps(
                {
                    "runId": run_id,
                    "baseURL": WEB,
                    "authURL": AUTH,
                    "mailURL": "http://127.0.0.1:55324",
                    **identities,
                }
            )
        )
        fixture.chmod(0o600)
        stage = "FastAPI startup"
        # Keep migration credentials out of the running API process.
        api_env = {**env, "MIGRATION_DATABASE_URL": ""}
        processes.append(
            subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8008",
                    "--no-access-log",
                    "--limit-concurrency",
                    "32",
                ],
                cwd=BACKEND,
                env=api_env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        )
        wait_for(API + "/api/ready", processes[-1])
        stage = "bounded admission and recovery"
        admission = measure_admission()
        frontend_env = {
            **base_env,
            "BACKEND_URL": API,
            "NEXT_PUBLIC_SUPABASE_URL": AUTH,
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable,
            "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED": "false",
            "PORT": "3008",
            "HOSTNAME": "localhost",
        }
        stage = "production frontend build"
        run(["npm", "run", "build"], FRONTEND, frontend_env)
        stage = "production frontend startup"
        processes.append(
            subprocess.Popen(
                ["npm", "run", "start"],
                cwd=FRONTEND,
                env=frontend_env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        )
        wait_for(WEB + "/login", processes[-1])
        stage = "browser acceptance"
        test_env = {
            **frontend_env,
            "OPENSLATE_FULLSTACK_FIXTURE": str(fixture),
            "OPENSLATE_FULLSTACK_RUN_ID": run_id,
            "E2E_ALLOW_MUTATIONS": "true",
            "PLAYWRIGHT_NO_COPY_PROMPT": "1",
        }
        run(
            ["npx", "playwright", "test", "--config=playwright.fullstack.config.ts"],
            FRONTEND,
            test_env,
        )
        stage = "read-only operational checker"
        try:
            run([sys.executable, "scripts/check_operational_health.py"], BACKEND, api_env)
            checker_exit = 0
        except subprocess.CalledProcessError as error:
            # Backend regressions deliberately persist partial operation fixtures.
            # Attention is valid detection; loss of visibility must fail the gate.
            checker_exit = error.returncode
            if checker_exit != 1:
                raise
        result = 0
    except Exception:
        print(f"Full-stack FAIL at {stage}. See sanitized fullstack-summary.json.")
        result = 1
    finally:
        try:
            for process in reversed(processes):
                if process.poll() is not None:
                    continue
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
            if started:
                try:
                    run(["supabase", "stop", "--no-backup"], private)
                except Exception:
                    print("Disposable stack cleanup failed; operator attention required.")
                    result = 1
            log.close()
            coverage_path = private / "coverage.json"
            if coverage_path.exists():
                # Coverage contains source paths and line numbers, never runtime values.
                shutil.copyfile(coverage_path, BACKEND / "coverage.json")
            browser_results = []
            backend_failures = []
            backend_counts = {}
            resource_observations = {}
            junit = private / "pytest.xml"
            if junit.exists():
                suite = ET.parse(junit).getroot().find("testsuite")
                if suite is not None:
                    backend_counts = {
                        key: suite.attrib[key] for key in ("tests", "failures", "errors", "skipped")
                    }
                    for prop in suite.findall(".//property"):
                        name, value = prop.get("name", ""), prop.get("value", "")
                        if name in {"pool_checkout_wait_seconds", "statement_timeout_wait_seconds"}:
                            resource_observations[name] = float(value)
                    for failure in suite.findall(".//failure") + suite.findall(".//error"):
                        # Static Python source locations aid diagnosis without raw errors.
                        for location in re.findall(
                            r"^(tests/[A-Za-z0-9_/.-]+:\d+):", failure.text or "", re.M
                        ):
                            print(f"Backend failure location: {location}")
            for line in (private / "process.log").read_text(errors="replace").splitlines():
                failure = re.match(
                    r"^(?:FAILED|ERROR) (tests/[A-Za-z0-9_/.-]+::[A-Za-z0-9_]+)", line
                )
                if failure:
                    backend_failures.append(failure.group(1))
                    print(f"Backend test failed: {failure.group(1)}")
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict) and set(record) == {"test", "status"}:
                    browser_results.append(record)
            summary_path.parent.mkdir(parents=True, exist_ok=True)
            summary_path.write_text(
                json.dumps(
                    {
                        "result": "passed" if result == 0 else "failed",
                        "stage": stage,
                        "browser_tests": browser_results,
                        "backend_failures": backend_failures,
                        "backend_counts": backend_counts,
                        "resource_observations": resource_observations,
                        "admission_observations": admission,
                        "checker_exit": checker_exit,
                    },
                    indent=2,
                )
            )
        finally:
            # Reporting failure must never bypass deletion of credentials/raw logs.
            log.close()
            shutil.rmtree(private)
    if result == 0:
        print("Full-stack PASS: production browser/Auth/BFF/API/PostgreSQL acceptance.")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
