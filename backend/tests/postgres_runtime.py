"""Runner-owned PostgreSQL 17 lifecycle with explicit ownership verification."""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import create_engine, exc, pool

from app.core.config import Settings
from app.core.config.disposable_instance import DisposableTargetError
from app.core.config.instance import (
    InstanceTargetError,
    assert_instance_target,
    instance_target_for_process,
)
from tests import supabase_runtime as _supabase_runtime

POSTGRES_DATABASE = "postgres"
POSTGRES_NETWORK_ALIAS = "db"
POSTGRES_CONTAINER_PORT = 5432
_DATABASE_ROLES = frozenset({"openslate_owner", "openslate_runtime"})


def postgres_network_name(run_id: str) -> str:
    """Name the private application network owned by one disposable database."""
    return provider_network_name(run_id)


def container_runtime_database_url(database_url: str) -> str:
    """Change a verified host-only runtime URL to the private Docker DNS route."""
    parsed = urlsplit(database_url)
    if (
        parsed.scheme != "postgresql+psycopg"
        or parsed.hostname != "127.0.0.1"
        or parsed.port is None
        or parsed.path != f"/{POSTGRES_DATABASE}"
        or not parsed.username
        or not parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("Worker requires exact disposable runtime credentials")
    credentials = parsed.netloc.rsplit("@", maxsplit=1)[0]
    return urlunsplit(
        (
            parsed.scheme,
            f"{credentials}@{POSTGRES_NETWORK_ALIAS}:{POSTGRES_CONTAINER_PORT}",
            parsed.path,
            "",
            "",
        )
    )


def write_worker_database_manifest(
    source: Path, destination: Path, *, run_id: str, runtime_database_url: str
) -> Path:
    """Give the scanner worker only its run and runtime-role database credentials."""
    try:
        metadata = source.lstat()
        manifest = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        raise RuntimeError("Worker requires the private runner database manifest") from None
    expected_container_runtime = {
        "url": container_runtime_database_url(runtime_database_url),
        "network": postgres_network_name(run_id),
        "alias": POSTGRES_NETWORK_ALIAS,
        "port": POSTGRES_CONTAINER_PORT,
    }
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) & 0o077
        or not isinstance(manifest, dict)
        or manifest.get("version") != 2
        or manifest.get("run_id") != run_id
        or not isinstance(manifest.get("urls"), list)
        or runtime_database_url not in manifest["urls"]
        or manifest.get("container_runtime") != expected_container_runtime
        or not isinstance(manifest.get("provider"), dict)
        or set(manifest["provider"]) != {
            "api_url", "auth_issuer", "storage_url", "mail_url",
        }
        or source.resolve() == destination.resolve()
    ):
        raise RuntimeError("Worker requires the run-owned runtime database manifest")
    destination.write_text(
        json.dumps(
            {
                "version": 2,
                "run_id": run_id,
                "urls": [runtime_database_url],
                "container_runtime": expected_container_runtime,
                "provider": manifest["provider"],
                "ownership": manifest["ownership"],
            }
        ),
        encoding="utf-8",
    )
    destination.chmod(0o600)
    return destination


def assert_runner_database_url(
    database_url: str,
    environment: dict[str, str] | None = None,
    allowed_roles: frozenset[str] = _DATABASE_ROLES,
) -> None:
    """Reject every integration URL except an exact private runner manifest entry."""
    values = os.environ if environment is None else environment
    try:
        run_id = values.get("OPENSLATE_FULLSTACK_RUN_ID", "")
        parsed = urlsplit(database_url)
        allowed = (
            values.get("ENVIRONMENT") == "test"
            and values.get("E2E_ALLOW_MUTATIONS") == "true"
            and re.fullmatch(r"[a-f0-9]{32}", run_id) is not None
            and parsed.scheme == "postgresql+psycopg"
            and parsed.hostname == "127.0.0.1"
            and parsed.port is not None
            and 1 <= parsed.port <= 65535
            and parsed.path == f"/{POSTGRES_DATABASE}"
            and not parsed.query
            and not parsed.fragment
            and parsed.username in allowed_roles
            and bool(parsed.password)
        )
    except (KeyError, OSError, TypeError, ValueError):
        allowed = False
    if not allowed:
        raise RuntimeError("Database tests require the runner-owned disposable database manifest")
    try:
        target = instance_target_for_process(database_url, parsed.username or "", values)
    except (InstanceTargetError, DisposableTargetError):
        raise RuntimeError("Database tests require a live runner-owned instance") from None
    if target is None:
        raise RuntimeError("Database tests require a live runner-owned instance")
    engine = create_engine(database_url, poolclass=pool.NullPool)
    try:
        with engine.connect() as connection:
            assert_instance_target(connection, target, expected_user=parsed.username)
    except (exc.SQLAlchemyError, InstanceTargetError):
        raise RuntimeError("Database tests require matching live database identity") from None
    finally:
        engine.dispose()


