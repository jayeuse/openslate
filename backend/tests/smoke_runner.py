"""Release smoke suite: Harbor Small through the seeder, then one browser path per screen.

Creates a new disposable stack, serves the static frontend export from FastAPI behind
the Caddy gateway, seeds Harbor Small once through the sample-data seeder, signs in
once per role and runs ``frontend/tests/fullstack/smoke``. It belongs to the release
gate (``scripts/prepush.py --release``), not to every push. Secrets and raw output stay
in a private temporary directory; OPENSLATE_TEST_PROGRESS=1 shows one line per finished
test, and OPENSLATE_E2E_HEADED=1 opens a visible browser. The summary holds only timings
and outcomes.

``--seed-only --packs harbor,school`` seeds each listed pack at Small, one after the
other in the same disposable stack, and skips the browser suite. Its summary,
``backend/test-results/sample-smoke-summary.json``, adds request timings for each pack.

From backend/:  uv run python -m tests.smoke_runner [--seed-only --packs harbor,school]
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

from operations.sample.packs import get_pack
from operations.sample.packs.registry import pack_keys

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
SEED_ONLY_SUMMARY = BACKEND / "test-results/sample-smoke-summary.json"
CADDY_ROOT_CERTIFICATE = "/data/caddy/pki/authorities/local/root.crt"


def parse_options(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tests.smoke_runner")
    parser.add_argument(
        "--seed-only",
        action="store_true",
        help="seed the listed packs at Small and skip the browser suite",
    )
    parser.add_argument("--packs", help="comma-separated pack keys (with --seed-only)")
    parser.add_argument(
        "--parallel",
        action="store_true",
        help="seed the listed packs at the same time; the first runs the installation controls",
    )
    options = parser.parse_args(list(argv))
    if options.parallel and not options.seed_only:
        parser.error("--parallel needs --seed-only")
    if options.packs is None:
        options.packs = (ORGANIZATION,)
        return options
    if not options.seed_only:
        parser.error("--packs needs --seed-only; the browser suite uses Harbor")
    packs = tuple(key.strip() for key in options.packs.split(",") if key.strip())
    if not packs or len(set(packs)) != len(packs) or not set(packs) <= set(pack_keys()):
        parser.error(f"--packs takes distinct keys from: {', '.join(pack_keys())}")
    options.packs = packs
    return options


def request_timings(journal: Path) -> dict[str, object]:
    """Counts and latencies by route template; no IDs, paths or bodies leave the journal."""

    started: dict[str, tuple[str, datetime]] = {}
    latencies: list[float] = []
    statuses: Counter[str] = Counter()
    by_route: defaultdict[str, list[float]] = defaultdict(list)
    with journal.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            event, attempt = row.get("event"), row.get("attempt_id")
            when = row.get("timestamp")
            if event not in {"request_started", "request_finished"} or not when:
                continue
            moment = datetime.fromisoformat(when.replace("Z", "+00:00"))
            if event == "request_started":
                started[attempt] = (f"{row.get('method')} {row.get('route_template')}", moment)
            elif attempt in started:
                route, begun = started.pop(attempt)
                milliseconds = (moment - begun).total_seconds() * 1000
                latencies.append(milliseconds)
                by_route[route].append(milliseconds)
                statuses[str(row.get("status_code"))] += 1
    latencies.sort()

    def percentile(share: float) -> int:
        return round(latencies[min(len(latencies) - 1, int(len(latencies) * share))])

    routes = sorted(by_route.items(), key=lambda item: -sum(item[1]))[:10]
    return {
        "requests": len(latencies),
        "statuses": dict(sorted(statuses.items())),
        "latency_ms": {"p50": percentile(0.5), "p90": percentile(0.9),
                       "p99": percentile(0.99), "max": round(latencies[-1])}
        if latencies else {},
        "slowest_routes": [
            {"route": route, "requests": len(values), "total_ms": round(sum(values)),
             "mean_ms": round(sum(values) / len(values))}
            for route, values in routes
        ],
    }  # fmt: skip


def register_installation_operator(owner_url: str, admin_id: str) -> None:
    """Make the seeded administrator the installation owner, as bootstrap_admin.py does."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool

    from app.core.database.session import AuditSession
    from app.systems.access.users.models import PlatformOperator

    engine = create_engine(owner_url, poolclass=NullPool)
    try:
        with AuditSession(engine) as db:
            db.add(PlatformOperator(user_id=UUID(admin_id)))
            db.commit()
    finally:
        engine.dispose()


