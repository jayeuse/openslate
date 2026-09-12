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

if __package__:
    from .backend_batches import parse_batch, run_backend_batches
    from .backend_coverage import run_backend_coverage
    from .scanner_runtime import DisposableScanner
else:
    from backend_batches import parse_batch, run_backend_batches
    from backend_coverage import run_backend_coverage
    from scanner_runtime import DisposableScanner

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
API = "http://127.0.0.1:8008"
AUTH = "http://127.0.0.1:55321"
WEB = "http://localhost:3008"
_DISPOSABLE_VALUES = {
    "SUPABASE_API_PORT": "55321",
    "SUPABASE_DB_PORT": "55322",
    "SUPABASE_SHADOW_PORT": "55320",
    "SUPABASE_STUDIO_PORT": "55323",
    "SUPABASE_MAIL_PORT": "55324",
    "SUPABASE_POOLER_PORT": "55329",
    "SUPABASE_URL": AUTH,
    "FRONTEND_URL": WEB,
    "SUPABASE_AUTH_REDIRECT_URL": WEB + "/auth/callback",
    "AUTH_SETUP_URL": WEB + "/auth/setup",
}
_PORT_REFERENCES = tuple(name for name in _DISPOSABLE_VALUES if name.endswith("_PORT"))


def rewrite_disposable_config(source, run_id):
    values = {"SUPABASE_PROJECT_ID": f"p5-{run_id}", **_DISPOSABLE_VALUES}
    missing = [name for name in values if f"env({name})" not in source]
    if missing:
        raise RuntimeError("disposable configuration is missing required references")
    for name, value in values.items():
        source = source.replace(f"env({name})", value)
    for name in _PORT_REFERENCES:
        source = source.replace(f'"{values[name]}"', values[name])
    return source.replace("jwt_expiry = 3600", "jwt_expiry = 60")


def measure_admission():
    """Exercise a bounded local burst and recovery; this is not a capacity target."""
    held = []
    try:
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


