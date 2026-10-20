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
from uuid import UUID, uuid4

import httpx
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.core.config.instance import assert_instance_target, instance_target_for_process
from app.core.config.provider_instance import assert_provider_instance
from app.core.database import model_registry  # noqa: F401

if __package__:
    from .backend_batches import parse_batch, run_backend_batches
    from .backend_coverage import coverage_output, parse_shard, run_backend_coverage
    from .caddy_runtime import CADDY_IMAGE, GATEWAY_PORT, DisposableCaddy, render_gateway_config
    from .fullstack_environment import (
        RUNNER_CONCURRENCY_LIMIT,
        api_environment,
        runtime_database_environment,
    )
    from .fullstack_summary import summary_path, write_fullstack_summary
    from .postgres_runtime import DisposablePostgres
    from .runner_console import e2e_browser_flags, run_streamed, stop_on_signals
else:
    from backend_batches import parse_batch, run_backend_batches
    from backend_coverage import coverage_output, parse_shard, run_backend_coverage
    from caddy_runtime import CADDY_IMAGE, GATEWAY_PORT, DisposableCaddy, render_gateway_config
    from fullstack_environment import (
        RUNNER_CONCURRENCY_LIMIT,
        api_environment,
        runtime_database_environment,
    )
    from fullstack_summary import summary_path, write_fullstack_summary
    from postgres_runtime import DisposablePostgres
    from runner_console import e2e_browser_flags, run_streamed, stop_on_signals

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
API = "http://127.0.0.1:8008"
WEB = f"https://localhost:{GATEWAY_PORT}"

__all__ = (
    "CADDY_IMAGE",
    "DisposableCaddy",
    "GATEWAY_PORT",
    "render_gateway_config",
    "runtime_database_environment",
)


def browser_acceptance_command(*, browser_only: bool = False) -> list[str]:
    """Keep the auth-only repair run separate from complete browser acceptance."""
    command = [
        "npx",
        "playwright",
        "test",
        "--config=playwright.fullstack.config.ts",
        *e2e_browser_flags(),
    ]
    if browser_only:
        command.append("tests/fullstack/auth-session.spec.ts")
    return command


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


def seed(owner_url, run_id, database_environment, roles=("admin", "member")):
    """Owner-only fixture setup, guarded by a brand-new empty application DB."""
    from app.systems.access.users.models import UserStatus
    from tests.conftest import create_member, create_organization

    target = instance_target_for_process(owner_url, "openslate_owner", database_environment)
    assert_provider_instance(
        database_environment, database_url=owner_url, expected_user="openslate_owner"
    )
    engine = create_engine(owner_url)
    identities = {}
    try:
        with Session(engine) as db:
            if target is None:
                raise RuntimeError("Disposable seed target identity is unavailable")
            assert_instance_target(db.connection(), target, expected_user="openslate_owner")
            if db.scalar(text("SELECT count(*) FROM public.users")) != 0:
                raise RuntimeError("refusing to seed a nonempty database")
            organization = create_organization(db)
            for role in roles:
                email = f"p5-{run_id}-{role}@example.com"
                password = f"P5-{secrets.token_urlsafe(24)}!9"
                user, _membership = create_member(
                    db,
                    organization,
                    email=email,
                    username=f"p5-{role}",
                    status=UserStatus.ACTIVE.value,
                    role=role,
                )
                db.add(user)
                db.flush()
                with httpx.Client(timeout=10, follow_redirects=False) as provider:
                    response = provider.post(
                        database_environment["SUPABASE_URL"] + "/auth/v1/admin/users",
                        headers={"apikey": database_environment["SUPABASE_SECRET_KEY"]},
                        json={"email": email, "password": password, "email_confirm": True},
                    )
                if response.status_code not in {200, 201}:
                    raise RuntimeError("Disposable Auth user provisioning failed")
                user.supabase_user_id = UUID(response.json()["id"])
                identities[role] = {"email": email, "password": password, "id": str(user.id)}
            db.commit()
    finally:
        engine.dispose()
    return identities