def create_pack_organizations(owner_url: str, pack_key: str, admin_id: str) -> dict[str, str]:
    """The pack's own organization and partner, owned by the administrator, as the CLI does."""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool

    from app.core.database.session import AuditSession
    from operations.create_organization import provision
    from operations.sample.organization import sample_organization_name, sample_slug

    pack = get_pack(pack_key)
    engine = create_engine(owner_url, poolclass=NullPool)
    try:
        identities: dict[str, str] = {}
        for key, partner in (("organization_id", False), ("partner_organization_id", True)):
            with AuditSession(engine) as db:
                organization = provision(
                    db,
                    name=sample_organization_name(pack, partner=partner),
                    slug=sample_slug(pack_key, partner=partner),
                    admin_user_id=UUID(admin_id),
                )
                identities[key] = str(organization.id)
        return identities
    finally:
        engine.dispose()


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


# Passwords travel only in a child process's environment; the private files hold none.
SEED_PASSWORD_ENV = "OPENSLATE_SMOKE_ADMIN_PASSWORD"
FIXTURE_PASSWORDS_ENV = "OPENSLATE_SMOKE_PASSWORDS"


def split_passwords(
    identities: dict[str, object],
) -> tuple[dict[str, object], dict[str, str]]:
    """Return the roles without their passwords, and the passwords by role."""

    roles: dict[str, object] = {}
    passwords: dict[str, str] = {}
    for role, identity in identities.items():
        if not isinstance(identity, dict) or not isinstance(identity.get("password"), str):
            raise RuntimeError(f"The {role} identity has no password")
        passwords[role] = identity["password"]
        roles[role] = {key: value for key, value in identity.items() if key != "password"}
    return roles, passwords


def _write_private(path: Path, value: object) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)
    return path


