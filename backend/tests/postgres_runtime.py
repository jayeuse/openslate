"""Runner-owned PostgreSQL 17 lifecycle with explicit ownership verification."""

from __future__ import annotations

import json
import os
import re
import secrets
import stat
import subprocess
import time
from pathlib import Path
from typing import IO
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import create_engine, exc, pool

from app.core.config import Settings
from app.core.config.disposable_instance import (
    POSTGRES_IMAGE,
    DisposableTargetError,
    assert_live_disposable_ownership,
)
from app.core.config.instance import (
    InstanceTargetError,
    assert_instance_target,
    instance_target_for_process,
)

POSTGRES_DATABASE = "openslate"
POSTGRES_NETWORK_ALIAS = "openslate-postgres"
POSTGRES_CONTAINER_PORT = 5432
_DATABASE_ROLES = frozenset({"openslate_owner", "openslate_runtime"})


def postgres_network_name(run_id: str) -> str:
    """Name the private application network owned by one disposable database."""
    return f"openslate-app-e2e-{run_id}"


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
        or manifest.get("run_id") != run_id
        or not isinstance(manifest.get("urls"), list)
        or runtime_database_url not in manifest["urls"]
        or manifest.get("container_runtime") != expected_container_runtime
        or source.resolve() == destination.resolve()
    ):
        raise RuntimeError("Worker requires the run-owned runtime database manifest")
    destination.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "urls": [runtime_database_url],
                "container_runtime": expected_container_runtime,
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
    storage_root: str,
) -> Path:
    """Write only the test worker's runtime settings to its private env file."""
    worker_environment = {
        key: application_env[key]
        for key in (name.upper() for name in Settings.model_fields)
        if key in application_env
    }
    worker_environment["DATABASE_URL"] = database_url
    worker_environment.update(
        E2E_ALLOW_MUTATIONS=application_env["E2E_ALLOW_MUTATIONS"],
        OPENSLATE_FULLSTACK_RUN_ID=application_env["OPENSLATE_FULLSTACK_RUN_ID"],
        OPENSLATE_TEST_DATABASE_MANIFEST=database_manifest_path,
        OPENSLATE_ENV_SOURCE="process",
        LOG_DIR="/tmp/logs",
        FILES_CLAMAV_HOST=clamav_host,
        FILES_CLAMAV_PORT="3310",
        FILES_CLAMAV_MANIFEST_PATH=scanner_manifest_path,
        FILES_STORAGE_ROOT=storage_root,
    )
    credentials = private / "scanner-worker.env"
    credentials.write_text(
        "\n".join(f"{key}={value}" for key, value in worker_environment.items()) + "\n"
    )
    credentials.chmod(0o600)
    return credentials


