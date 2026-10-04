"""Release smoke suite: Harbor Small through the seeder, then one browser path per screen.

Creates a new disposable stack, serves the static frontend export from FastAPI behind
the Caddy gateway, seeds Harbor Small once through the sample-data seeder, signs in
once per role and runs ``frontend/tests/fullstack/smoke``. It belongs to the release
gate (``scripts/prepush.py --release``), not to every push. Secrets and raw output stay
in a private temporary directory; OPENSLATE_TEST_PROGRESS=1 shows one line per finished
test, and OPENSLATE_E2E_HEADED=1 opens a visible browser. The summary holds only timings
and outcomes.

From backend/:  uv run python -m tests.smoke_runner
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

if __package__:
    from .caddy_runtime import GATEWAY_PORT, DisposableCaddy
    from .fullstack_environment import RUNNER_API_PORT, RUNNER_CONCURRENCY_LIMIT, api_environment
    from .fullstack_runner import API, BACKEND, FRONTEND, WEB, seed, wait_for
    from .postgres_runtime import DisposablePostgres
    from .runner_console import (
        e2e_browser_flags,
        playwright_results,
        run_streamed,
        stop_on_signals,
        stop_process_group,
    )
else:
    from caddy_runtime import GATEWAY_PORT, DisposableCaddy
    from fullstack_environment import RUNNER_API_PORT, RUNNER_CONCURRENCY_LIMIT, api_environment
    from fullstack_runner import API, BACKEND, FRONTEND, WEB, seed, wait_for
    from postgres_runtime import DisposablePostgres
    from runner_console import (
        e2e_browser_flags,
        playwright_results,
        run_streamed,
        stop_on_signals,
        stop_process_group,
    )

SEED = 42
ANCHOR_DATE = "2026-09-30"
ORGANIZATION = "harbor"
# One account per role the screens need: a department lead manages every department,
# a service clerk writes Service and reads the Sales and Field modules it links to.
SMOKE_ROLES = {
    "manager": "internal_sales_lead",
    "member": "internal_service_02",
    "guest": "guest_01",
}
SUMMARY = FRONTEND / "test-results/smoke-summary.json"
CADDY_ROOT_CERTIFICATE = "/data/caddy/pki/authorities/local/root.crt"


def smoke_identities(credentials: dict[str, object], admin: dict[str, str]) -> dict[str, object]:
    """Pick the signed-in roles from the seeded roster; refuse a missing or inactive one."""

    accounts = credentials.get("accounts")
    if not isinstance(accounts, list):
        raise RuntimeError("The seeded roster has no accounts")
    by_key = {account.get("key"): account for account in accounts if isinstance(account, dict)}
    identities: dict[str, object] = {
        "admin": {"email": admin["email"], "password": admin["password"]}
    }
    for role, key in SMOKE_ROLES.items():
        account = by_key.get(key)
        if not account or account.get("status") != "active" or not account.get("password"):
            raise RuntimeError(f"The seeded roster lacks an active {role} account")
        identities[role] = {
            "email": account["email"],
            "password": account["password"],
            "name": account.get("display_name") or account.get("username"),
        }
    return identities


def gateway_root_certificate(caddy: DisposableCaddy, private: Path) -> Path:
    """Write the gateway's local certificate authority so Python clients can trust it."""

    target = private / "gateway-root.crt"
    if caddy.native_binary is not None:
        found = sorted((private / "home").rglob("pki/authorities/local/root.crt"))
        if not found:
            raise RuntimeError("The gateway certificate authority is unavailable")
        shutil.copyfile(found[0], target)
    else:
        certificate = subprocess.run(
            ["docker", "exec", caddy.container, "cat", CADDY_ROOT_CERTIFICATE],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout
        target.write_text(certificate, encoding="utf-8")
    target.chmod(0o600)
    return target


def _write_private(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)
    return path


def main() -> int:
    for port in (int(RUNNER_API_PORT), GATEWAY_PORT):
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", port))
            except OSError as error:
                print(f"Test port {port} unavailable: {error.strerror or 'cannot bind'}.")
                return 1
    stop_on_signals()
    run_id = uuid4().hex
    private = Path(tempfile.mkdtemp(prefix="openslate-smoke-"))
    base_env = {"PATH": os.environ["PATH"], "OPENSLATE_ENV_SOURCE": "process"}
    browser_cache = Path.home() / ("Library/Caches" if sys.platform == "darwin" else ".cache")
    if sys.platform == "linux":
        browser_cache = Path(os.environ.get("XDG_CACHE_HOME", browser_cache))
    base_env["PLAYWRIGHT_BROWSERS_PATH"] = os.environ.get(
        "PLAYWRIGHT_BROWSERS_PATH", str(browser_cache / "ms-playwright")
    )
    for name in ("home", "tmp", "smoke-state", "sample-runs"):
        (private / name).mkdir(mode=0o700)
    base_env["HOME"] = str(private / "home")
    base_env["TMPDIR"] = str(private / "tmp")
    log = (private / "process.log").open("w")
    stages: dict[str, float] = {}
    stage, result, failure_type = "prepare", 1, None
    postgres = caddy = None
    processes: list[subprocess.Popen[str]] = []
    started = time.monotonic()

    browser_lines: list[str] = []
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=BACKEND, capture_output=True, text=True, check=False
    ).stdout.strip()

    def run(
        command: list[str], cwd: Path, env: dict[str, str], shown: list[str] | None = None
    ) -> None:
        print(f"Smoke: {stage}", flush=True)
        run_streamed(command, cwd, env, log, shown=shown)

    def timed(name: str) -> None:
        nonlocal stage, started
        now = time.monotonic()
        stages[stage] = round(now - started, 1)
        stage, started = name, now

    try:
        timed("PostgreSQL startup")
        postgres = DisposablePostgres(private, run_id, base_env, log)
        postgres.start()
        database_env = postgres.urls()
        provider_env = postgres.provider_environment()
        manifest = postgres.write_manifest()
        owner_url = database_env["MIGRATION_DATABASE_URL"]
        migration_env = {
            **base_env,
            **database_env,
            **provider_env,
            "ENVIRONMENT": "test",
            "E2E_ALLOW_MUTATIONS": "true",
            "OPENSLATE_FULLSTACK_RUN_ID": run_id,
            "OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest),
        }
        timed("schema and Storage")
        provision = [sys.executable, "operations/provision_database_role.py", "--confirm"]
        run(provision, BACKEND, migration_env)
        run([sys.executable, "-m", "alembic", "upgrade", "head"], BACKEND, migration_env)
        # The seeder's controls purge records and Boards, so purge is on for this stack.
        api_env = api_environment(
            base_env,
            database_env,
            provider_env,
            run_id=run_id,
            database_manifest=manifest,
            private=private,
            public_origin=WEB,
            purge_enabled=True,
        )
        # Automations and scheduled work run here as they do in production; the seeder
        # waits for record-created automation results.
        api_env["E2E_BACKGROUND_WORKERS"] = "true"
        run([sys.executable, "operations/provision_storage.py", "--confirm"], BACKEND, api_env)
        admin = seed(owner_url, run_id, migration_env, roles=("admin",))["admin"]
        timed("static frontend build")
        run(["npm", "run", "build", "--", "--webpack"], FRONTEND, base_env)
        api_env["WEB_ASSETS_ROOT"] = str(FRONTEND / "out")
        timed("FastAPI and gateway startup")

        def start_api(environment: dict[str, str]) -> None:
            processes.append(
                subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                     "--port", RUNNER_API_PORT, "--no-access-log",
                     "--limit-concurrency", str(RUNNER_CONCURRENCY_LIMIT)],
                    cwd=BACKEND, env=environment, stdout=log, stderr=log, text=True,
                    start_new_session=True,
                )
            )  # fmt: skip
            wait_for(API + "/api/ready", processes[-1])

        # The seeder completes every invitation from one address, more than the anonymous
        # limit allows, so the API seeds with that limit off and restarts strict afterwards.
        start_api({**api_env, "E2E_SEEDING_WITHOUT_ANONYMOUS_LIMITS": "true"})
        caddy = DisposableCaddy(private, run_id, base_env, log)
        caddy.start()
        wait_for(WEB + "/login", caddy, verify=False)
        certificate = gateway_root_certificate(caddy, private)
        timed("Harbor Small seeding")
        parameters = _write_private(
            private / "seed-parameters.json",
            {
                "api_url": WEB,
                "origin": WEB,
                "mailpit_url": postgres.mail_url,
                "admin_email": admin["email"],
                "admin_id": admin["id"],
                "admin_password": admin["password"],
                "run_root": str(private / "sample-runs"),
                "seed": SEED,
                "anchor_date": ANCHOR_DATE,
                "organization": ORGANIZATION,
            },
        )
        run(
            [sys.executable, "-m", "tests.smoke_seed", str(parameters)],
            BACKEND,
            {**api_env, "SSL_CERT_FILE": str(certificate)},
        )
        sample_run = next((private / "sample-runs").iterdir())
        credentials = json.loads((sample_run / "credentials.json").read_text(encoding="utf-8"))
        fixture = _write_private(
            private / "smoke-fixture.json",
            {"runId": run_id, "baseURL": WEB, "roles": smoke_identities(credentials, admin)},
        )
        stop_process_group(processes.pop())
        start_api(api_env)
        timed("browser smoke suite")
        run(
            [
                "npx",
                "playwright",
                "test",
                "--config=playwright.fullstack.config.ts",
                *e2e_browser_flags(),
            ],
            FRONTEND,
            {
                **base_env,
                "BASE_URL": WEB,
                "OPENSLATE_FULLSTACK_SUITE": "smoke",
                "OPENSLATE_FULLSTACK_FIXTURE": str(fixture),
                "OPENSLATE_FULLSTACK_RUN_ID": run_id,
                "OPENSLATE_SMOKE_STATE_DIR": str(private / "smoke-state"),
                "E2E_ALLOW_MUTATIONS": "true",
                "PLAYWRIGHT_NO_COPY_PROMPT": "1",
            },
            browser_lines,
        )
        timed("complete")
        result = 0
    except Exception as error:
        failure_type = type(error).__name__
        timed(stage)
        print(f"Smoke FAIL at {stage} ({failure_type}).")
    finally:
        for process in reversed(processes):
            try:
                stop_process_group(process)
            except Exception:
                # The gateway and the stack below must still be removed.
                print("Smoke process cleanup failed; operator attention required.")
                result = 1
        for owned in (caddy, postgres):
            if owned is not None:
                try:
                    owned.stop()
                except Exception:
                    print("Disposable smoke cleanup failed; operator attention required.")
                    result = 1
        log.close()
        SUMMARY.parent.mkdir(parents=True, exist_ok=True)
        SUMMARY.write_text(
            json.dumps(
                {
                    "result": "passed" if result == 0 else "failed",
                    "stage": stage,
                    "failure_type": failure_type,
                    "stage_seconds": stages,
                    # Sanitized evidence that outlives the private run directory.
                    "revision": revision,
                    "command": "uv run python -m tests.smoke_runner (from backend/)",
                    "tests": playwright_results(browser_lines),
                    "artifacts": {
                        "playwright_output": "frontend/test-results/smoke",
                        "private_diagnostics": None if result == 0 else str(private),
                    },
                    "seed": {
                        "organization": ORGANIZATION,
                        "profile": "small",
                        "seed": SEED,
                        "anchor_date": ANCHOR_DATE,
                    },
                },  # fmt: skip
                indent=2,
            ),
            encoding="utf-8",
        )
        if result == 0:
            shutil.rmtree(private)
        else:
            print(f"Private failure diagnostics retained at {private}")
    print(f"Smoke {'PASS' if result == 0 else 'FAIL'}; stage seconds: {stages}")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
