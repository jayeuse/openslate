"""Project the private root environment into narrow runtime environments."""

from __future__ import annotations

import argparse
import importlib.util
import ipaddress
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CADDY_GENERATOR_PATH = ROOT / "infra" / "caddy" / "generate_config.py"
LINUX_CADDY_COMPOSE_PATH = ROOT / "infra" / "caddy" / "compose.linux.yaml"
CADDY_CONTAINER_PORT = 3448
CADDY_HEALTH_PORT = 3449
COMPOSE_GLOBAL_OPTIONS_WITH_VALUE = frozenset({"--profile"})
INSTANCE_ID = re.compile(r"[a-z][a-z0-9-]{2,62}\Z")
sys.path.insert(0, str(ROOT / "backend"))

from app.core.config.development import is_local_development_host  # noqa: E402
from app.core.config.environment import ConfigurationError, read_environment  # noqa: E402
from app.core.config.instance import InstanceTargetError, load_instance_target  # noqa: E402

__all__ = ("ConfigurationError", "read_environment")

SETTINGS_KEYS = (
    "ENVIRONMENT",
    "LOG_DIR",
    "DATABASE_URL",
    "AUTH_JWT_SECRET",
    "AUTH_JWT_ISSUER",
    "AUTH_JWT_AUDIENCE",
    "AUTH_ACCESS_TOKEN_MINUTES",
    "AUTH_REFRESH_TOKEN_DAYS",
    "SECURITY_EVENT_SERVER_KEY",
    "LIFECYCLE_PURGE_ENABLED",
    "PUBLIC_ORIGIN",
    "FILES_STORAGE_ROOT",
    "REQUEST_BODY_MAX_BYTES",
    "DATABASE_POOL_SIZE",
    "DATABASE_MAX_OVERFLOW",
    "DATABASE_POOL_TIMEOUT_SECONDS",
    "DATABASE_CONNECT_TIMEOUT_SECONDS",
    "DATABASE_STATEMENT_TIMEOUT_MS",
    "READINESS_POOL_TIMEOUT_SECONDS",
    "READINESS_CONNECT_TIMEOUT_SECONDS",
    "READINESS_STATEMENT_TIMEOUT_MS",
    "READINESS_CALLER_TIMEOUT_SECONDS",
    "BACKEND_BIND_HOST",
    "BACKEND_PORT",
    "SERVER_MAX_CONCURRENCY",
    "SERVER_KEEP_ALIVE_SECONDS",
)
SMTP_KEYS = (
    "SMTP_ENABLED",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USERNAME",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_TRANSPORT",
    "SMTP_DELIVERY_ENCRYPTION_KEY",
    "SMTP_TIMEOUT_SECONDS",
    "SMTP_DELIVERY_OPERATION_TIMEOUT_SECONDS",
    "SMTP_DELIVERY_BATCH_SIZE",
    "SMTP_DELIVERY_MAX_ATTEMPTS",
)
ROOT_ENVIRONMENT_KEYS = frozenset(
    (
        *SETTINGS_KEYS,
        *SMTP_KEYS,
        "POSTGRES_HOST",
        "OPENSLATE_INSTANCE_ID",
        "OPENSLATE_INSTANCE_ROOT",
        "POSTGRES_PORT",
        "POSTGRES_DATABASE",
        "FRONTEND_DEV_PORT",
        "WEB_ASSETS_ROOT",
        "FILES_CLAMAV_PORT",
        "PGWEB_BIND_HOST",
        "PGWEB_PORT",
        "GATEWAY_PUBLIC_HOST",
        "GATEWAY_BIND_HOST",
        "GATEWAY_PORT",
        "BACKEND_URL",
        "DATABASE_BOOTSTRAP_URL",
        "MIGRATION_DATABASE_URL",
        "DATABASE_INSPECTOR_URL",
        "POSTGRES_BOOTSTRAP_PASSWORD",
        "ADMIN_EMAIL",
        "ADMIN_USERNAME",
        "ADMIN_PASSWORD",
        "SEED_ACCESS_TOKEN",
        "CLAMAV_MEMORY_LIMIT",
        "CLAMAV_CPUS",
        "CLAMAV_PIDS_LIMIT",
        "FILES_CLAMAV_HOST",
        "SCANNER_DEFINITIONS",
        "FILES_CLAMAV_MANIFEST_PATH",
    )
)
COMPOSE_EXCLUDED_KEYS = ROOT_ENVIRONMENT_KEYS | frozenset(
    {
        "PGWEB_PASSFILE_PATH",
        "CADDY_CONFIG_PATH",
    }
)
PORT_KEYS = (
    "FRONTEND_DEV_PORT",
    "BACKEND_PORT",
    "POSTGRES_PORT",
    "PGWEB_PORT",
    "FILES_CLAMAV_PORT",
)
def required(values: dict[str, str], name: str) -> str:
    value = values.get(name)
    if value is None or not value.strip():
        raise ConfigurationError(f"Missing required configuration: {name}")
    return value


