"""Project the private root environment into narrow runtime environments."""

from __future__ import annotations

import argparse
import importlib.util
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
CADDY_GENERATOR_PATH = ROOT / "infra" / "caddy" / "generate_config.py"
LINUX_CADDY_COMPOSE_PATH = ROOT / "infra" / "caddy" / "compose.linux.yaml"
SUPABASE_COMPOSE_PATH = ROOT / "infra" / "supabase" / "compose.yaml"
SUPABASE_DEV_COMPOSE_PATH = ROOT / "infra" / "supabase" / "compose.dev.yaml"
CADDY_CONTAINER_PORT = 3448
CADDY_HEALTH_PORT = 3449
COMPOSE_GLOBAL_OPTIONS_WITH_VALUE = frozenset({"--profile"})
INSTANCE_ID = re.compile(r"[a-z][a-z0-9-]{2,62}\Z")
sys.path.insert(0, str(ROOT / "backend"))

from app.core.config.development import is_local_development_host  # noqa: E402
from app.core.config.disposable_instance import SUPABASE_DB_IMAGE  # noqa: E402
from app.core.config.environment import (  # noqa: E402
    ConfigurationError,
    read_environment,
    with_realtime_publisher,
)

__all__ = ("ConfigurationError", "read_environment")

SETTINGS_KEYS = (
    "ENVIRONMENT",
    "LOG_DIR",
    "DATABASE_URL",
    "SUPABASE_URL",
    "REALTIME_PUBLISH_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_AUTH_ISSUER",
    "SUPABASE_SESSION_ENCRYPTION_KEY",
    "SUPABASE_TIMEOUT_SECONDS",
    "PUBLICATION_SIGNING_KEY",
    "REALTIME_TOKEN_SIGNING_KEY",
    "AUTH_REFRESH_TOKEN_DAYS",
    "SECURITY_EVENT_SERVER_KEY",
    "LIFECYCLE_PURGE_ENABLED",
    "PUBLIC_ORIGIN",
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
PROVIDER_KEYS = (
    "POSTGRES_PASSWORD",
    "JWT_SECRET",
    "JWT_KEYS",
    "JWT_JWKS",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "ANON_KEY_ASYMMETRIC",
    "SERVICE_ROLE_KEY_ASYMMETRIC",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "PG_META_CRYPTO_KEY",
    "REALTIME_SECRET_KEY_BASE",
    "REALTIME_DB_ENC_KEY",
    "DASHBOARD_USERNAME",
    "DASHBOARD_PASSWORD",
    "SMTP_ADMIN_EMAIL",
    "SMTP_HOST",
    "SMTP_PORT",
    "API_EXTERNAL_URL",
    "SUPABASE_PUBLIC_URL",
    "SITE_URL",
    "AUTH_TEMPLATE_BASE_URL",
)
PROVIDER_OPTIONAL_KEYS = (
    "SMTP_USER",
    "SMTP_PASS",
    "SMTP_SENDER_NAME",
    "STUDIO_DEFAULT_ORGANIZATION",
    "STUDIO_DEFAULT_PROJECT",
    "JWT_EXPIRY",
)
ROOT_ENVIRONMENT_KEYS = frozenset(
    (
        *SETTINGS_KEYS,
        *PROVIDER_KEYS,
        *PROVIDER_OPTIONAL_KEYS,
        "POSTGRES_HOST",
        "OPENSLATE_INSTANCE_ID",
        "OPENSLATE_INSTANCE_ROOT",
        "POSTGRES_PORT",
        "POSTGRES_DATABASE",
        "FRONTEND_DEV_PORT",
        "WEB_ASSETS_ROOT",
        "BACKUP_EXPORT_ROOT",
        "OPENSLATE_BACKUP_EXPORT_ROOT",
        "SUPABASE_DB_PORT",
        "SUPABASE_API_PORT",
        "SUPABASE_REALTIME_PUBLISH_PORT",
        "SUPABASE_MAIL_PORT",
        "GATEWAY_PUBLIC_HOST",
        "GATEWAY_BIND_HOST",
        "GATEWAY_PORT",
        # Optional: production Caddy/API private network and trusted proxy CIDR.
        "OPENSLATE_APP_PRIVATE_SUBNET",
        "BACKEND_URL",
        "DATABASE_BOOTSTRAP_URL",
        "MIGRATION_DATABASE_URL",
        "ADMIN_EMAIL",
        "ADMIN_USERNAME",
        "SEED_ACCESS_TOKEN",
    )
)
DOCKER_PROCESS_KEYS = frozenset(
    {
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "LANG",
        "LC_ALL",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "DOCKER_CERT_PATH",
        "DOCKER_TLS_VERIFY",
        "DOCKER_API_VERSION",
        "SSL_CERT_FILE",
    }
)
PORT_KEYS = (
    "FRONTEND_DEV_PORT",
    "BACKEND_PORT",
    "POSTGRES_PORT",
    "SUPABASE_DB_PORT",
    "SUPABASE_API_PORT",
    "SUPABASE_MAIL_PORT",
    "SMTP_PORT",
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
            and parsed.port == port(values, "SUPABASE_DB_PORT")
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
    result = {"OPENSLATE_INSTANCE_ID": instance_id(values)}
    if "caddy" not in services:
        postgres_host(values)
        result.update({name: required(values, name) for name in PROVIDER_KEYS})
        result.update({name: values[name] for name in PROVIDER_OPTIONAL_KEYS if name in values})
        result.update(
            {
                name: str(port(values, name))
                for name in ("SUPABASE_DB_PORT", "SUPABASE_API_PORT", "SUPABASE_MAIL_PORT")
            }
        )
        if "SUPABASE_REALTIME_PUBLISH_PORT" in values:
            result["SUPABASE_REALTIME_PUBLISH_PORT"] = str(
                port(values, "SUPABASE_REALTIME_PUBLISH_PORT")
            )
    if "caddy" in services:
        result.update(
            {
                "GATEWAY_BIND_HOST": required(values, "GATEWAY_BIND_HOST"),
                "GATEWAY_PORT": str(port(values, "GATEWAY_PORT")),
                "SUPABASE_API_PORT": str(port(values, "SUPABASE_API_PORT")),
                "SUPABASE_PUBLISHABLE_KEY": required(values, "SUPABASE_PUBLISHABLE_KEY"),
            }
        )
    return result


def instance_id(values: dict[str, str]) -> str:
    """Validate the Compose namespace shared by the container, network and volume."""
    value = required(values, "OPENSLATE_INSTANCE_ID")
    if INSTANCE_ID.fullmatch(value) is None:
        raise ConfigurationError("OPENSLATE_INSTANCE_ID must be a lowercase Compose identifier")
    root = Path(absolute_path(values, "OPENSLATE_INSTANCE_ROOT"))
    for name in ("LOG_DIR",):
        try:
            Path(absolute_path(values, name)).relative_to(root)
        except ValueError:
            raise ConfigurationError(f"{name} must be inside OPENSLATE_INSTANCE_ROOT") from None
    return value


def _docker_output(arguments: list[str]) -> str:
    child_env = docker_process_environment()
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
    projected = compose_environment(values, services={"db"})
    child_env = docker_process_environment()
    child_env.update(projected)
    command = [
        "docker",
        "compose",
        "--env-file",
        os.devnull,
        "--project-directory",
        str(SUPABASE_COMPOSE_PATH.parent),
        "--project-name",
        identity,
        "-f",
        str(SUPABASE_COMPOSE_PATH),
        "-f",
        str(SUPABASE_DEV_COMPOSE_PATH),
        "ps",
        "--all",
        "-q",
        "db",
    ]
    result = subprocess.run(
        command, cwd=ROOT, env=child_env, capture_output=True, text=True, check=False
    )
    if result.returncode:
        raise ConfigurationError("Docker ownership could not be verified")
    return [value for value in result.stdout.splitlines() if value]


def _compose_resource_labels(resource: dict[str, Any], identity: str, kind: str) -> bool:
    labels = resource.get("Labels")
    expected = "supabase-db-data" if kind == "volume" else "provider"
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
        raise ConfigurationError("Owned Supabase database container is unavailable or ambiguous")
    inspected = _docker_json(["inspect", identifiers[0]])
    try:
        container = inspected[0]
        config = container["Config"]
        labels = config["Labels"]
        mounts = container["Mounts"]
        networks = container["NetworkSettings"]["Networks"]
        network = networks[f"{identity}_provider"]
        attached_network_id = network["NetworkID"]
        bound_ports = container["HostConfig"]["PortBindings"]["5432/tcp"]
        data_mounts = [
            mount
            for mount in mounts
            if mount.get("Type") == "volume"
            and mount.get("Destination") == "/var/lib/postgresql/data"
        ]
        network_resource = _docker_json(["network", "inspect", f"{identity}_provider"])[0]
        volume_resource = _docker_json(["volume", "inspect", f"{identity}_supabase-db-data"])[0]
        network_id = network_resource["Id"]
        volume_labels_match = _compose_resource_labels(volume_resource, identity, "volume")
        network_labels_match = _compose_resource_labels(network_resource, identity, "network")
        expected_port = str(port(values, "SUPABASE_DB_PORT"))
        owned = (
            labels.get("com.docker.compose.project") == identity
            and labels.get("com.docker.compose.project.working_dir")
            == str(SUPABASE_COMPOSE_PATH.parent)
            and labels.get("com.docker.compose.service") == "db"
            and config.get("Image") == SUPABASE_DB_IMAGE
            and (
                container["State"]["Running"] is True
                or (allow_stopped and container["State"]["Running"] is False)
            )
            and len(data_mounts) == 1
            and data_mounts[0].get("Name") == f"{identity}_supabase-db-data"
            and len(bound_ports) == 1
            and bound_ports[0] == {"HostIp": "127.0.0.1", "HostPort": expected_port}
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
        "working_dir": str(SUPABASE_COMPOSE_PATH.parent),
        "compose_project": identity,
        "network": f"{identity}_provider",
        "network_id": network_id,
        "volume": f"{identity}_supabase-db-data",
        "host_port": port(values, "SUPABASE_DB_PORT"),
        "container_port": 5432,
    }


def _read_instance_attestation(values: dict[str, str]) -> tuple[Path, dict[str, Any]]:
    identity = instance_id(values)
    path = ROOT / ".agent-runtime" / "instances" / f"{identity}.json"
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or (os.name != "nt" and metadata.st_mode & 0o077):
            raise ValueError
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        raise ConfigurationError(
            "OpenSlate instance attestation is unavailable or invalid"
        ) from None
    if (
        not isinstance(payload, dict)
        or payload.get("version") != 2
        or payload.get("instance_id") != identity
        or payload.get("compose_project") != identity
        or payload.get("postgres")
        != {
            "host": postgres_host(values),
            "port": port(values, "SUPABASE_DB_PORT"),
            "database": required(values, "POSTGRES_DATABASE"),
            "cluster_name": identity,
        }
        or payload.get("compose")
        != {
            "volume": f"{identity}_supabase-db-data",
            "network": f"{identity}_provider",
        }
        or not isinstance(payload.get("ownership"), dict)
        or payload["ownership"].get("volume") != f"{identity}_supabase-db-data"
        or payload["ownership"].get("network") != f"{identity}_provider"
        or payload["ownership"].get("image") != SUPABASE_DB_IMAGE
        or payload["ownership"].get("working_dir") != str(SUPABASE_COMPOSE_PATH.parent)
    ):
        raise ConfigurationError("OpenSlate instance attestation is unavailable or invalid")
    return path, payload


def _verify_attested_resources(values: dict[str, str]) -> None:
    """Bind a retained database volume and any surviving network to this worktree."""
    identity = instance_id(values)
    _path, payload = _read_instance_attestation(values)
    ownership = payload["ownership"]
    volume_name = f"{identity}_supabase-db-data"
    network_ids = _docker_output(
        ["network", "ls", "-q", "--filter", f"name=^{identity}_provider$"]
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


def _reject_legacy_resources(values: dict[str, str]) -> None:
    """A previous standalone database cannot share the new installation identity."""
    identity = instance_id(values)
    attestation = ROOT / ".agent-runtime" / "instances" / f"{identity}.json"
    if attestation.exists() or attestation.is_symlink():
        _read_instance_attestation(values)
    old_volume = _docker_output(
        ["volume", "ls", "-q", "--filter", f"name=^{identity}_postgres-data$"]
    ).splitlines()
    old_container = _docker_output(
        [
            "ps",
            "-a",
            "-q",
            "--filter",
            f"label=com.docker.compose.project={identity}",
            "--filter",
            "label=com.docker.compose.service=postgres",
        ]
    ).splitlines()
    if old_volume or old_container:
        raise ConfigurationError("A legacy PostgreSQL project uses this installation identity")


def _preflight_compose_mutation(
    values: dict[str, str], subcommand: str | None, arguments: list[str]
) -> None:
    if subcommand not in {"config", "logs", "ps", "up", "start", "stop", "restart", "down"}:
        raise ConfigurationError("Compose command is not supported by the attested wrapper")
    if subcommand == "ps":
        if _compose_project_containers(values):
            inspect_instance_ownership(values, allow_stopped=True)
        return
    if subcommand not in {"up", "start", "stop", "restart", "down"}:
        return
    _reject_legacy_resources(values)
    identifiers = _compose_project_containers(values)
    if identifiers:
        if len(identifiers) != 1:
            raise ConfigurationError("OpenSlate project has ambiguous Supabase database containers")
        if subcommand in {"stop", "restart", "down", "start", "up"}:
            _verify_live_instance(values)
        return
    if subcommand == "down":
        identity = instance_id(values)
        volumes = _docker_output(
            ["volume", "ls", "-q", "--filter", f"name=^{identity}_supabase-db-data$"]
        ).splitlines()
        if volumes:
            _verify_attested_resources(values)
            return
    if subcommand in {"stop", "restart", "rm", "down"}:
        raise ConfigurationError("Owned Supabase database container is unavailable")
    # A named volume survives `compose rm`. Reuse it only when the existing
    # private attestation and Docker resource labels still identify this tree.
    identity = instance_id(values)
    volumes = _docker_output(
        ["volume", "ls", "-q", "--filter", f"name=^{identity}_supabase-db-data$"]
    ).splitlines()
    if volumes:
        _verify_attested_resources(values)
    networks = _docker_output(
        ["network", "ls", "-q", "--filter", f"name=^{identity}_provider$"]
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
        "version": 2,
        "instance_id": identity,
        "compose_project": identity,
        "postgres": {
            "host": postgres_host(values),
            "port": port(values, "SUPABASE_DB_PORT"),
            "database": required(values, "POSTGRES_DATABASE"),
            "cluster_name": identity,
        },
        "compose": {
            "volume": f"{identity}_supabase-db-data",
            "network": f"{identity}_provider",
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
    spec = importlib.util.spec_from_file_location("openslate_caddy_config", CADDY_GENERATOR_PATH)
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
    values = with_realtime_publisher(values)
    unknown = sorted(set(values) - ROOT_ENVIRONMENT_KEYS)
    if unknown:
        raise ConfigurationError("Unknown configuration names: " + ", ".join(unknown))
    for name in SETTINGS_KEYS:
        required(values, name)
    for name in PROVIDER_KEYS:
        required(values, name)
    for name in PORT_KEYS:
        port(values, name)
    if "SUPABASE_REALTIME_PUBLISH_PORT" in values:
        port(values, "SUPABASE_REALTIME_PUBLISH_PORT")
    for name in (
        "POSTGRES_DATABASE",
        "BACKEND_BIND_HOST",
        "SERVER_MAX_CONCURRENCY",
        "SERVER_KEEP_ALIVE_SECONDS",
    ):
        required(values, name)
    postgres_host(values)
    if port(values, "POSTGRES_PORT") != port(values, "SUPABASE_DB_PORT"):
        raise ConfigurationError("POSTGRES_PORT must match SUPABASE_DB_PORT")
    if required(values, "POSTGRES_DATABASE") != "postgres":
        raise ConfigurationError("Supabase database name must be postgres")
    public_origin = http_url(values, "PUBLIC_ORIGIN")
    if http_url(values, "API_EXTERNAL_URL") != http_url(values, "SUPABASE_AUTH_ISSUER"):
        raise ConfigurationError("API_EXTERNAL_URL must match SUPABASE_AUTH_ISSUER")
    if http_url(values, "SITE_URL") != public_origin:
        raise ConfigurationError("SITE_URL must match PUBLIC_ORIGIN")
    supabase_public_url = http_url(values, "SUPABASE_PUBLIC_URL")
    http_url(values, "AUTH_TEMPLATE_BASE_URL")
    supabase_url = http_url(values, "SUPABASE_URL")
    supabase_endpoint = urlsplit(supabase_url)
    if required(values, "ENVIRONMENT") == "development" and (
        supabase_endpoint.hostname not in {"127.0.0.1", "localhost"}
        or supabase_endpoint.port != port(values, "SUPABASE_API_PORT")
    ):
        raise ConfigurationError("Development SUPABASE_URL must target the owned loopback API")
    if required(values, "ENVIRONMENT") == "development" and (
        supabase_public_url != supabase_url
        or http_url(values, "SUPABASE_AUTH_ISSUER") != f"{supabase_url.rstrip('/')}/auth/v1"
    ):
        raise ConfigurationError("Development Supabase URLs must identify one gateway")
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
    database_url(values, "DATABASE_URL", "openslate_runtime")
    if operations:
        database_url(values, "MIGRATION_DATABASE_URL", "openslate_owner")
        database_url(values, "DATABASE_BOOTSTRAP_URL", "supabase_admin")
        if urlsplit(required(values, "DATABASE_BOOTSTRAP_URL")).username in {
            "openslate_owner",
            "openslate_runtime",
        }:
            raise ConfigurationError("DATABASE_BOOTSTRAP_URL must use a cluster-admin login")
    absolute_path(values, "LOG_DIR")
    instance_id(values)
    for name in ("WEB_ASSETS_ROOT", "BACKUP_EXPORT_ROOT", "OPENSLATE_BACKUP_EXPORT_ROOT"):
        if name in values:
            absolute_path(values, name)
    from pydantic import ValidationError

    from app.core.config import Settings

    inputs: dict[str, object] = {name.lower(): values[name] for name in SETTINGS_KEYS}
    for name in ("WEB_ASSETS_ROOT", "BACKUP_EXPORT_ROOT"):
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
    subcommand = compose_subcommand(arguments)
    if subcommand not in {"config", "logs", "ps", "up", "start", "stop", "restart", "down"}:
        raise ConfigurationError("Compose command is not supported by the attested wrapper")
    if subcommand == "config" and arguments != ["config", "--quiet"]:
        raise ConfigurationError("Compose configuration may be checked only with --quiet")
    if compose_subcommand(arguments) == "down" and any(
        argument in {"-v", "--volumes"} or argument.startswith(("--volumes=", "-v="))
        for argument in arguments
    ):
        raise ConfigurationError("Removing installation volumes through Compose is unsupported")
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
    """Select the pinned provider stack or independent opt-in Caddy artifact."""
    gateway_profile = any(
        arguments[index : index + 2] == ["--profile", "gateway"]
        or arguments[index] == "--profile=gateway"
        for index in range(len(arguments))
    )
    if gateway_profile or "caddy" in arguments:
        files = [ROOT / "compose.yaml"]
        if sys.platform.startswith("linux"):
            files.append(LINUX_CADDY_COMPOSE_PATH)
        return files
    return [SUPABASE_COMPOSE_PATH, SUPABASE_DEV_COMPOSE_PATH]


def run_compose(arguments: list[str], projected: dict[str, str]) -> int:
    """Invoke Compose with generated values winning over root and inherited settings."""
    child_env = docker_process_environment()
    child_env.update(projected)
    compose_file_arguments = [
        option for path in compose_files(arguments) for option in ("-f", str(path))
    ]
    return subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            os.devnull,
            "--project-directory",
            str(compose_files(arguments)[0].parent),
            "--project-name",
            projected["OPENSLATE_INSTANCE_ID"],
            *compose_file_arguments,
            *arguments,
        ],
        cwd=ROOT,
        env=child_env,
        check=False,
    ).returncode


def docker_process_environment() -> dict[str, str]:
    """Pass Docker only the operating-system and selected Docker client settings."""
    return {name: value for name, value in os.environ.items() if name in DOCKER_PROCESS_KEYS}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("command", choices=("check", "compose"))
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.command == "compose":
            if not args.arguments:
                parser.error(
                    "compose requires Docker Compose arguments, for example: config --quiet"
                )
            reject_compose_scope_overrides(args.arguments)
        metadata = args.env_file.lstat()
        if not stat.S_ISREG(metadata.st_mode) or (os.name != "nt" and metadata.st_mode & 0o077):
            raise ConfigurationError("Installation environment file must be owner-only")
        values = read_environment(args.env_file)
        validate(values)
        if args.command == "check":
            if args.arguments:
                parser.error("check does not accept extra arguments")
            print("Environment configuration is valid.")
            return 0
        services = {"caddy"} if "caddy" in args.arguments or "gateway" in args.arguments else {"db"}
        if "caddy" not in services and required(values, "ENVIRONMENT") != "development":
            raise ConfigurationError("The local Supabase Compose wrapper requires development mode")
        projected = compose_environment(values, services=services)
        subcommand = compose_subcommand(args.arguments)
        if "caddy" not in services:
            _preflight_compose_mutation(values, subcommand, args.arguments)
        if "caddy" in services:
            projected["CADDY_CONFIG_PATH"] = str(write_caddy_config(values))
        result = run_compose(args.arguments, projected)
        if subcommand in {"up", "start"} and "caddy" not in services:
            try:
                ownership = inspect_instance_ownership(values)
            except ConfigurationError:
                if result == 0:
                    raise
            else:
                write_instance_attestation(values, ownership)
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
