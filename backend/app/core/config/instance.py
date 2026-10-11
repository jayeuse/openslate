"""Fail-closed ownership checks for one locally isolated OpenSlate instance."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.engine import Connection, make_url

from app.core.config.disposable_instance import (
    SUPABASE_DB_IMAGE,
    DisposableTargetError,
    load_disposable_target,
)
from app.core.config.environment import ConfigurationError, environment_inputs
from app.core.config.settings import DOTENV_PATH, get_instance_settings

_IDENTITY = re.compile(r"[a-z][a-z0-9-]{2,62}\Z")
_DOCKER_ID = re.compile(r"[a-f0-9]{12,64}\Z")
_MIGRATION_LOCK_NAME = "openslate:alembic"
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


class InstanceTargetError(ConfigurationError):
    """Configured state does not uniquely identify the local PostgreSQL instance."""


@dataclass(frozen=True, slots=True)
class InstanceTarget:
    instance_id: str
    host: str
    port: int
    database: str
    attestation_path: Path | None
    cluster_name: str | None = None


def load_instance_target(process: Mapping[str, str] | None = None) -> InstanceTarget:
    """Load one non-secret attestation and reject ambiguous Compose ownership."""

    if process is None:
        settings = get_instance_settings()
        values: Mapping[str, str] = {
            **environment_inputs(DOTENV_PATH),
            "ENVIRONMENT": settings.environment,
            "OPENSLATE_INSTANCE_ID": settings.open_slate_instance_id,
            "POSTGRES_HOST": settings.postgres_host,
            "POSTGRES_PORT": str(settings.postgres_port),
            "POSTGRES_DATABASE": settings.postgres_database,
        }
    else:
        values = process
    instance_id = _required(values, "OPENSLATE_INSTANCE_ID")
    if _IDENTITY.fullmatch(instance_id) is None:
        raise InstanceTargetError("OpenSlate instance identity is invalid")
    path = REPOSITORY_ROOT / ".agent-runtime" / "instances" / f"{instance_id}.json"
    try:
        metadata = path.lstat()
        mode = stat.S_IMODE(metadata.st_mode)
        if not stat.S_ISREG(metadata.st_mode) or (os.name != "nt" and mode & 0o077):
            raise ValueError
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        raise InstanceTargetError("OpenSlate instance attestation is unavailable") from None
    if not isinstance(payload, dict):
        raise InstanceTargetError("OpenSlate instance attestation is invalid")
    postgres = payload.get("postgres")
    compose = payload.get("compose")
    if not isinstance(postgres, dict) or not isinstance(compose, dict):
        raise InstanceTargetError("OpenSlate instance attestation is invalid")
    ownership = payload.get("ownership")
    if not isinstance(ownership, dict):
        raise InstanceTargetError("OpenSlate instance attestation is invalid")
    try:
        host = _required(values, "POSTGRES_HOST")
        port = int(_required(values, "POSTGRES_PORT"))
        database = _required(values, "POSTGRES_DATABASE")
    except ValueError:
        raise InstanceTargetError("OpenSlate instance target is invalid") from None
    if not 1 <= port <= 65535 or database != "postgres":
        raise InstanceTargetError("OpenSlate instance target is invalid")
    expected_volume = f"{instance_id}_supabase-db-data"
    expected_network = f"{instance_id}_provider"
    container_id = ownership.get("container_id")
    image = ownership.get("image")
    network_id = ownership.get("network_id")
    if (
        payload.get("version") != 2
        or host != "127.0.0.1"
        or payload.get("instance_id") != instance_id
        or payload.get("compose_project") != instance_id
        or postgres
        != {
            "host": host,
            "port": port,
            "database": database,
            "cluster_name": instance_id,
        }
        or compose != {"volume": expected_volume, "network": expected_network}
        or ownership.get("working_dir") != str(REPOSITORY_ROOT / "infra" / "supabase")
        or ownership.get("compose_project") != instance_id
        or ownership.get("network") != expected_network
        or ownership.get("volume") != expected_volume
        or ownership.get("host_port") != port
        or ownership.get("container_port") != 5432
        or not isinstance(container_id, str)
        or _DOCKER_ID.fullmatch(container_id) is None
        or not isinstance(network_id, str)
        or _DOCKER_ID.fullmatch(network_id) is None
        or not isinstance(image, str)
        or image != SUPABASE_DB_IMAGE
    ):
        raise InstanceTargetError("OpenSlate instance ownership attestation does not match")
    return InstanceTarget(instance_id, host, port, database, path, instance_id)


def test_manifest_authorizes_process(
    database_url: str,
    expected_user: str,
    process: Mapping[str, str] | None = None,  # noqa: PT028 - runtime guard, not a test
) -> bool:
    """Require a live runner-owned disposable database for this exact process."""
    values = os.environ if process is None else process
    try:
        load_disposable_target(
            database_url,
            expected_user,
            values,
            repository_root=REPOSITORY_ROOT,
            inspect=_docker_json,
        )
        return True
    except (DisposableTargetError, InstanceTargetError):
        return False


def instance_target_for_process(
    database_url: str, expected_user: str, process: Mapping[str, str] | None = None
) -> InstanceTarget | None:
    """Return a verified local, production, or disposable test target."""

    if process is None:
        values: Mapping[str, str] = environment_inputs(DOTENV_PATH)
    else:
        values = process
    environment = values.get("ENVIRONMENT", "").strip().casefold()
    if environment == "test":
        try:
            disposable = load_disposable_target(
                database_url,
                expected_user,
                values,
                repository_root=REPOSITORY_ROOT,
                inspect=_docker_json,
            )
        except DisposableTargetError:
            raise InstanceTargetError("Test database target lacks live runner ownership") from None
        target = InstanceTarget(
            disposable.run_id,
            disposable.host,
            disposable.port,
            disposable.database,
            disposable.manifest_path,
            disposable.cluster_name,
        )
        assert_database_url(database_url, target, expected_user=expected_user)
        return target
    if environment in {"development", "dev", "local"}:
        target = load_instance_target(values)
        assert_database_url(database_url, target, expected_user=expected_user)
        assert_live_docker_ownership(target)
        return target
    if environment in {"production", "prod"}:
        target = _configured_production_target(values)
    else:
        raise InstanceTargetError("OpenSlate database environment is unsupported")
    assert_database_url(database_url, target, expected_user=expected_user)
    return target


def _configured_production_target(values: Mapping[str, str]) -> InstanceTarget:
    """Keep production config explicit without requiring local Docker access."""
    instance_id = _required(values, "OPENSLATE_INSTANCE_ID")
    if _IDENTITY.fullmatch(instance_id) is None:
        raise InstanceTargetError("OpenSlate instance identity is invalid")
    host = _required(values, "POSTGRES_HOST")
    database = _required(values, "POSTGRES_DATABASE")
    try:
        port = int(_required(values, "POSTGRES_PORT"))
    except ValueError:
        raise InstanceTargetError("OpenSlate instance target is invalid") from None
    if not 1 <= port <= 65535 or database != "postgres":
        raise InstanceTargetError("OpenSlate instance target is invalid")
    return InstanceTarget(instance_id, host, port, database, None, instance_id)


def _docker_json(arguments: list[str]) -> Any:
    allowed_environment = {
        name: os.environ[name]
        for name in (
            "PATH",
            "HOME",
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "DOCKER_CERT_PATH",
            "DOCKER_TLS_VERIFY",
            "DOCKER_API_VERSION",
        )
        if name in os.environ
    }
    try:
        result = subprocess.run(
            ["docker", *arguments],
            cwd=REPOSITORY_ROOT,
            env=allowed_environment,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise ValueError
        if arguments[:5] == ["ps", "-a", "-q", "--no-trunc", "--filter"]:
            return result.stdout.splitlines()
        return json.loads(result.stdout)
    except (OSError, ValueError, json.JSONDecodeError):
        raise InstanceTargetError("Live Docker ownership could not be verified") from None


def assert_live_docker_ownership(target: InstanceTarget) -> None:
    """Re-inspect container, network and volume immediately before local DB work."""
    path = target.attestation_path
    if path is None or target.cluster_name != target.instance_id:
        raise InstanceTargetError("Local OpenSlate instance attestation is unavailable")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        ownership = payload["ownership"]
        container = _docker_json(["inspect", ownership["container_id"]])[0]
        network = _docker_json(["network", "inspect", ownership["network"]])[0]
        volume = _docker_json(["volume", "inspect", ownership["volume"]])[0]
        labels = container["Config"]["Labels"]
        mounts = container["Mounts"]
        networks = container["NetworkSettings"]["Networks"]
        bindings = container["HostConfig"]["PortBindings"]["5432/tcp"]
        data_mounts = [
            mount
            for mount in mounts
            if mount.get("Type") == "volume"
            and mount.get("Destination") == "/var/lib/postgresql/data"
        ]
        network_labels = network["Labels"]
        volume_labels = volume["Labels"]
        owned = (
            container["Id"] == ownership["container_id"]
            and container["State"]["Running"] is True
            and labels.get("com.docker.compose.project") == target.instance_id
            and labels.get("com.docker.compose.project.working_dir")
            == str(REPOSITORY_ROOT / "infra" / "supabase")
            and labels.get("com.docker.compose.service") == "db"
            and container["Config"]["Image"] == ownership["image"] == SUPABASE_DB_IMAGE
            and networks[ownership["network"]]["NetworkID"] == ownership["network_id"]
            and network["Id"] == ownership["network_id"]
            and network_labels.get("com.docker.compose.project") == target.instance_id
            and network_labels.get("com.docker.compose.network") == "provider"
            and len(data_mounts) == 1
            and data_mounts[0].get("Name") == ownership["volume"]
            and volume_labels.get("com.docker.compose.project") == target.instance_id
            and volume_labels.get("com.docker.compose.volume") == "supabase-db-data"
            and bindings
            == [
                {
                    "HostIp": "127.0.0.1",
                    "HostPort": str(target.port),
                }
            ]
            and ownership["host_port"] == target.port
            and ownership["container_port"] == 5432
        )
    except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        owned = False
    if not owned:
        raise InstanceTargetError("Live Docker ownership does not match this OpenSlate worktree")


def instance_identity_for_process(process: Mapping[str, str] | None = None) -> str | None:
    """Return a non-secret digest binding the API identity to this repository path."""
    values: Mapping[str, str]
    if process is None:
        values = environment_inputs(DOTENV_PATH)
    else:
        values = process
    if values.get("ENVIRONMENT", "").casefold() == "test":
        identity = values.get("OPENSLATE_FULLSTACK_RUN_ID", "")
    else:
        identity = values.get("OPENSLATE_INSTANCE_ID", "")
    if not identity:
        return None
    if _IDENTITY.fullmatch(identity) is None and re.fullmatch(r"[a-f0-9]{32}", identity) is None:
        raise InstanceTargetError("OpenSlate instance identity is invalid")
    worktree = str(REPOSITORY_ROOT.resolve())
    return hashlib.sha256(f"{identity}\0{worktree}".encode()).hexdigest()


def assert_local_backend_url(value: str, *, expected_port: int) -> None:
    """Allow the seed client to reach only this worktree's local API listener."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        loopback = host == "localhost"
        if host is not None and not loopback:
            loopback = ipaddress.ip_address(host).is_loopback
        valid = (
            parsed.scheme in {"http", "https"}
            and loopback
            and parsed.port == expected_port
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
        )
    except (ValueError, UnicodeError):
        valid = False
    if not valid:
        raise InstanceTargetError("BACKEND_URL does not target this local OpenSlate API")


