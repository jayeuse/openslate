"""Run the release smoke suite against a newly created, disposable PostgreSQL stack.

No existing stack, database, identity or personal environment is reused. All
secrets and raw process output stay in a private temporary directory.
"""

import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import httpx
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.core.config.instance import assert_instance_target, instance_target_for_process
from app.core.database import model_registry  # noqa: F401

if __package__:
    from .backend_batches import parse_batch, run_backend_batches
    from .backend_coverage import run_backend_coverage
    from .caddy_runtime import CADDY_IMAGE, GATEWAY_PORT, DisposableCaddy, render_gateway_config
    from .fullstack_summary import summary_path, write_fullstack_summary
    from .postgres_runtime import DisposablePostgres
    from .scanner_runtime import DisposableScanner
else:
    from backend_batches import parse_batch, run_backend_batches
    from backend_coverage import run_backend_coverage
    from caddy_runtime import CADDY_IMAGE, GATEWAY_PORT, DisposableCaddy, render_gateway_config
    from fullstack_summary import summary_path, write_fullstack_summary
    from postgres_runtime import DisposablePostgres
    from scanner_runtime import DisposableScanner

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
API = "http://127.0.0.1:8008"
WEB = f"https://localhost:{GATEWAY_PORT}"
RUNNER_CONCURRENCY_LIMIT = 64

__all__ = (
    "CADDY_IMAGE",
    "DisposableCaddy",
    "GATEWAY_PORT",
    "render_gateway_config",
    "runtime_database_environment",
)


def runtime_database_environment(database_env: dict[str, str]) -> dict[str, str]:
    """Pass only the runtime login to FastAPI and its worker processes."""

    return {"DATABASE_URL": database_env["DATABASE_URL"]}


def browser_acceptance_command() -> list[str]:
    """Run the one owned full-stack suite for normal and scanner-only acceptance."""
    return [
        "npx",
        "playwright",
        "test",
        "--config=playwright.fullstack.config.ts",
    ]


def prepare_private_file_storage(private: Path) -> Path:
    """Create the scanner-visible private root before FastAPI and its worker start."""
    storage_root = private / "private-files"
    storage_root.mkdir(mode=0o700)
    return storage_root


def measure_admission():
    """Exercise a bounded local burst and recovery; this is not a capacity target."""
    held = []
    try:
        for _ in range(RUNNER_CONCURRENCY_LIMIT):
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


def wait_for(url, process, *, verify: bool = True):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("application process exited")
        try:
            if httpx.get(url, timeout=2, verify=verify).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    raise RuntimeError("application startup deadline exceeded")


def seed(owner_url, run_id, database_environment):
    """Owner-only fixture setup, guarded by a brand-new empty application DB."""
    from app.systems.access.identity.service import create_credential
    from app.systems.access.users.models import Role, User, UserStatus

    target = instance_target_for_process(owner_url, "openslate_owner", database_environment)
    engine = create_engine(owner_url)
    identities = {}
    try:
        with Session(engine) as db:
            if target is None:
                raise RuntimeError("Disposable seed target identity is unavailable")
            assert_instance_target(db.connection(), target, expected_user="openslate_owner")
            if db.scalar(text("SELECT count(*) FROM public.users")) != 0:
                raise RuntimeError("refusing to seed a nonempty database")
            for role in ("admin", "member"):
                email = f"p5-{run_id}-{role}@example.com"
                password = f"P5-{secrets.token_urlsafe(24)}!9"
                role_row = db.scalar(select(Role).where(Role.role == role))
                if role_row is None:
                    raise RuntimeError("baseline role seeds are unavailable")
                user = User(
                    email=email,
                    username=f"p5-{role}",
                    status=UserStatus.ACTIVE.value,
                    role_id=role_row.id,
                )
                db.add(user)
                db.flush()
                create_credential(db, user.id, password)
                identities[role] = {"email": email, "password": password, "id": str(user.id)}
            db.commit()
    finally:
        engine.dispose()
    return identities