class DisposablePostgres:
    """One label-owned local database, never a developer or production database."""

    def __init__(self, private: Path, run_id: str, env: dict[str, str], log: IO[str]) -> None:
        self.private = private
        self.run_id = run_id
        self.env = env
        self.log = log
        self.container = f"openslate-postgres-e2e-{run_id}"
        self.network = postgres_network_name(run_id)
        self.volume = f"openslate-postgres-data-e2e-{run_id}"
        self.worktree = str(Path(__file__).resolve().parents[2])
        self.passwords = {
            "bootstrap": secrets.token_urlsafe(32),
            "inspector": secrets.token_urlsafe(32),
            "owner": secrets.token_urlsafe(32),
            "runtime": secrets.token_urlsafe(32),
        }
        self.port: int | None = None

    def _run(self, arguments: list[str], *, capture: bool = False, timeout: int = 60):
        return subprocess.run(
            ["docker", *arguments],
            env=self.env,
            stdout=subprocess.PIPE if capture else self.log,
            stderr=self.log,
            text=True,
            check=True,
            timeout=timeout,
        )

    def urls(self) -> dict[str, str]:
        if self.port is None:
            raise RuntimeError("Disposable PostgreSQL has no discovered loopback port mapping")
        host = f"127.0.0.1:{self.port}/{POSTGRES_DATABASE}"
        return {
            "DATABASE_BOOTSTRAP_URL": (
                f"postgresql+psycopg://postgres:{self.passwords['bootstrap']}@{host}"
            ),
            "MIGRATION_DATABASE_URL": (
                f"postgresql+psycopg://openslate_owner:{self.passwords['owner']}@{host}"
            ),
            "DATABASE_URL": (
                f"postgresql+psycopg://openslate_runtime:{self.passwords['runtime']}@{host}"
            ),
            "DATABASE_INSPECTOR_URL": (
                "postgresql+psycopg://openslate_inspector:"
                f"{self.passwords['inspector']}@{host}"
            ),
        }

    def write_manifest(self) -> Path:
        manifest = self.private / "database.json"
        urls = self.urls()
        manifest.write_text(
            json.dumps(
                {
                    "run_id": self.run_id,
                    "urls": list(urls.values()),
                    "container_runtime": {
                        "url": container_runtime_database_url(urls["DATABASE_URL"]),
                        "network": self.network,
                        "alias": POSTGRES_NETWORK_ALIAS,
                        "port": POSTGRES_CONTAINER_PORT,
                    },
                    "ownership": self._ownership(),
                }
            ),
            encoding="utf-8",
        )
        manifest.chmod(0o600)
        return manifest

    def start(self) -> None:
        labels = [
            "--label", f"openslate.test.run={self.run_id}",
            "--label", f"openslate.test.worktree={self.worktree}",
        ]
        self._run(
            [
                "network",
                "create",
                "--internal",
                *labels,
                self.network,
            ]
        )
        self._run(["volume", "create", *labels, self.volume])
        self._run(
            [
                "run",
                "--detach",
                "--name",
                self.container,
                *labels,
                "--mount", f"type=volume,src={self.volume},dst=/var/lib/postgresql/data",
                "--env",
                f"POSTGRES_PASSWORD={self.passwords['bootstrap']}",
                "--env",
                f"POSTGRES_DB={POSTGRES_DATABASE}",
                "--env",
                "POSTGRES_INITDB_ARGS=--data-checksums",
                "--publish",
                "127.0.0.1::5432",
                POSTGRES_IMAGE,
                "postgres",
                "-c",
                f"cluster_name={self.container}",
            ]
        )
        # Docker does not publish host ports for an internal-only network. Keep
        # the default bridge solely for the loopback publication, then add the
        # task-owned internal network used by the scanner worker.
        self._run(
            [
                "network",
                "connect",
                "--alias",
                POSTGRES_NETWORK_ALIAS,
                self.network,
                self.container,
            ]
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                ready = self._run(
                    [
                        "exec",
                        self.container,
                        "pg_isready",
                        "-U",
                        "postgres",
                        "-d",
                        POSTGRES_DATABASE,
                    ],
                    timeout=10,
                )
                if ready.returncode == 0:
                    self.assert_owned()
                    self.port = self._discover_port()
                    self.assert_cluster_identity()
                    self._ownership()
                    return
            except subprocess.CalledProcessError:
                pass
            time.sleep(0.25)
        raise RuntimeError("Disposable PostgreSQL startup deadline exceeded")

    def _discover_port(self) -> int:
        mapping = self._run(
            ["port", self.container, "5432/tcp"], capture=True, timeout=10
        ).stdout.strip()
        matched = re.fullmatch(r"127\.0\.0\.1:(\d{1,5})", mapping)
        if matched is None:
            raise RuntimeError("Disposable PostgreSQL requires one loopback port mapping")
        port = int(matched.group(1))
        if not 1 <= port <= 65535:
            raise RuntimeError("Disposable PostgreSQL requires one loopback port mapping")
        return port

    def assert_owned(self) -> None:
        try:
            container = self._inspect_json(["inspect", self.container])[0]
            mounts = [
                mount for mount in container["Mounts"]
                if mount.get("Destination") == "/var/lib/postgresql/data"
            ]
            owned = (
                container["Name"] == f"/{self.container}"
                and container["Config"]["Image"] == POSTGRES_IMAGE
                and container["Config"]["Labels"].get("openslate.test.run") == self.run_id
                and container["Config"]["Labels"].get("openslate.test.worktree")
                == self.worktree
                and len(mounts) == 1
                and mounts[0].get("Type") == "volume"
                and mounts[0].get("Name") == self.volume
            )
        except (RuntimeError, KeyError, TypeError, ValueError):
            owned = False
        if not owned:
            raise RuntimeError("Disposable PostgreSQL ownership verification failed")

    def _inspect_json(self, arguments: list[str]) -> list[dict[str, object]]:
        try:
            result = self._run(arguments, capture=True, timeout=10)
            payload = json.loads(result.stdout)
            if not isinstance(payload, list) or len(payload) != 1:
                raise ValueError
            return payload
        except (ValueError, TypeError, json.JSONDecodeError):
            raise RuntimeError("Disposable PostgreSQL ownership inspection failed") from None

    def _ownership(self) -> dict[str, object]:
        if self.port is None:
            raise RuntimeError("Disposable PostgreSQL has no discovered loopback port mapping")
        container = self._inspect_json(["inspect", self.container])[0]
        network = self._inspect_json(["network", "inspect", self.network])[0]
        ownership: dict[str, object] = {
            "container_id": container.get("Id"),
            "container": self.container,
            "network": self.network,
            "network_id": network.get("Id"),
            "volume": self.volume,
            "host_port": self.port,
            "image": POSTGRES_IMAGE,
            "cluster_name": self.container,
            "worktree": self.worktree,
        }
        try:
            assert_live_disposable_ownership(ownership, self.run_id, self._inspect_json)
        except DisposableTargetError:
            raise RuntimeError("Disposable PostgreSQL live ownership verification failed") from None
        return ownership

    def assert_cluster_identity(self) -> None:
        result = self._run(
            [
                "exec",
                self.container,
                "psql",
                "-U",
                "postgres",
                "-d",
                POSTGRES_DATABASE,
                "-At",
                "-c",
                "SELECT current_database(), current_user, current_setting('cluster_name')",
            ],
            capture=True,
            timeout=10,
        )
        if result.stdout.strip() != f"{POSTGRES_DATABASE}|postgres|{self.container}":
            raise RuntimeError("Disposable PostgreSQL cluster identity verification failed")

    def stop(self) -> None:
        try:
            self.assert_owned()
        except subprocess.CalledProcessError:
            pass
        else:
            self._run(["rm", "--force", self.container], timeout=30)
        try:
            volume = self._inspect_json(["volume", "inspect", self.volume])[0]
        except subprocess.CalledProcessError:
            pass
        else:
            labels = volume.get("Labels")
            if (
                volume.get("Name") != self.volume
                or not isinstance(labels, dict)
                or labels.get("openslate.test.run") != self.run_id
                or labels.get("openslate.test.worktree") != self.worktree
            ):
                raise RuntimeError("refusing to remove PostgreSQL volume without ownership")
            self._run(["volume", "rm", self.volume], timeout=30)
        try:
            result = self._run(
                [
                    "network",
                    "inspect",
                    "--format",
                    '{{index .Labels "openslate.test.run"}} '
                    '{{index .Labels "openslate.test.worktree"}}',
                    self.network,
                ],
                capture=True,
                timeout=10,
            )
        except subprocess.CalledProcessError:
            return
        if result.stdout.strip() != f"{self.run_id} {self.worktree}":
            raise RuntimeError("refusing to remove PostgreSQL network without ownership")
        self._run(["network", "rm", self.network], timeout=30)