def assert_database_url(value: str, target: InstanceTarget, *, expected_user: str | None) -> None:
    """Reject a target mismatch before opening a mutating connection."""

    try:
        parsed = make_url(value)
        parts = urlsplit(value)
        matches = (
            parsed.drivername in {"postgresql", "postgresql+psycopg"}
            and parsed.host == target.host
            and parsed.port == target.port
            and parsed.database == target.database
            and (expected_user is None or parsed.username == expected_user)
            and not parsed.query
            and not parts.query
            and not parts.fragment
        )
    except Exception:
        matches = False
    if not matches:
        raise InstanceTargetError("Database target does not match the owned OpenSlate instance")


def assert_instance_target(
    connection: Connection, target: InstanceTarget, *, expected_user: str | None
) -> None:
    """Compare the connected server's durable identity before any mutation."""

    database, user, cluster_name = connection.exec_driver_sql(
        "SELECT current_database(), current_user, current_setting('cluster_name', true)"
    ).one()
    if (
        database != target.database
        or (target.cluster_name is not None and cluster_name != target.cluster_name)
        or (expected_user is not None and user != expected_user)
    ):
        raise InstanceTargetError("Connected database does not match the owned OpenSlate instance")


def assert_psycopg_target(
    connection: Any, target: InstanceTarget, *, expected_user: str | None
) -> None:
    """Apply the same live identity check to direct operator connections."""

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_database(), current_user, current_setting('cluster_name', true)"
        )
        row = cursor.fetchone()
    if (
        not isinstance(row, tuple)
        or len(row) != 3
        or row[0] != target.database
        or (target.cluster_name is not None and row[2] != target.cluster_name)
        or (expected_user is not None and row[1] != expected_user)
    ):
        raise InstanceTargetError("Connected database does not match the owned OpenSlate instance")


@contextmanager
def migration_advisory_lock(connection: Connection) -> Iterator[None]:
    """Serialize Alembic until the surrounding migration transaction commits."""

    connection.exec_driver_sql(
        "SELECT pg_advisory_xact_lock(hashtext(%s))", (_MIGRATION_LOCK_NAME,)
    )
    yield


def _required(values: Mapping[str, str], name: str) -> str:
    value = values.get(name, "").strip()
    if not value:
        raise InstanceTargetError(f"Missing OpenSlate instance configuration: {name}")
    return value