def port(values: dict[str, str], name: str) -> int:
    value = required(values, name)
    if not re.fullmatch(r"[0-9]+", value) or not 1 <= int(value) <= 65535:
        raise ConfigurationError(f"Invalid port configuration: {name}")
    return int(value)


def http_url(values: dict[str, str], name: str) -> str:
    value = required(values, name)
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError
        if parsed.username or parsed.password or parsed.fragment:
            raise ValueError
        _ = parsed.port
    except ValueError:
        raise ConfigurationError(f"Invalid HTTP URL configuration: {name}") from None
    return value


def is_loopback_bind_host(value: str) -> bool:
    """Return whether the FastAPI listener remains private to this machine."""
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def is_local_development_origin(value: str, *, frontend_port: int) -> bool:
    """Accept the local browser addresses that Next can proxy to loopback FastAPI."""
    parsed = urlsplit(value)
    host = parsed.hostname
    if parsed.scheme not in {"http", "https"} or host is None or parsed.port != frontend_port:
        return False
    return is_local_development_host(host)


def absolute_path(values: dict[str, str], name: str) -> str:
    value = required(values, name)
    if not Path(value).is_absolute():
        raise ConfigurationError(f"Expected an absolute path for configuration: {name}")
    return value


def database_url(values: dict[str, str], name: str, expected_role: str | None) -> str:
    value = required(values, name)
    postgres_host(values)
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme == "postgresql+psycopg"
            and parsed.hostname
            and parsed.username
            and parsed.password
            and parsed.path == "/" + required(values, "POSTGRES_DATABASE")
            and parsed.hostname == required(values, "POSTGRES_HOST").casefold()
            and parsed.port == port(values, "POSTGRES_PORT")
        )
    except ValueError:
        valid = False
    if not valid or (expected_role is not None and parsed.username != expected_role):
        raise ConfigurationError(f"Invalid database configuration: {name}")
    return value


def postgres_host(values: dict[str, str]) -> str:
    value = required(values, "POSTGRES_HOST")
    if value != "127.0.0.1":
        raise ConfigurationError("POSTGRES_HOST must remain on IPv4 loopback")
    return value


def compose_environment(values: dict[str, str], *, services: set[str]) -> dict[str, str]:
    """Project only the settings consumed by the selected Compose services."""
    postgres_host(values)
    result = {
        "OPENSLATE_INSTANCE_ID": instance_id(values),
        "POSTGRES_DATABASE": required(values, "POSTGRES_DATABASE"),
        "POSTGRES_BOOTSTRAP_PASSWORD": required(values, "POSTGRES_BOOTSTRAP_PASSWORD"),
        "POSTGRES_PORT": str(port(values, "POSTGRES_PORT")),
    }
    if "pgweb" in services:
        if required(values, "PGWEB_BIND_HOST") != "127.0.0.1":
            raise ConfigurationError("PGWEB_BIND_HOST must remain on IPv4 loopback")
        database_url(values, "DATABASE_INSPECTOR_URL", "openslate_inspector")
        result.update(
            {
                "PGWEB_BIND_HOST": "127.0.0.1",
                "PGWEB_PORT": str(port(values, "PGWEB_PORT")),
            }
        )
    if "caddy" in services:
        result.update(
            {
                "GATEWAY_BIND_HOST": required(values, "GATEWAY_BIND_HOST"),
                "GATEWAY_PORT": str(port(values, "GATEWAY_PORT")),
            }
        )
    return result