def assert_scanner_worker_database(application_env: dict[str, str]) -> None:
    """Keep scanner worker startup behind the host-side disposable database guard."""
    try:
        assert_runner_database_url(
            application_env["DATABASE_URL"],
            application_env,
            allowed_roles=frozenset({"openslate_runtime"}),
        )
    except RuntimeError:
        raise RuntimeError("Worker requires exact disposable runtime credentials") from None


def prepare_scanner_worker_database(
    application_env: dict[str, str],
    *,
    run_id: str,
    private: Path,
    current_network: str | None,
    requested_network: str | None,
) -> tuple[str, Path, str]:
    """Build the limited worker manifest, then resolve the run-owned network."""
    expected_network = postgres_network_name(run_id)
    database_url = application_env["DATABASE_URL"]
    worker_manifest = write_worker_database_manifest(
        Path(application_env["OPENSLATE_TEST_DATABASE_MANIFEST"]),
        private / "scanner-worker-database.json",
        run_id=run_id,
        runtime_database_url=database_url,
    )
    if requested_network is not None and requested_network != expected_network:
        raise RuntimeError("Worker requires the run-owned database network")
    selected_network = requested_network if requested_network is not None else current_network
    if selected_network is None:
        raise RuntimeError("Worker requires the run-owned database network")
    if selected_network != expected_network:
        raise RuntimeError("Worker requires exact disposable runtime credentials")
    return container_runtime_database_url(database_url), worker_manifest, selected_network


def write_scanner_worker_environment(
    application_env: dict[str, str],
    *,
    private: Path,
    clamav_host: str,
    database_url: str,
    database_manifest_path: str,
    scanner_manifest_path: str,
) -> Path:
    """Write only the test worker's runtime settings to its private env file."""
    worker_environment = {
        key: application_env[key]
        for key in (name.upper() for name in Settings.model_fields)
        if key in application_env
    }
    worker_environment["DATABASE_URL"] = database_url
    worker_environment["SUPABASE_URL"] = "http://api-gw:8000"
    worker_environment["SUPABASE_STORAGE_URL"] = "http://api-gw:8000/storage/v1"
    worker_environment.update(
        E2E_ALLOW_MUTATIONS=application_env["E2E_ALLOW_MUTATIONS"],
        OPENSLATE_FULLSTACK_RUN_ID=application_env["OPENSLATE_FULLSTACK_RUN_ID"],
        OPENSLATE_TEST_DATABASE_MANIFEST=database_manifest_path,
        OPENSLATE_ENV_SOURCE="process",
        LOG_DIR="/tmp/logs",
        FILES_CLAMAV_HOST=clamav_host,
        FILES_CLAMAV_PORT="3310",
        FILES_CLAMAV_MANIFEST_PATH=scanner_manifest_path,
    )
    credentials = private / "scanner-worker.env"
    credentials.write_text(
        "\n".join(f"{key}={value}" for key, value in worker_environment.items()) + "\n"
    )
    credentials.chmod(0o600)
    return credentials


DisposablePostgres = _supabase_runtime.DisposablePostgres
provider_network_name = _supabase_runtime.provider_network_name