def main(arguments=()):
    arguments = tuple(arguments)
    batch = parse_batch(arguments, BACKEND)
    if not batch and arguments not in (
        (), ("--scanner-only",), ("--backend-coverage-only",), ("--acceptance-only",)
    ):
        raise SystemExit("Usage: fullstack_runner.py [mode]")
    backend_only = batch is not None or arguments == ("--backend-coverage-only",)
    scanner_only = arguments == ("--scanner-only",)
    acceptance_only = arguments == ("--acceptance-only",)
    if not scanner_only and batch is None and not acceptance_only:
        output = BACKEND / "test-results/coverage"
        if output.exists():
            shutil.rmtree(output)
    for port in (55321, 55322, 55323, 55324) + (() if backend_only else (8008, 3008)):
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", port))
            except OSError as error:
                print(f"Test port {port} unavailable: {error.strerror or 'cannot bind'}.")
                return 1
    run_id = uuid4().hex
    private = Path(tempfile.mkdtemp(prefix="openslate-p5-"))
    processes = []
    stage = "prepare"
    started = False
    result = 1
    admission, checker_exit, scanner = {}, None, None
    scanner_observations = {}
    failure_type = failure_message = None
    summary_path = (BACKEND / "test-results/batches/summary.json" if batch else
                    BACKEND / "test-results/coverage/summary.json" if backend_only
                    else FRONTEND / "test-results/fullstack-summary.json")
    base_env = {"PATH": os.environ["PATH"], "OPENSLATE_ENV_SOURCE": "process"}
    # Browser binaries remain in the installer's cache while runtime HOME is private.
    browser_cache = Path.home() / ("Library/Caches" if sys.platform == "darwin" else ".cache")
    if sys.platform == "linux":
        browser_cache = Path(os.environ.get("XDG_CACHE_HOME", browser_cache))
    base_env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ.get(
        "PLAYWRIGHT_BROWSERS_PATH", str(browser_cache / "ms-playwright")
    )
    (private / "home").mkdir(mode=0o700)
    base_env["HOME"] = str(private / "home")
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
        source = rewrite_disposable_config(config.read_text(), run_id)
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
        migration_env = {
            **base_env,
            "MIGRATION_DATABASE_URL": owner_url,
        }
        stage = "migrations"
        run([sys.executable, "-m", "alembic", "upgrade", "head"], BACKEND, migration_env)
        run([sys.executable, "-m", "alembic", "check"], BACKEND, migration_env)
        password = secrets.token_urlsafe(32)
        runtime_url = f"postgresql+psycopg://openslate_runtime:{password}@127.0.0.1:55322/postgres"
        stage = "runtime role"
        run(
            [sys.executable, "scripts/provision_database_role.py", "--confirm"],
            BACKEND,
            {**migration_env, "DATABASE_URL": runtime_url, "ENVIRONMENT": "test"},
        )
        api_env = {
            **base_env,
            "DATABASE_URL": runtime_url,
            "SUPABASE_URL": AUTH, "SUPABASE_PUBLISHABLE_KEY": publishable,
            "SUPABASE_SECRET_KEY": secret_key,
            "SUPABASE_AUTH_REDIRECT_URL": WEB + "/auth/callback",
            "SUPABASE_JWT_ISSUER": AUTH + "/auth/v1",
            "SUPABASE_JWKS_URL": AUTH + "/auth/v1/.well-known/jwks.json",
            "SUPABASE_JWT_AUDIENCE": "authenticated",
            "ENVIRONMENT": "test",
            "LIFECYCLE_PURGE_ENABLED": "false",
            "SECURITY_EVENT_SERVER_KEY": secrets.token_urlsafe(32),
            "CORS_ORIGINS": json.dumps([WEB]),
            "LOG_DIR": str(private / "api-logs"),
            "REQUEST_BODY_MAX_BYTES": "1048576",
            "DATABASE_POOL_SIZE": "5",
            "DATABASE_MAX_OVERFLOW": "5",
            "DATABASE_POOL_TIMEOUT_SECONDS": "5",
            "DATABASE_CONNECT_TIMEOUT_SECONDS": "3",
            "DATABASE_STATEMENT_TIMEOUT_MS": "15000",
            "READINESS_POOL_TIMEOUT_SECONDS": "0.25",
            "READINESS_CONNECT_TIMEOUT_SECONDS": "1",
            "READINESS_STATEMENT_TIMEOUT_MS": "500",
            "READINESS_CALLER_TIMEOUT_SECONDS": "2",
            "SUPABASE_TIMEOUT_SECONDS": "10",
            "BACKEND_BIND_HOST": "127.0.0.1", "BACKEND_PORT": "8008",
            "SERVER_MAX_CONCURRENCY": "32", "SERVER_KEEP_ALIVE_SECONDS": "5",
        }
        if not scanner_only and not acceptance_only:
            stage = "backend batch" if batch else "backend regression and coverage gate"
            execute = run_backend_batches if batch else run_backend_coverage
            result = execute(run, BACKEND, private, {
                **api_env, "MIGRATION_DATABASE_URL": owner_url,
                "TEST_DATABASE_URL": runtime_url, "OPENSLATE_FULLSTACK_RUN_ID": run_id,
                "E2E_ALLOW_MUTATIONS": "true",
            }, run_id, *([batch] if batch else []))
        if backend_only:
            result = result if batch else 0
        else:
            stage = "official scanner generation"
            scanner = DisposableScanner(ROOT, private, run_id, base_env, log)
            scanner_observations = scanner.observations
            scanner.start()
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
            processes.append(
                subprocess.Popen(
                    [
                        sys.executable, "-m", "uvicorn", "app.main:app",
                        "--host", "127.0.0.1", "--port", "8008",
                        "--no-access-log",
                        "--limit-concurrency", "32",
                    ],
                    cwd=BACKEND,
                    env=api_env,
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
            )
            wait_for(API + "/api/ready", processes[-1])
            stage = "automatic scan worker"
            scanner.start_worker(api_env)
            stage = "bounded admission and recovery"
            admission = measure_admission()
            frontend_env = {
                **base_env,
                "BACKEND_URL": API,
                "SUPABASE_SERVER_URL": AUTH,
                "LOG_DIR": str(private / "frontend-logs"),
                "BFF_REQUEST_BODY_LIMIT_BYTES": "1048576",
                "BFF_RESPONSE_BODY_LIMIT_BYTES": "8388608",
                "BFF_REQUEST_DEADLINE_MS": "60000",
                "NEXT_PUBLIC_SUPABASE_URL": AUTH,
                "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable,
                "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED": "false",
                "PORT": "3008",
                "HOSTNAME": "localhost",
            }
            stage = "production frontend build"
            run(["npm", "run", "build", "--", "--from-process", "--webpack"],
                FRONTEND, frontend_env)
            stage = "production frontend startup"
            processes.append(
                subprocess.Popen(
                    ["npm", "run", "start", "--", "--from-process"],
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
                [
                    "npx",
                    "playwright",
                    "test",
                    "--config=playwright.fullstack.config.ts",
                    *(["workspace-views-files.spec.ts"] if scanner_only else []),
                ],
                FRONTEND,
                test_env,
            )
            stage = "real worker crash recovery"
            if __package__:
                from .scanner_recovery import verify_worker_recovery
            else:
                from scanner_recovery import verify_worker_recovery
            verify_worker_recovery(scanner, api_env, identities["admin"])
            stage = "read-only operational checker"
            try:
                run([sys.executable, "scripts/check_operational_health.py"], BACKEND, api_env)
                checker_exit = 0
            except subprocess.CalledProcessError as error:
                checker_exit = error.returncode
                if checker_exit != 1:
                    raise
            result = 0
    except Exception as error:
        failure_type = type(error).__name__
        failure_message = str(error) if type(error) is RuntimeError else None
        print(f"Full-stack FAIL at {stage} ({failure_type}). See {summary_path}.")
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
            if scanner is not None:
                try:
                    scanner.stop()
                except Exception:
                    print("Disposable scanner cleanup failed; operator attention required.")
                    result = 1
            if started:
                try:
                    run(["supabase", "stop", "--no-backup"], private)
                except Exception:
                    print("Disposable stack cleanup failed; operator attention required.")
                    result = 1
            log.close()
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
                        "scope": ("backend-batch" if batch else
                                  "backend-coverage-only" if backend_only
                                  else "acceptance-only" if acceptance_only
                                  else "scanner-only" if scanner_only else "full"),
                        "backend_tests_rerun": not scanner_only and not acceptance_only,
                        "stage": stage,
                        "browser_tests": browser_results,
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
        finally:
            log.close()
            shutil.rmtree(private)
    if result == 0:
        print("Backend batch session PASS (no coverage gate)." if batch else
              "Backend coverage PASS." if backend_only else "Full-stack PASS.")
    return result


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
