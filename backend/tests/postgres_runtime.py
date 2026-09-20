"""Runner-owned PostgreSQL 17 lifecycle with explicit ownership verification."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import time
from pathlib import Path
from typing import IO
from urllib.parse import urlsplit, urlunsplit

POSTGRES_IMAGE = (
    "postgres:17@sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232"
)
POSTGRES_DATABASE = "openslate"
POSTGRES_NETWORK_ALIAS = "openslate-postgres"
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
        (parsed.scheme, f"{credentials}@{POSTGRES_NETWORK_ALIAS}:5432", parsed.path, "", "")
    )


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
        manifest_path = Path(values["OPENSLATE_TEST_DATABASE_MANIFEST"])
        manifest = json.loads(manifest_path.read_text())
        allowed = (
            values.get("E2E_ALLOW_MUTATIONS") == "true"
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
            and manifest_path.stat().st_mode & 0o077 == 0
            and manifest["run_id"] == run_id
            and database_url in manifest["urls"]
        )
    except (KeyError, OSError, TypeError, ValueError):
        allowed = False
    if not allowed:
        raise RuntimeError("Database tests require the runner-owned disposable database manifest")


class DisposablePostgres:
    """One label-owned local database, never a developer or production database."""

    def __init__(self, private: Path, run_id: str, env: dict[str, str], log: IO[str]) -> None:
        self.private = private
        self.run_id = run_id
        self.env = env
        self.log = log
        self.container = f"openslate-postgres-e2e-{run_id}"
        self.network = postgres_network_name(run_id)
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
        manifest.write_text(json.dumps({"run_id": self.run_id, "urls": list(self.urls().values())}))
        manifest.chmod(0o600)
        return manifest

    def start(self) -> None:
        self._run(
            [
                "network",
                "create",
                "--internal",
                "--label",
                f"openslate.test.run={self.run_id}",
                self.network,
            ]
        )
        self._run(
            [
                "run",
                "--detach",
                "--name",
                self.container,
                "--label",
                f"openslate.test.run={self.run_id}",
                "--env",
                f"POSTGRES_PASSWORD={self.passwords['bootstrap']}",
                "--env",
                f"POSTGRES_DB={POSTGRES_DATABASE}",
                "--env",
                "POSTGRES_INITDB_ARGS=--data-checksums",
                "--publish",
                "127.0.0.1::5432",
                POSTGRES_IMAGE,
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
        result = self._run(
            [
                "inspect",
                "--format",
                '{{index .Config.Labels "openslate.test.run"}} {{.Config.Image}}',
                self.container,
            ],
            capture=True,
            timeout=10,
        )
        if result.stdout.strip() != f"{self.run_id} {POSTGRES_IMAGE}":
            raise RuntimeError("Disposable PostgreSQL ownership verification failed")

    def stop(self) -> None:
        try:
            self.assert_owned()
        except subprocess.CalledProcessError:
            pass
        else:
            self._run(["rm", "--force", "--volumes", self.container], timeout=30)
        try:
            result = self._run(
                [
                    "network",
                    "inspect",
                    "--format",
                    '{{index .Labels "openslate.test.run"}}',
                    self.network,
                ],
                capture=True,
                timeout=10,
            )
        except subprocess.CalledProcessError:
            return
        if result.stdout.strip() != self.run_id:
            raise RuntimeError("refusing to remove PostgreSQL network without ownership")
        self._run(["network", "rm", self.network], timeout=30)