def instance_id(values: dict[str, str]) -> str:
    """Validate the Compose namespace shared by the container, network and volume."""
    value = required(values, "OPENSLATE_INSTANCE_ID")
    if INSTANCE_ID.fullmatch(value) is None:
        raise ConfigurationError("OPENSLATE_INSTANCE_ID must be a lowercase Compose identifier")
    root = Path(absolute_path(values, "OPENSLATE_INSTANCE_ROOT"))
    for name in ("FILES_STORAGE_ROOT", "LOG_DIR"):
        try:
            Path(absolute_path(values, name)).relative_to(root)
        except ValueError:
            raise ConfigurationError(f"{name} must be inside OPENSLATE_INSTANCE_ROOT") from None
    return value


def _docker_output(arguments: list[str]) -> str:
    child_env = {
        key: value
        for key, value in os.environ.items()
        if key not in COMPOSE_EXCLUDED_KEYS and not key.startswith("COMPOSE_")
    }
    result = subprocess.run(
        ["docker", *arguments],
        cwd=ROOT,
        env=child_env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise ConfigurationError("Docker ownership could not be verified")
    return result.stdout


def _docker_json(arguments: list[str]) -> Any:
    try:
        return json.loads(_docker_output(arguments))
    except json.JSONDecodeError:
        raise ConfigurationError("Docker ownership could not be verified") from None


def _compose_project_containers(values: dict[str, str]) -> list[str]:
    identity = instance_id(values)
    projected = compose_environment(values, services={"postgres"})
    child_env = {
        key: value
        for key, value in os.environ.items()
        if key not in COMPOSE_EXCLUDED_KEYS and not key.startswith("COMPOSE_")
    }
    child_env.update(projected)
    command = [
        "docker",
        "compose",
        "--env-file",
        os.devnull,
        "--project-name",
        identity,
        "-f",
        str(ROOT / "compose.yaml"),
        "ps",
        "--all",
        "-q",
        "postgres",
    ]
    result = subprocess.run(
        command, cwd=ROOT, env=child_env, capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise ConfigurationError("Docker ownership could not be verified")
    return [value for value in result.stdout.splitlines() if value]


def _compose_resource_labels(resource: dict[str, Any], identity: str, kind: str) -> bool:
    labels = resource.get("Labels")
    expected = "postgres-data" if kind == "volume" else "default"
    return bool(
        isinstance(labels, dict)
        and labels.get("com.docker.compose.project") == identity
        and labels.get("com.docker.compose." + kind) == expected
    )


def inspect_instance_ownership(
    values: dict[str, str], *, allow_stopped: bool = False
) -> dict[str, object]:
    """Read container, network and volume ownership facts from Docker itself."""
    identity = instance_id(values)
    identifiers = _compose_project_containers(values)
    if len(identifiers) != 1:
        raise ConfigurationError("Owned PostgreSQL container is unavailable or ambiguous")
    inspected = _docker_json(["inspect", identifiers[0]])
    try:
        container = inspected[0]
        config = container["Config"]
        labels = config["Labels"]
        mounts = container["Mounts"]
        networks = container["NetworkSettings"]["Networks"]
        network = networks[f"{identity}_default"]
        attached_network_id = network["NetworkID"]
        bound_ports = container["HostConfig"]["PortBindings"]["5432/tcp"]
        data_mounts = [
            mount
            for mount in mounts
            if mount.get("Type") == "volume"
            and mount.get("Destination") == "/var/lib/postgresql/data"
        ]
        network_resource = _docker_json(["network", "inspect", f"{identity}_default"])[0]
        volume_resource = _docker_json(["volume", "inspect", f"{identity}_postgres-data"])[0]
        network_id = network_resource["Id"]
        volume_labels_match = _compose_resource_labels(volume_resource, identity, "volume")
        network_labels_match = _compose_resource_labels(network_resource, identity, "network")
        expected_port = str(port(values, "POSTGRES_PORT"))
        owned = (
            labels.get("com.docker.compose.project") == identity
            and labels.get("com.docker.compose.project.working_dir") == str(ROOT)
            and labels.get("com.docker.compose.service") == "postgres"
            and str(config.get("Image", "")).startswith("postgres:")
            and (
                container["State"]["Running"] is True
                or (allow_stopped and container["State"]["Running"] is False)
            )
            and len(data_mounts) == 1
            and data_mounts[0].get("Name") == f"{identity}_postgres-data"
            and len(bound_ports) == 1
            and bound_ports[0]
            == {"HostIp": "127.0.0.1", "HostPort": expected_port}
            and network_id == attached_network_id
            and volume_labels_match
            and network_labels_match
        )
    except (IndexError, KeyError, TypeError, ValueError):
        owned = False
        container = {}
        network_id = ""
    if not owned:
        raise ConfigurationError("Docker ownership does not match this OpenSlate worktree")
    return {
        "container_id": container["Id"],
        "image": container["Config"]["Image"],
        "working_dir": str(ROOT),
        "compose_project": identity,
        "network": f"{identity}_default",
        "network_id": network_id,
        "volume": f"{identity}_postgres-data",
        "host_port": port(values, "POSTGRES_PORT"),
        "container_port": 5432,
    }


def _read_instance_attestation(values: dict[str, str]) -> tuple[Path, dict[str, Any]]:
    try:
        target = load_instance_target(values)
        path = target.attestation_path
        if path is None:
            raise InstanceTargetError("OpenSlate instance attestation path is unavailable")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (InstanceTargetError, OSError, json.JSONDecodeError):
        raise ConfigurationError(
            "OpenSlate instance attestation is unavailable or invalid"
        ) from None
    if not isinstance(payload, dict):
        raise ConfigurationError("OpenSlate instance attestation is unavailable or invalid")
    return path, payload


def _verify_attested_resources(values: dict[str, str]) -> None:
    """Bind a retained database volume and any surviving network to this worktree."""
    identity = instance_id(values)
    _path, payload = _read_instance_attestation(values)
    ownership = payload["ownership"]
    volume_name = f"{identity}_postgres-data"
    network_ids = _docker_output(
        ["network", "ls", "-q", "--filter", f"name=^{identity}_default$"]
    ).splitlines()
    volume = _docker_json(["volume", "inspect", volume_name])[0]
    try:
        valid = volume.get("Name") == volume_name and _compose_resource_labels(
            volume, identity, "volume"
        )
        if network_ids:
            if len(network_ids) != 1:
                valid = False
            else:
                network = _docker_json(["network", "inspect", network_ids[0]])[0]
                valid = (
                    valid
                    and network["Id"] == ownership["network_id"]
                    and _compose_resource_labels(network, identity, "network")
                )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise ConfigurationError("Docker resources do not match this OpenSlate worktree")


def _verify_live_instance(values: dict[str, str]) -> dict[str, object]:
    ownership = inspect_instance_ownership(values, allow_stopped=True)
    _path, payload = _read_instance_attestation(values)
    if payload.get("ownership") != ownership:
        raise ConfigurationError("Live Docker ownership changed; refusing the operation")
    return ownership


def reset_database(values: dict[str, str]) -> None:
    """Remove only this worktree's attested PostgreSQL container and data volume."""
    identity = instance_id(values)
    volume_name = f"{identity}_postgres-data"
    attestation_path, payload = _read_instance_attestation(values)
    attested_ownership = payload["ownership"]
    container_ids = _compose_project_containers(values)
    if len(container_ids) > 1:
        raise ConfigurationError("OpenSlate project has ambiguous PostgreSQL containers")
    if container_ids:
        live_ownership = _verify_live_instance(values)
        if (
            live_ownership != attested_ownership
            or live_ownership["container_id"] != container_ids[0]
        ):
            raise ConfigurationError("Live Docker ownership changed; refusing the reset")

    try:
        volume = _docker_json(["volume", "inspect", volume_name])[0]
        volume_is_owned = (
            volume.get("Name") == volume_name
            and _compose_resource_labels(volume, identity, "volume")
        )
    except (IndexError, AttributeError, TypeError):
        volume_is_owned = False
    if not volume_is_owned:
        raise ConfigurationError("Attested PostgreSQL data volume is unavailable or unowned")

    child_env = {
        key: value
        for key, value in os.environ.items()
        if key not in COMPOSE_EXCLUDED_KEYS and not key.startswith("COMPOSE_")
    }
    for arguments in (
        (["rm", "--force", container_ids[0]] if container_ids else None),
        ["volume", "rm", volume_name],
    ):
        if arguments is None:
            continue
        result = subprocess.run(
            ["docker", *arguments],
            cwd=ROOT,
            env=child_env,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise ConfigurationError("Scoped PostgreSQL reset could not remove an owned resource")
    attestation_path.unlink()


def _preflight_compose_mutation(
    values: dict[str, str], subcommand: str | None, arguments: list[str]
) -> None:
    if subcommand not in {
        "config", "logs", "ps", "up", "start", "stop", "restart", "rm", "down"
    }:
        raise ConfigurationError("Compose command is not supported by the attested wrapper")
    if subcommand == "ps":
        if _compose_project_containers(values):
            inspect_instance_ownership(values, allow_stopped=True)
        return
    if subcommand not in {"up", "start", "stop", "restart", "rm", "down"}:
        return
    db_targeted = (
        subcommand == "down"
        or "postgres" in arguments
        or (subcommand == "up" and "pgweb" in arguments)
        or not any(service in arguments for service in ("postgres", "pgweb", "caddy"))
    )
    if not db_targeted:
        return
    identifiers = _compose_project_containers(values)
    if identifiers:
        if len(identifiers) != 1:
            raise ConfigurationError("OpenSlate project has ambiguous PostgreSQL containers")
        if subcommand in {"stop", "restart", "rm", "down"}:
            _verify_live_instance(values)
        else:
            inspect_instance_ownership(values, allow_stopped=subcommand in {"up", "start"})
        return
    if subcommand == "down":
        identity = instance_id(values)
        volumes = _docker_output(
            ["volume", "ls", "-q", "--filter", f"name=^{identity}_postgres-data$"]
        ).splitlines()
        if volumes:
            _verify_attested_resources(values)
            return
    if subcommand in {"stop", "restart", "rm", "down"}:
        raise ConfigurationError("Owned PostgreSQL container is unavailable")
    # A named volume survives `compose rm`. Reuse it only when the existing
    # private attestation and Docker resource labels still identify this tree.
    identity = instance_id(values)
    volumes = _docker_output(
        ["volume", "ls", "-q", "--filter", f"name=^{identity}_postgres-data$"]
    ).splitlines()
    if volumes:
        _verify_attested_resources(values)
    networks = _docker_output(
        ["network", "ls", "-q", "--filter", f"name=^{identity}_default$"]
    ).splitlines()
    if networks and not volumes:
        raise ConfigurationError("Docker network exists without an owned database volume")


def write_instance_attestation(values: dict[str, str], ownership: dict[str, object]) -> Path:
    """Persist Docker-inspected ownership facts after a successful Compose operation."""
    identity = instance_id(values)
    path = ROOT / ".agent-runtime" / "instances" / f"{identity}.json"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    payload = {
        "instance_id": identity,
        "compose_project": identity,
        "postgres": {
            "host": postgres_host(values),
            "port": port(values, "POSTGRES_PORT"),
            "database": required(values, "POSTGRES_DATABASE"),
            "cluster_name": identity,
        },
        "compose": {
            "volume": f"{identity}_postgres-data",
            "network": f"{identity}_default",
        },
        "ownership": ownership,
    }
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, separators=(",", ":"), sort_keys=True)
            output.write("\n")
        temporary.chmod(0o600)
        temporary.replace(path)
        path.chmod(0o600)
        return path
    finally:
        temporary.unlink(missing_ok=True)


def write_pgweb_passfile(values: dict[str, str]) -> Path:
    """Write pgweb's credential inside an owner-only directory for its non-root mount."""
    value = database_url(values, "DATABASE_INSPECTOR_URL", "openslate_inspector")
    parsed = urlsplit(value)
    escaped_database = pgpass_field(required(values, "POSTGRES_DATABASE"), "POSTGRES_DATABASE")
    escaped_password = pgpass_field(
        unquote(parsed.password or ""), "DATABASE_INSPECTOR_URL"
    )
    directory = ROOT / ".agent-runtime" / "pgweb"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    path = directory / "pgpass"
    temporary = path.with_name("pgpass.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(
                "postgres:5432:"
                f"{escaped_database}:openslate_inspector:{escaped_password}\n"
            )
        temporary.chmod(0o644)
        temporary.replace(path)
        path.chmod(0o644)
        return path
    finally:
        temporary.unlink(missing_ok=True)


def pgpass_field(value: str, name: str) -> str:
    """Escape one PostgreSQL passfile field without admitting record separators."""
    if any(character in value for character in ("\n", "\r", "\x00")):
        raise ConfigurationError(f"Invalid database configuration: {name}")
    return value.replace("\\", "\\\\").replace(":", "\\:")


def write_caddy_config(values: dict[str, str]) -> Path:
    """Render the opt-in production gateway configuration without application secrets."""
    generator = caddy_generator()
    validate_gateway_ports(values, generator)
    linux_host_network = sys.platform.startswith("linux")
    try:
        rendered = generator.render_config(
            public_host=required(values, "GATEWAY_PUBLIC_HOST"),
            listen_address=(
                required(values, "GATEWAY_BIND_HOST") if linux_host_network else "0.0.0.0"
            ),
            https_port=(
                port(values, "GATEWAY_PORT") if linux_host_network else CADDY_CONTAINER_PORT
            ),
            health_port=CADDY_HEALTH_PORT,
            backend_port=port(values, "BACKEND_PORT"),
            tls_mode="internal",
            upstream_host="127.0.0.1" if linux_host_network else "host.docker.internal",
            require_host_namespace_separation=linux_host_network,
        )
    except (argparse.ArgumentTypeError, generator.ConfigurationError):
        raise ConfigurationError("Invalid gateway configuration") from None
    directory = ROOT / ".agent-runtime" / "caddy"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    path = directory / "Caddyfile"
    temporary = path.with_name("Caddyfile.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(rendered)
        temporary.chmod(0o644)
        temporary.replace(path)
        path.chmod(0o644)
        return path
    finally:
        temporary.unlink(missing_ok=True)


def caddy_generator() -> Any:
    """Load the checked-in production gateway generator."""
    spec = importlib.util.spec_from_file_location(
        "openslate_caddy_config", CADDY_GENERATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise ConfigurationError("Caddy configuration generator is unavailable")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    return generator


def validate_gateway_ports(values: dict[str, str], generator: Any) -> None:
    """Reject collisions in the opt-in gateway's active host namespace."""
    try:
        if sys.platform.startswith("linux"):
            generator.validate_listener_ports(
                https_port=port(values, "GATEWAY_PORT"),
                health_port=CADDY_HEALTH_PORT,
                backend_port=port(values, "BACKEND_PORT"),
                labels=("GATEWAY_PORT", "CADDY_HEALTH_PORT", "BACKEND_PORT"),
            )
        else:
            generator.validate_listener_ports(
                https_port=CADDY_CONTAINER_PORT,
                health_port=CADDY_HEALTH_PORT,
                backend_port=port(values, "BACKEND_PORT"),
                labels=("CADDY_HTTPS_PORT", "CADDY_HEALTH_PORT", "BACKEND_PORT"),
                require_host_namespace_separation=False,
            )
            if port(values, "GATEWAY_PORT") == port(values, "BACKEND_PORT"):
                raise generator.ConfigurationError("GATEWAY_PORT conflicts with BACKEND_PORT")
    except generator.ConfigurationError as error:
        raise ConfigurationError(str(error)) from None


def validate(values: dict[str, str], *, operations: bool = True) -> None:
    unknown = sorted(set(values) - ROOT_ENVIRONMENT_KEYS)
    if unknown:
        raise ConfigurationError("Unknown configuration names: " + ", ".join(unknown))
    for name in SETTINGS_KEYS:
        required(values, name)
    for name in PORT_KEYS:
        port(values, name)
    for name in (
        "POSTGRES_DATABASE",
        "BACKEND_BIND_HOST",
        "SERVER_MAX_CONCURRENCY",
        "SERVER_KEEP_ALIVE_SECONDS",
    ):
        required(values, name)
    postgres_host(values)
    if required(values, "PGWEB_BIND_HOST") != "127.0.0.1":
        raise ConfigurationError("PGWEB_BIND_HOST must remain on IPv4 loopback")
    public_origin = http_url(values, "PUBLIC_ORIGIN")
    auth_jwt_issuer = http_url(values, "AUTH_JWT_ISSUER")
    if urlsplit(http_url(values, "BACKEND_URL")).port != port(values, "BACKEND_PORT"):
        raise ConfigurationError("Configuration disagrees: BACKEND_URL and BACKEND_PORT")
    if required(values, "ENVIRONMENT") == "development" and is_loopback_bind_host(
        required(values, "BACKEND_BIND_HOST")
    ):
        frontend_port = port(values, "FRONTEND_DEV_PORT")
        if not is_local_development_origin(public_origin, frontend_port=frontend_port):
            raise ConfigurationError(
                "Development PUBLIC_ORIGIN must use a permitted local or LAN IP, "
                "and FRONTEND_DEV_PORT when BACKEND_BIND_HOST is loopback"
            )
        if auth_jwt_issuer != public_origin:
            raise ConfigurationError("Development AUTH_JWT_ISSUER must match PUBLIC_ORIGIN")
    database_url(values, "DATABASE_URL", "openslate_runtime")
    if operations:
        database_url(values, "MIGRATION_DATABASE_URL", "openslate_owner")
        database_url(values, "DATABASE_INSPECTOR_URL", "openslate_inspector")
        database_url(values, "DATABASE_BOOTSTRAP_URL", None)
        if urlsplit(required(values, "DATABASE_BOOTSTRAP_URL")).username in {
            "openslate_inspector",
            "openslate_owner",
            "openslate_runtime",
        }:
            raise ConfigurationError("DATABASE_BOOTSTRAP_URL must use a cluster-admin login")
    absolute_path(values, "LOG_DIR")
    absolute_path(values, "FILES_STORAGE_ROOT")
    instance_id(values)
    if "WEB_ASSETS_ROOT" in values:
        absolute_path(values, "WEB_ASSETS_ROOT")
    from pydantic import ValidationError

    from app.core.config import Settings

    inputs: dict[str, object] = {name.lower(): values[name] for name in SETTINGS_KEYS}
    if "WEB_ASSETS_ROOT" in values:
        inputs["web_assets_root"] = values["WEB_ASSETS_ROOT"]
    for name in SMTP_KEYS:
        if name in values:
            inputs[name.lower()] = values[name]
    try:
        Settings.model_validate(inputs)
    except ValidationError as error:
        names = sorted(
            {
                str(item["loc"][0]).upper()
                for item in error.errors(include_input=False)
                if item["loc"]
            }
        )
        raise ConfigurationError(
            "Invalid configuration: " + (", ".join(names) if names else "settings")
        ) from None


def write_environment(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    lines = ["# Generated from the root .env; do not edit this file."]
    for name, value in values.items():
        quoted = (
            value.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        )
        lines.append(f'{name}="{quoted}"')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def compose_subcommand(arguments: list[str]) -> str | None:
    """Return a supported Compose subcommand without interpreting option values as commands."""
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in COMPOSE_GLOBAL_OPTIONS_WITH_VALUE:
            if index + 1 >= len(arguments) or arguments[index + 1].startswith("-"):
                return None
            index += 2
            continue
        if argument.startswith("--profile="):
            if not argument.partition("=")[2]:
                return None
            index += 1
            continue
        if argument.startswith("-"):
            return None
        return argument
    return None


def reject_compose_scope_overrides(arguments: list[str]) -> None:
    """Keep the wrapper's repository file, environment and Compose project authoritative."""
    if compose_subcommand(arguments) == "down" and any(
        argument in {"-v", "--volumes"}
        or argument.startswith(("--volumes=", "-v="))
        for argument in arguments
    ):
        raise ConfigurationError("Use reset-database to remove only the PostgreSQL volume")
    forbidden = {"-p", "--project-name", "--project-directory", "--env-file", "-f", "--file"}
    if any(
        argument in forbidden
        or (argument.startswith("-p") and argument != "-p")
        or (argument.startswith("-f") and argument != "-f")
        or argument.startswith(("--project-name=", "--project-directory=", "--env-file="))
        or argument.startswith("--file=")
        for argument in arguments
    ):
        raise ConfigurationError(
            "Compose project, file and environment overrides are not supported"
        )


def compose_files(arguments: list[str]) -> list[Path]:
    """Use the host-network overlay only for the opt-in Caddy profile on Linux."""
    files = [ROOT / "compose.yaml"]
    gateway_profile = any(
        arguments[index : index + 2] == ["--profile", "gateway"]
        or arguments[index] == "--profile=gateway"
        for index in range(len(arguments))
    )
    if sys.platform.startswith("linux") and (gateway_profile or "caddy" in arguments):
        files.append(LINUX_CADDY_COMPOSE_PATH)
    return files


def run_compose(
    arguments: list[str], projected: dict[str, str], root_values: dict[str, str]
) -> int:
    """Invoke Compose with generated values winning over root and inherited settings."""
    child_env = {
        name: value
        for name, value in os.environ.items()
        if name not in root_values
        and name not in COMPOSE_EXCLUDED_KEYS
        and not name.startswith("COMPOSE_")
    }
    child_env.update(projected)
    compose_file_arguments = [
        option
        for path in compose_files(arguments)
        for option in ("-f", str(path))
    ]
    return subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            os.devnull,
            "--project-name",
            projected["OPENSLATE_INSTANCE_ID"],
            *compose_file_arguments,
            *arguments,
        ],
        cwd=ROOT,
        env=child_env,
        check=False,
    ).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "compose", "reset-database"))
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.command == "compose":
            if not args.arguments:
                parser.error(
                    "compose requires Docker Compose arguments, for example: config --quiet"
                )
            reject_compose_scope_overrides(args.arguments)
        values = read_environment(ROOT / ".env")
        if args.command == "reset-database":
            if args.arguments:
                parser.error("reset-database does not accept extra arguments")
            reset_database(values)
            print(
                "Removed this worktree's attested disposable PostgreSQL container and data volume."
            )
            return 0
        if args.command == "check":
            validate(values)
            if args.arguments:
                parser.error("check does not accept extra arguments")
            print("Environment configuration is valid; scanner provisioning is a separate check.")
            return 0
        services = {name for name in ("postgres", "pgweb", "caddy") if name in args.arguments}
        projected = compose_environment(values, services=services)
        subcommand = compose_subcommand(args.arguments)
        _preflight_compose_mutation(values, subcommand, args.arguments)
        if "pgweb" in services:
            projected["PGWEB_PASSFILE_PATH"] = str(write_pgweb_passfile(values))
        if "caddy" in services:
            projected["CADDY_CONFIG_PATH"] = str(write_caddy_config(values))
        result = run_compose(args.arguments, projected, values)
        if result == 0 and subcommand in {"up", "start"} and (
            "postgres" in args.arguments
            or (subcommand == "up" and "pgweb" in args.arguments)
            or not services
        ):
            write_instance_attestation(values, inspect_instance_ownership(values))
        return result
    except (ConfigurationError, OSError) as error:
        print(
            str(error)
            if isinstance(error, ConfigurationError)
            else "Environment configuration file could not be read or written.",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
