"""Project the private root environment into narrow runtime environments."""

from __future__ import annotations

import argparse
import importlib.util
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
COMPOSE_CONTROL_PASSWORD = "compose-control-only"
COMPOSE_GLOBAL_OPTIONS_WITH_VALUE = frozenset({"--profile"})
sys.path.insert(0, str(ROOT / "backend"))

from app.core.config.environment import ConfigurationError, read_environment  # noqa: E402

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
    "CORS_ORIGINS",
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
        "POSTGRES_PORT",
        "POSTGRES_DATABASE",
        "FRONTEND_BIND_HOST",
        "FRONTEND_PORT",
        "FILES_CLAMAV_PORT",
        "PGWEB_BIND_HOST",
        "PGWEB_PORT",
        "GATEWAY_PUBLIC_HOST",
        "GATEWAY_BIND_HOST",
        "GATEWAY_PORT",
        "FRONTEND_URL",
        "BACKEND_URL",
        "DATABASE_BOOTSTRAP_URL",
        "MIGRATION_DATABASE_URL",
        "DATABASE_INSPECTOR_URL",
        "POSTGRES_BOOTSTRAP_PASSWORD",
        "ADMIN_EMAIL",
        "ADMIN_USERNAME",
        "ADMIN_PASSWORD",
        "SEED_ACCESS_TOKEN",
        "FRONTEND_LOG_DIR",
        "CONTAINER_BIND_HOST",
        "CONTAINER_LOG_DIR",
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
    "FRONTEND_PORT",
    "BACKEND_PORT",
    "POSTGRES_PORT",
    "PGWEB_PORT",
    "GATEWAY_PORT",
    "FILES_CLAMAV_PORT",
)
LEGACY_KEYS = frozenset(
    {
        "COMPOSE_DATABASE_URL",
    }
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


def frontend_environment(values: dict[str, str], *, container: bool = False) -> dict[str, str]:
    result = {
        "BACKEND_URL": http_url(values, "BACKEND_URL"),
        "LOG_DIR": absolute_path(values, "FRONTEND_LOG_DIR"),
        "PORT": str(port(values, "FRONTEND_PORT")),
        "HOSTNAME": required(values, "FRONTEND_BIND_HOST"),
        "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED": required(values, "LIFECYCLE_PURGE_ENABLED"),
    }
    if result["NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED"] not in {"true", "false"}:
        raise ConfigurationError(
            "Expected true or false for configuration: LIFECYCLE_PURGE_ENABLED"
        )
    if container:
        result["LOG_DIR"] = absolute_path(values, "CONTAINER_LOG_DIR")
        result["HOSTNAME"] = required(values, "CONTAINER_BIND_HOST")
    return result


def compose_environment(values: dict[str, str], *, services: set[str]) -> dict[str, str]:
    """Project only the settings consumed by the selected Compose services."""
    postgres_host(values)
    result = {
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
    """Render the container gateway configuration without exposing application secrets."""
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
            frontend_port=port(values, "FRONTEND_PORT"),
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
    """Load the checked-in generator shared by validation and rendering."""
    spec = importlib.util.spec_from_file_location(
        "openslate_caddy_config", CADDY_GENERATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise ConfigurationError("Caddy configuration generator is unavailable")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    return generator


def validate_gateway_ports(values: dict[str, str], generator: Any) -> None:
    """Reject host-port collisions before a gateway config reaches Compose."""
    try:
        if sys.platform.startswith("linux"):
            generator.validate_listener_ports(
                https_port=port(values, "GATEWAY_PORT"),
                health_port=CADDY_HEALTH_PORT,
                backend_port=port(values, "BACKEND_PORT"),
                frontend_port=port(values, "FRONTEND_PORT"),
                labels=(
                    "GATEWAY_PORT",
                    "CADDY_HEALTH_PORT",
                    "BACKEND_PORT",
                    "FRONTEND_PORT",
                ),
            )
        else:
            generator.validate_listener_ports(
                https_port=CADDY_CONTAINER_PORT,
                health_port=CADDY_HEALTH_PORT,
                backend_port=port(values, "BACKEND_PORT"),
                frontend_port=port(values, "FRONTEND_PORT"),
                labels=(
                    "CADDY_HTTPS_PORT",
                    "CADDY_HEALTH_PORT",
                    "BACKEND_PORT",
                    "FRONTEND_PORT",
                ),
                require_host_namespace_separation=False,
                published_gateway_port=port(values, "GATEWAY_PORT"),
            )
    except generator.ConfigurationError as error:
        raise ConfigurationError(str(error)) from None


def validate(values: dict[str, str], *, operations: bool = True) -> None:
    legacy = sorted(LEGACY_KEYS.intersection(values))
    if legacy:
        raise ConfigurationError("Remove retired configuration names: " + ", ".join(legacy))
    for name in SETTINGS_KEYS:
        required(values, name)
    frontend_environment(values)
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
    http_url(values, "PUBLIC_ORIGIN")
    http_url(values, "AUTH_JWT_ISSUER")
    if urlsplit(http_url(values, "FRONTEND_URL")).port != port(values, "FRONTEND_PORT"):
        raise ConfigurationError("Configuration disagrees: FRONTEND_URL and FRONTEND_PORT")
    if urlsplit(http_url(values, "BACKEND_URL")).port != port(values, "BACKEND_PORT"):
        raise ConfigurationError("Configuration disagrees: BACKEND_URL and BACKEND_PORT")
    public_origin = urlsplit(http_url(values, "PUBLIC_ORIGIN"))
    if (
        public_origin.scheme != "https"
        or public_origin.hostname != required(values, "GATEWAY_PUBLIC_HOST").casefold()
        or public_origin.port != port(values, "GATEWAY_PORT")
    ):
        raise ConfigurationError("Configuration disagrees: PUBLIC_ORIGIN and gateway settings")
    validate_gateway_ports(values, caddy_generator())
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
    from pydantic import ValidationError

    from app.core.config import Settings

    inputs: dict[str, object] = {name.lower(): values[name] for name in SETTINGS_KEYS}
    for name in SMTP_KEYS:
        if name in values:
            inputs[name.lower()] = values[name]
    try:
        inputs["cors_origins"] = json.loads(values["CORS_ORIGINS"])
        Settings.model_validate(inputs)
    except (ValidationError, ValueError) as error:
        if isinstance(error, ValidationError):
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
        raise ConfigurationError("Invalid configuration: CORS_ORIGINS") from None


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


def compose_control_environment() -> dict[str, str]:
    """Provide inert interpolation values for Compose commands that cannot start services."""
    return {
        "POSTGRES_DATABASE": "openslate",
        "POSTGRES_BOOTSTRAP_PASSWORD": COMPOSE_CONTROL_PASSWORD,
        "POSTGRES_PORT": "54322",
    }


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


def compose_files(arguments: list[str]) -> list[Path]:
    """Select the Linux host-network overlay whenever Compose manages Caddy."""
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
        if name not in root_values and name not in COMPOSE_EXCLUDED_KEYS
    }
    child_env.update(projected)
    compose_file_arguments = [
        option
        for path in compose_files(arguments)
        for option in ("-f", str(path))
    ]
    return subprocess.run(
        ["docker", "compose", "--env-file", os.devnull, *compose_file_arguments, *arguments],
        cwd=ROOT,
        env=child_env,
        check=False,
    ).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "frontend", "compose"))
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.command == "compose":
            if not args.arguments:
                parser.error(
                    "compose requires Docker Compose arguments, for example: config --quiet"
                )
            if compose_subcommand(args.arguments) in {"ps", "stop"}:
                return run_compose(args.arguments, compose_control_environment(), {})

        values = read_environment(ROOT / ".env")
        if args.command == "frontend":
            write_environment(ROOT / "frontend/.env.local", frontend_environment(values))
            print("Frontend environment refreshed from root .env (no backend or database secrets).")
            return 0
        if args.command == "check":
            validate(values)
            if args.arguments:
                parser.error("check does not accept extra arguments")
            print("Environment configuration is valid; scanner provisioning is a separate check.")
            return 0
        services = {name for name in ("postgres", "pgweb", "caddy") if name in args.arguments}
        projected = compose_environment(values, services=services)
        if "pgweb" in services:
            projected["PGWEB_PASSFILE_PATH"] = str(write_pgweb_passfile(values))
        if "caddy" in services:
            projected["CADDY_CONFIG_PATH"] = str(write_caddy_config(values))
        return run_compose(args.arguments, projected, values)
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