def main(arguments=()):
    # First: a stop at any later point, including the output cleanup, runs the cleanup.
    stop_on_signals()
    arguments = tuple(arguments)
    batch = parse_batch(arguments, BACKEND)
    reset_only = arguments == ("--reset-acceptance-only",)
    realtime_only = arguments == ("--realtime-foundation-only",)
    comms_native = arguments in (
        ("--comms-realtime-only",),
        ("--comms-capacity-only",),
        ("--comms-notifications-only",),
        ("--comms-moderation-only",),
        ("--comms-jobs-only",),
        ("--comms-candidates-only",),
        ("--comms-configuration-only",),
    )
    if comms_native:
        target = "comms_capacity.py" if arguments == ("--comms-capacity-only",) else "comms_live.py"
        if arguments == ("--comms-notifications-only",):
            target = "comms_notifications_live.py"
        if arguments == ("--comms-moderation-only",):
            target = "comms_moderation_live.py"
        if arguments == ("--comms-jobs-only",):
            target = "comms_jobs_live.py"
        if arguments == ("--comms-candidates-only",):
            target = "comms_candidates_live.py"
        if arguments == ("--comms-configuration-only",):
            target = "comms_configuration_live.py"
        batch = {
            "targets": [f"tests/realtime/{target}"],
            "layer": "integration",
            "interactive": False,
        }
    if realtime_only:
        batch = {
            "targets": [
                "tests/realtime/test_realtime_channel_acceptance.py",
                "tests/realtime/test_comms_foundation_live.py",
            ],
            "layer": "integration",
            "interactive": False,
        }
    if reset_only:
        batch = {
            "targets": ["tests/reset_application_data/provider_reset_acceptance.py"],
            "layer": "integration",
            "interactive": False,
        }
    shard = None
    if len(arguments) == 2 and arguments[0] == "--backend-coverage-shard":
        shard = parse_shard(arguments[1])
    elif not batch and arguments not in (
        (),
        ("--backend-coverage-only",),
        ("--acceptance-only",),
        ("--browser-only",),
    ):
        raise SystemExit("Usage: fullstack_runner.py [mode]")
    backend_only = (
        batch is not None or shard is not None or arguments == ("--backend-coverage-only",)
    )
    acceptance_only = arguments == ("--acceptance-only",)
    browser_only = arguments == ("--browser-only",)
    if batch is None and not acceptance_only and not browser_only:
        output = coverage_output(BACKEND)
        if output.exists():
            shutil.rmtree(output)
    for port in (
        (8008, GATEWAY_PORT)
        if comms_native
        else (GATEWAY_PORT,)
        if realtime_only
        else ()
        if backend_only
        else (8008, GATEWAY_PORT)
    ):
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
    stage_seconds: dict[str, float] = {}
    started = time.monotonic()
    result = 1
    admission, checker_exit, postgres, caddy = {}, None, None, None
    browser_completed = False
    browser_lines: list[str] = []
    failure_type = failure_message = None
    result_path = summary_path(BACKEND, FRONTEND, batch=batch, backend_only=backend_only)
    base_env = {"PATH": os.environ["PATH"], "OPENSLATE_ENV_SOURCE": "process"}
    if reset_only:
        base_env["OPENSLATE_TEST_RESET_ACCEPTANCE"] = "1"
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

    def run(command, cwd, env=base_env, capture=False, shown=None):
        print(f"Full-stack: {stage}", flush=True)
        return run_streamed(command, cwd, env, log, capture=capture, shown=shown)

    def timed(name: str) -> None:
        nonlocal stage, started
        now = time.monotonic()
        stage_seconds[stage] = round(now - started, 3)
        stage, started = name, now

    try:
        timed("PostgreSQL startup")
        postgres = DisposablePostgres(
            private, run_id, base_env, log, template_port=None if backend_only else 8008
        )
        postgres.start()
        database_env = postgres.urls()
        provider_env = postgres.provider_environment()
        database_manifest = postgres.write_manifest()
        owner_url = database_env["MIGRATION_DATABASE_URL"]
        migration_env = {
            **base_env,
            **database_env,
            **provider_env,
            "ENVIRONMENT": "test",
            "E2E_ALLOW_MUTATIONS": "true",
            "OPENSLATE_FULLSTACK_RUN_ID": run_id,
            "OPENSLATE_TEST_DATABASE_MANIFEST": str(database_manifest),
        }
        if instance_target_for_process(owner_url, "openslate_owner", migration_env) is None:
            raise RuntimeError("Disposable PostgreSQL target identity is unavailable")
        timed("database role bootstrap")
        run(
            [sys.executable, "operations/provision_database_role.py", "--confirm"],
            BACKEND,
            migration_env,
        )
        timed("migrations")
        run([sys.executable, "-m", "alembic", "upgrade", "head"], BACKEND, migration_env)
        run([sys.executable, "-m", "alembic", "check"], BACKEND, migration_env)
        if realtime_only:
            timed("Realtime forward migration roundtrip")
            run(
                [sys.executable, "-m", "alembic", "downgrade", "8464b72e2cd5"],
                BACKEND,
                migration_env,
            )
            run([sys.executable, "-m", "alembic", "upgrade", "head"], BACKEND, migration_env)
            run([sys.executable, "-m", "alembic", "check"], BACKEND, migration_env)
            timed("Realtime managed-policy upgrade")
            run([sys.executable, "-m", "tests.realtime.provisioning_probe"], BACKEND, migration_env)
        api_env = api_environment(
            base_env,
            database_env,
            provider_env,
            run_id=run_id,
            database_manifest=database_manifest,
            private=private,
            public_origin=WEB,
        )
        timed("private Storage initialization")
        run(
            [sys.executable, "operations/provision_storage.py", "--confirm"],
            BACKEND,
            api_env,
        )
        gateway_host = (
            "127.0.0.1"
            if shutil.which("caddy") or sys.platform.startswith("linux")
            else "host.docker.internal"
        )
        gateway_env = {
            **base_env,
            "SUPABASE_PUBLISHABLE_KEY": provider_env["SUPABASE_PUBLISHABLE_KEY"],
            "OPENSLATE_REALTIME_UPSTREAM": (f"{gateway_host}:{postgres.api_port}"),
        }
        if realtime_only:
            timed("same-origin Realtime gateway")
            caddy = DisposableCaddy(private, run_id, gateway_env, log)
            caddy.start()
            api_env["OPENSLATE_TEST_REALTIME_GATEWAY"] = WEB
        if comms_native:
            timed("native Comms API and same-origin gateway")
            if arguments == ("--comms-jobs-only",):
                api_env["E2E_BACKGROUND_WORKERS"] = "true"
            api_env["OPENSLATE_COMMS_NATIVE_API"] = API
            api_env["OPENSLATE_COMMS_TELEMETRY"] = str(private / "comms-metrics.jsonl")
            processes.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        "tests.realtime.measured_api:app",
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
            caddy = DisposableCaddy(private, run_id, gateway_env, log)
            caddy.start()
            api_env["OPENSLATE_TEST_REALTIME_GATEWAY"] = WEB
        if not acceptance_only and not browser_only:
            timed("backend batch" if batch else "backend regression and coverage gate")
            execute = run_backend_batches if batch else run_backend_coverage
            result = execute(
                run,
                BACKEND,
                private,
                {
                    **api_env,
                    "MIGRATION_DATABASE_URL": owner_url,
                    "TEST_DATABASE_URL": database_env["DATABASE_URL"],
                    # Operator-only metric reads; never passed to the separately started API.
                    **(
                        {"DATABASE_BOOTSTRAP_URL": database_env["DATABASE_BOOTSTRAP_URL"]}
                        if arguments == ("--comms-capacity-only",)
                        else {}
                    ),
                },
                run_id,
                *([batch] if batch else [shard] if shard else []),
            )
        if backend_only:
            result = result if batch else 0
        else:
            timed("dedicated identities")
            identities = seed(owner_url, run_id, migration_env)
            fixture = private / "fixture.json"
            fixture.write_text(
                json.dumps(
                    {
                        "runId": run_id,
                        "baseURL": WEB,
                        "mailpitUrl": postgres.mail_url,
                        **identities,
                    }
                )
            )
            fixture.chmod(0o600)
            timed("static frontend build")
            run(["npm", "run", "build", "--", "--webpack"], FRONTEND)
            api_env["WEB_ASSETS_ROOT"] = str(FRONTEND / "out")
            timed("FastAPI startup")
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
            timed("bounded admission and recovery")
            admission = measure_admission()
            timed("Caddy gateway startup")
            caddy = DisposableCaddy(private, run_id, gateway_env, log)
            caddy.start()
            wait_for(WEB + "/login", caddy, verify=False)
            timed("browser acceptance")
            test_env = {
                **base_env,
                "BASE_URL": WEB,
                "OPENSLATE_FULLSTACK_FIXTURE": str(fixture),
                "OPENSLATE_FULLSTACK_RUN_ID": run_id,
                "E2E_ALLOW_MUTATIONS": "true",
                "PLAYWRIGHT_NO_COPY_PROMPT": "1",
            }
            run(
                browser_acceptance_command(browser_only=browser_only),
                FRONTEND,
                test_env,
                shown=browser_lines,
            )
            browser_completed = True
            if not browser_only:
                timed("read-only operational checker")
                try:
                    run(
                        [sys.executable, "operations/check_operational_health.py"], BACKEND, api_env
                    )
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
        stage_seconds[stage] = round(time.monotonic() - started, 3)
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
                stage=stage,
                stage_seconds=stage_seconds,
                browser_lines=browser_lines,
                browser_completed=browser_completed,
                browser_only=browser_only,
                admission=admission,
                checker_exit=checker_exit,
                failure_type=failure_type,
                failure_message=failure_message,
            )
        finally:
            log.close()
            if result == 0:
                shutil.rmtree(private)
            else:
                print(f"Private failure diagnostics retained at {private}")
    if result == 0:
        print(
            "Backend batch session PASS (no coverage gate)."
            if batch
            else f"Backend coverage shard {shard[0]}/{shard[1]} PASS (gate runs after combine)."
            if shard
            else "Backend coverage PASS."
            if backend_only
            else "Full-stack PASS."
        )
    return result


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