def main(arguments=()):
    arguments = tuple(arguments)
    batch = parse_batch(arguments, BACKEND)
    if not batch and arguments not in (
        (),
        ("--scanner-only",),
        ("--backend-coverage-only",),
        ("--acceptance-only",),
    ):
        raise SystemExit("Usage: fullstack_runner.py [mode]")
    backend_only = batch is not None or arguments == ("--backend-coverage-only",)
    scanner_only = arguments == ("--scanner-only",)
    acceptance_only = arguments == ("--acceptance-only",)
    if not scanner_only and batch is None and not acceptance_only:
        output = BACKEND / "test-results/coverage"
        if output.exists():
            shutil.rmtree(output)
    for port in () if backend_only else (8008, GATEWAY_PORT):
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
    result = 1
    admission, checker_exit, scanner, postgres, caddy = {}, None, None, None, None
    scanner_observations = {}
    browser_completed = False
    failure_type = failure_message = None
    result_path = summary_path(BACKEND, FRONTEND, batch=batch, backend_only=backend_only)
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
    private_files = prepare_private_file_storage(private)
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
        stage = "PostgreSQL startup"
        postgres = DisposablePostgres(private, run_id, base_env, log)
        postgres.start()
        database_env = postgres.urls()
        database_manifest = postgres.write_manifest()
        owner_url = database_env["MIGRATION_DATABASE_URL"]
        migration_env = {
            **base_env,
            **database_env,
            "ENVIRONMENT": "test",
            "E2E_ALLOW_MUTATIONS": "true",
            "OPENSLATE_FULLSTACK_RUN_ID": run_id,
            "OPENSLATE_TEST_DATABASE_MANIFEST": str(database_manifest),
        }
        if instance_target_for_process(owner_url, "openslate_owner", migration_env) is None:
            raise RuntimeError("Disposable PostgreSQL target identity is unavailable")
        stage = "database role bootstrap"
        run(
            [sys.executable, "operations/provision_database_role.py", "--confirm"],
            BACKEND,
            migration_env,
        )
        stage = "migrations"
        run([sys.executable, "-m", "alembic", "upgrade", "head"], BACKEND, migration_env)
        run([sys.executable, "-m", "alembic", "check"], BACKEND, migration_env)
        api_env = {
            **base_env,
            **runtime_database_environment(database_env),
            "ENVIRONMENT": "test",
            "E2E_ALLOW_MUTATIONS": "true",
            "OPENSLATE_FULLSTACK_RUN_ID": run_id,
            "OPENSLATE_TEST_DATABASE_MANIFEST": str(database_manifest),
            "AUTH_JWT_SECRET": secrets.token_urlsafe(48),
            "AUTH_JWT_ISSUER": "http://openslate.test",
            "AUTH_JWT_AUDIENCE": "openslate-api",
            "AUTH_ACCESS_TOKEN_MINUTES": "15",
            "AUTH_REFRESH_TOKEN_DAYS": "7",
            "LIFECYCLE_PURGE_ENABLED": "false",
            "SECURITY_EVENT_SERVER_KEY": secrets.token_urlsafe(32),
            "PUBLIC_ORIGIN": WEB,
            "LOG_DIR": str(private / "api-logs"),
            "FILES_STORAGE_ROOT": str(private_files),
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
            "BACKEND_BIND_HOST": "127.0.0.1",
            "BACKEND_PORT": "8008",
            "SERVER_MAX_CONCURRENCY": str(RUNNER_CONCURRENCY_LIMIT),
            "SERVER_KEEP_ALIVE_SECONDS": "5",
        }
        if not scanner_only and not acceptance_only:
            stage = "backend batch" if batch else "backend regression and coverage gate"
            execute = run_backend_batches if batch else run_backend_coverage
            result = execute(
                run,
                BACKEND,
                private,
                {
                    **api_env,
                    "MIGRATION_DATABASE_URL": owner_url,
                    "TEST_DATABASE_URL": database_env["DATABASE_URL"],
                    "TEST_INSPECTOR_DATABASE_URL": database_env["DATABASE_INSPECTOR_URL"],
                },
                run_id,
                *([batch] if batch else []),
            )
        if backend_only:
            result = result if batch else 0
        else:
            stage = "official scanner generation"
            scanner = DisposableScanner(ROOT, private, run_id, base_env, log)
            scanner_observations = scanner.observations
            scanner.start()
            stage = "dedicated identities"
            identities = seed(owner_url, run_id, migration_env)
            fixture = private / "fixture.json"
            fixture.write_text(
                json.dumps(
                    {
                        "runId": run_id,
                        "baseURL": WEB,
                        **identities,
                    }
                )
            )
            fixture.chmod(0o600)
            stage = "static frontend build"
            run(["npm", "run", "build", "--", "--webpack"], FRONTEND)
            api_env["WEB_ASSETS_ROOT"] = str(FRONTEND / "out")
            stage = "FastAPI startup"
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
                        str(RUNNER_CONCURRENCY_LIMIT),
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
            scanner.start_worker(api_env, postgres.network)
            stage = "bounded admission and recovery"
            admission = measure_admission()
            stage = "Caddy gateway startup"
            caddy = DisposableCaddy(private, run_id, base_env, log)
            caddy.start()
            wait_for(WEB + "/login", caddy, verify=False)
            stage = "browser acceptance"
            test_env = {
                **base_env,
                "BASE_URL": WEB,
                "OPENSLATE_FULLSTACK_FIXTURE": str(fixture),
                "OPENSLATE_FULLSTACK_RUN_ID": run_id,
                "E2E_ALLOW_MUTATIONS": "true",
                "PLAYWRIGHT_NO_COPY_PROMPT": "1",
            }
            run(browser_acceptance_command(), FRONTEND, test_env)
            browser_completed = True
            stage = "real worker crash recovery"
            if __package__:
                from .scanner_recovery import verify_worker_recovery
            else:
                from scanner_recovery import verify_worker_recovery
            verify_worker_recovery(scanner, api_env, identities["admin"])
            stage = "read-only operational checker"
            try:
                run([sys.executable, "operations/check_operational_health.py"], BACKEND, api_env)
                checker_exit = 0
            except subprocess.CalledProcessError as error:
                checker_exit = error.returncode
                if checker_exit != 1:
                    raise
            result = 0
    except Exception as error:
        failure_type = type(error).__name__
        failure_message = str(error) if type(error) is RuntimeError else None
        print(f"Full-stack FAIL at {stage} ({failure_type}). See {result_path}.")
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
            if postgres is not None:
                try:
                    postgres.stop()
                except Exception:
                    print("Disposable PostgreSQL cleanup failed; operator attention required.")
                    result = 1
            if caddy is not None:
                try:
                    caddy.stop()
                except Exception:
                    print("Disposable Caddy cleanup failed; operator attention required.")
                    result = 1
            log.close()
            write_fullstack_summary(
                result_path,
                private,
                result=result,
                batch=batch,
                backend_only=backend_only,
                acceptance_only=acceptance_only,
                scanner_only=scanner_only,
                stage=stage,
                browser_completed=browser_completed,
                admission=admission,
                checker_exit=checker_exit,
                scanner_observations=scanner_observations,
                failure_type=failure_type,
                failure_message=failure_message,
            )
        finally:
            log.close()
            shutil.rmtree(private)
    if result == 0:
        print(
            "Backend batch session PASS (no coverage gate)."
            if batch
            else "Backend coverage PASS."
            if backend_only
            else "Full-stack PASS."
        )
    return result


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