def main(argv: Sequence[str] = ()) -> int:
    options = parse_options(argv)
    summary_path = SEED_ONLY_SUMMARY if options.seed_only else SUMMARY
    stop_on_signals()
    for port in (int(RUNNER_API_PORT), GATEWAY_PORT):
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", port))
            except OSError as error:
                print(f"Test port {port} unavailable: {error.strerror or 'cannot bind'}.")
                return 1
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
    pack_results: dict[str, dict[str, object]] = {}
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
        timed("PostgreSQL startup (overlaps frontend build)")
        build_command = ["npm", "run", "build", "--", "--webpack"]
        build = subprocess.Popen(
            build_command,
            cwd=FRONTEND,
            env=base_env,
            stdout=log,
            stderr=log,
            text=True,
            start_new_session=True,
        )
        processes.append(build)
        postgres = DisposablePostgres(private, run_id, base_env, log, template_port=8008)
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
        timed("schema and Storage (overlaps frontend build)")
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
        # Measure API worker processes (C8): the caller's API_WORKERS, else one process.
        api_env["API_WORKERS"] = os.environ.get("API_WORKERS", "1")
        run([sys.executable, "operations/provision_storage.py", "--confirm"], BACKEND, api_env)
        admin = seed(owner_url, run_id, migration_env, roles=("admin",))["admin"]
        register_installation_operator(owner_url, admin["id"])
        timed("remaining static frontend build wait")
        build_returncode = build.wait()
        if build_returncode:
            raise subprocess.CalledProcessError(build_returncode, build_command)
        api_env["WEB_ASSETS_ROOT"] = str(FRONTEND / "out")
        timed("FastAPI and gateway startup")

        def start_api(environment: dict[str, str]) -> None:
            processes.append(
                subprocess.Popen(
                    [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                     "--port", RUNNER_API_PORT, "--no-access-log",
                     "--limit-concurrency", str(RUNNER_CONCURRENCY_LIMIT),
                     "--workers", environment["API_WORKERS"]],
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
        env = {**api_env, "SSL_CERT_FILE": str(certificate)}

        def prepare(pack: str, installation_controls: bool) -> Path:
            pack_results[pack] = {"status": "failed"}
            parameters = _write_private(
                private / f"seed-parameters-{pack}.json",
                {
                    "api_url": WEB,
                    "origin": WEB,
                    "mailpit_url": postgres.mail_url,
                    "admin_email": admin["email"],
                    "admin_id": admin["id"],
                    "run_root": str(private / "sample-runs" / pack),
                    "seed": SEED,
                    "anchor_date": ANCHOR_DATE,
                    "organization": pack,
                    "installation_controls": installation_controls,
                    **create_pack_organizations(owner_url, pack, admin["id"]),
                },
            )
            (private / "sample-runs" / pack).mkdir(mode=0o700)
            return parameters

        def seed_pack(pack: str, parameters: Path) -> None:
            seeding_started = time.monotonic()
            # The password reaches the seeder through its environment, never a file.
            seed_env = {**env, SEED_PASSWORD_ENV: admin["password"]}
            run_streamed([sys.executable, "-m", "tests.smoke_seed", str(parameters)],
                         BACKEND, seed_env, log)  # fmt: skip
            sample_run = next((private / "sample-runs" / pack).iterdir())
            pack_results[pack] = {
                "status": "complete",
                "seconds": round(time.monotonic() - seeding_started, 1),
                "installation_controls": pack == options.packs[0] or not options.parallel,
                **request_timings(sample_run / "requests.jsonl"),
            }

        if options.parallel:
            # Packs share one installation; only the first runs the installation controls.
            timed(f"Parallel Small seeding ({', '.join(options.packs)})")
            print(f"Smoke: {stage}", flush=True)
            prepared = {pack: prepare(pack, pack == options.packs[0]) for pack in options.packs}
            with ThreadPoolExecutor(max_workers=len(options.packs)) as pool:
                futures = [pool.submit(seed_pack, pack, path) for pack, path in prepared.items()]
                errors = [future.exception() for future in futures]
            failed = next((error for error in errors if error is not None), None)
            if failed is not None:
                raise failed
        else:
            for pack in options.packs:
                timed(f"{pack.title()} Small seeding")
                print(f"Smoke: {stage}", flush=True)
                seed_pack(pack, prepare(pack, True))
        sample_run = next((private / "sample-runs" / options.packs[-1]).iterdir())
        if not options.seed_only:
            credentials = json.loads((sample_run / "credentials.json").read_text(encoding="utf-8"))
            roles, passwords = split_passwords(smoke_identities(credentials, admin))
            fixture = _write_private(
                private / "smoke-fixture.json",
                {
                    "runId": run_id,
                    "baseURL": WEB,
                    "workspaceName": get_pack(ORGANIZATION).identity.workspace_name,
                    "roles": roles,
                },
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
                    FIXTURE_PASSWORDS_ENV: json.dumps(passwords),
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
        print(f"Smoke FAIL at {stage} ({failure_type}).")
    finally:
        if stage != "complete":
            # Include an interrupted stage, but never charge teardown to its duration.
            timed(stage)
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
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(
            json.dumps(
                {
                    "result": "passed" if result == 0 else "failed",
                    "stage": stage,
                    "failure_type": failure_type,
                    "stage_seconds": stages,
                    # Sanitized evidence that outlives the private run directory.
                    "revision": revision,
                    "command": " ".join(["uv run python -m tests.smoke_runner", *argv])
                    + " (from backend/)",
                    "tests": playwright_results(browser_lines),
                    "artifacts": {
                        "playwright_output": "frontend/test-results/smoke",
                        "private_diagnostics": None if result == 0 else str(private),
                    },
                    "packs": pack_results,
                    "seed": {
                        "organization": ",".join(options.packs),
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
    raise SystemExit(main(sys.argv[1:]))
