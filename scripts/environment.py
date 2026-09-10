"""Project the one private root .env into explicit, scoped runtime environments.

Run with the backend's uv environment. Never print a projected environment.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.core.config.environment import ConfigurationError, read_environment  # noqa: E402

API_KEYS = (
    "ENVIRONMENT", "LOG_DIR", "DATABASE_URL", "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_AUTH_REDIRECT_URL",
    "SUPABASE_JWT_ISSUER", "SUPABASE_JWKS_URL", "SUPABASE_JWT_AUDIENCE",
    "SECURITY_EVENT_SERVER_KEY", "LIFECYCLE_PURGE_ENABLED", "CORS_ORIGINS",
    "REQUEST_BODY_MAX_BYTES", "DATABASE_POOL_SIZE", "DATABASE_MAX_OVERFLOW",
    "DATABASE_POOL_TIMEOUT_SECONDS", "DATABASE_CONNECT_TIMEOUT_SECONDS",
    "DATABASE_STATEMENT_TIMEOUT_MS", "READINESS_POOL_TIMEOUT_SECONDS",
    "READINESS_CONNECT_TIMEOUT_SECONDS", "READINESS_STATEMENT_TIMEOUT_MS",
    "READINESS_CALLER_TIMEOUT_SECONDS", "SUPABASE_TIMEOUT_SECONDS",
    "BACKEND_BIND_HOST", "BACKEND_PORT", "SERVER_MAX_CONCURRENCY", "SERVER_KEEP_ALIVE_SECONDS",
)
FRONTEND_LIMITS = (
    "BFF_REQUEST_BODY_LIMIT_BYTES", "BFF_RESPONSE_BODY_LIMIT_BYTES", "BFF_REQUEST_DEADLINE_MS",
)
PORT_KEYS = (
    "FRONTEND_PORT", "BACKEND_PORT", "SUPABASE_API_PORT", "SUPABASE_DB_PORT",
    "SUPABASE_SHADOW_PORT", "SUPABASE_STUDIO_PORT", "SUPABASE_MAIL_PORT",
    "SUPABASE_POOLER_PORT", "FILES_CLAMAV_PORT",
)
LEGACY_KEYS = frozenset({
    "SUPABASE_ANON_KEY", "SUPABASE_AUDIENCE", "COMPOSE_DATABASE_URL",
    "OPENSLATE_DATABASE_PASSWORD", "ADMIN_BOOTSTRAP_USERNAME", "ADMIN_BOOTSTRAP_PASSWORD",
    "SAMPLE_EMAIL", "SAMPLE_PASSWORD", "APP_PORT", "POSTGRES_PORT", "POSTGRES_DB",
    "POSTGRES_USER", "POSTGRES_PASSWORD", "SECRET_KEY", "API_BASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED", "BOOTSTRAP_ADMIN_CONFIRM",
})


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
        parsed.port
    except ValueError:
        raise ConfigurationError(f"Invalid HTTP URL configuration: {name}") from None
    return value


def boolean(values: dict[str, str], name: str) -> str:
    value = required(values, name)
    if value not in {"true", "false"}:
        raise ConfigurationError(f"Expected true or false for configuration: {name}")
    return value


def absolute_path(values: dict[str, str], name: str) -> str:
    value = required(values, name)
    if not Path(value).is_absolute():
        raise ConfigurationError(f"Expected an absolute path for configuration: {name}")
    return value


def frontend_environment(values: dict[str, str], *, container: bool = False) -> dict[str, str]:
    result = {
        "BACKEND_URL": http_url(values, "BACKEND_URL"),
        "SUPABASE_SERVER_URL": http_url(values, "SUPABASE_URL"),
        "LOG_DIR": absolute_path(values, "FRONTEND_LOG_DIR"),
        "PORT": str(port(values, "FRONTEND_PORT")),
        "HOSTNAME": required(values, "FRONTEND_BIND_HOST"),
        "NEXT_PUBLIC_SUPABASE_URL": http_url(values, "SUPABASE_URL"),
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": required(values, "SUPABASE_PUBLISHABLE_KEY"),
        "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED": boolean(values, "LIFECYCLE_PURGE_ENABLED"),
    }
    for name in FRONTEND_LIMITS:
        value = required(values, name)
        if not re.fullmatch(r"[0-9]+", value) or int(value) <= 0:
            raise ConfigurationError(f"Expected a positive integer for configuration: {name}")
        result[name] = value
    if container:
        result["BACKEND_URL"] = f"http://backend:{port(values, 'BACKEND_PORT')}"
        result["SUPABASE_SERVER_URL"] = docker_endpoint(result["SUPABASE_SERVER_URL"])
        result["LOG_DIR"] = absolute_path(values, "CONTAINER_LOG_DIR")
        result["HOSTNAME"] = required(values, "CONTAINER_BIND_HOST")
    return result


def docker_endpoint(value: str) -> str:
    """Translate the local host transport only; keep credentials/path/identity intact."""
    try:
        parsed = urlsplit(value)
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise ConfigurationError("Local Compose requires loopback canonical service endpoints")
        userinfo, separator, _ = parsed.netloc.rpartition("@")
        host = "host.docker.internal"
        if parsed.port is not None:
            host += f":{parsed.port}"
        netloc = f"{userinfo}@{host}" if separator else host
        return urlunsplit(parsed._replace(netloc=netloc))
    except ValueError:
        raise ConfigurationError("Invalid local service endpoint configuration") from None


def compose_environment(values: dict[str, str]) -> dict[str, str]:
    result = {name: required(values, name) for name in API_KEYS}
    result.update(frontend_environment(values, container=True))
    # One effective environment supplies both services. Compose allowlists their keys.
    result["DATABASE_URL"] = docker_endpoint(required(values, "DATABASE_URL"))
    result["SUPABASE_URL"] = docker_endpoint(http_url(values, "SUPABASE_URL"))
    result["SUPABASE_JWKS_URL"] = docker_endpoint(http_url(values, "SUPABASE_JWKS_URL"))
    result["SUPABASE_JWT_ISSUER"] = http_url(values, "SUPABASE_JWT_ISSUER")
    result["LOG_DIR"] = absolute_path(values, "CONTAINER_LOG_DIR")
    result["BACKEND_BIND_HOST"] = required(values, "CONTAINER_BIND_HOST")
    result["OPENSLATE_ENV_SOURCE"] = "process"
    for name in ("BACKEND_PORT", "FRONTEND_PORT", "FILES_CLAMAV_PORT"):
        result[name] = str(port(values, name))
    for name in (
        "SERVER_MAX_CONCURRENCY", "SERVER_KEEP_ALIVE_SECONDS", "COMPOSE_BIND_HOST",
        "CLAMAV_MEMORY_LIMIT", "CLAMAV_CPUS", "CLAMAV_PIDS_LIMIT",
    ):
        result[name] = required(values, name)
    result["SCANNER_DEFINITIONS"] = absolute_path(values, "SCANNER_DEFINITIONS")
    return result


def validate(values: dict[str, str], *, operations: bool = True) -> None:
    legacy = sorted(LEGACY_KEYS.intersection(values))
    if legacy:
        raise ConfigurationError("Remove retired configuration names: " + ", ".join(legacy))
    for name in API_KEYS:
        required(values, name)
    frontend_environment(values)
    for name in PORT_KEYS:
        port(values, name)
    for name in (
        "BACKEND_BIND_HOST", "SERVER_MAX_CONCURRENCY", "SERVER_KEEP_ALIVE_SECONDS",
        "SUPABASE_PROJECT_ID", "SUPABASE_HOST",
    ):
        required(values, name)
    if operations:
        for name in ("ADMIN_EMAIL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "MIGRATION_DATABASE_URL"):
            required(values, name)
    absolute_path(values, "LOG_DIR")
    for name in ("SUPABASE_AUTH_REDIRECT_URL", "SUPABASE_JWT_ISSUER", "SUPABASE_JWKS_URL"):
        http_url(values, name)
    for url_name, port_name in (
        ("FRONTEND_URL", "FRONTEND_PORT"),
        ("BACKEND_URL", "BACKEND_PORT"),
        ("SUPABASE_URL", "SUPABASE_API_PORT"),
    ):
        if urlsplit(http_url(values, url_name)).port != port(values, port_name):
            raise ConfigurationError(f"Configuration disagrees: {url_name} and {port_name}")
    for name in (("DATABASE_URL", "MIGRATION_DATABASE_URL") if operations else ("DATABASE_URL",)):
        try:
            parsed = urlsplit(required(values, name))
            valid = parsed.scheme == "postgresql+psycopg" and parsed.hostname and parsed.username
            valid = valid and parsed.password and parsed.port == port(values, "SUPABASE_DB_PORT")
        except ValueError:
            valid = False
        if not valid:
            raise ConfigurationError(f"Invalid database configuration: {name}")
    from app.core.config import Settings
    from pydantic import ValidationError

    inputs: dict[str, object] = {name.lower(): values[name] for name in API_KEYS}
    try:
        inputs["cors_origins"] = json.loads(values["CORS_ORIGINS"])
        Settings(_env_file=None, **inputs)
    except (ValidationError, ValueError) as error:
        if isinstance(error, ValidationError):
            names = sorted({str(item["loc"][0]).upper() for item in error.errors(include_input=False)})
            raise ConfigurationError("Invalid configuration: " + ", ".join(names)) from None
        raise ConfigurationError("Invalid configuration: CORS_ORIGINS") from None


def write_environment(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    lines = ["# Generated from the root .env; do not edit this file."]
    for name, value in values.items():
        quoted = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
        lines.append(f'{name}="{quoted}"')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "frontend", "compose"))
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        values = read_environment(ROOT / ".env")
        if args.command == "frontend":
            write_environment(ROOT / "frontend/.env.local", frontend_environment(values))
            print("Frontend environment refreshed from root .env (no backend/admin secrets).")
            return 0
        validate(values, operations=args.command == "check")
        if args.command == "check":
            if args.arguments:
                parser.error("check does not accept extra arguments")
            print("Environment configuration is valid; scanner provisioning is a separate check.")
            return 0
        projected = compose_environment(values)
        if not args.arguments:
            parser.error("compose requires Docker Compose arguments, for example: config --quiet")
        # Explicit projected values win over stale shell settings. No whole-root export.
        child_env = {name: value for name, value in os.environ.items() if name not in values}
        child_env.update(projected)
        return subprocess.run(
            ["docker", "compose", "--env-file", os.devnull, *args.arguments],
            cwd=ROOT, env=child_env, check=False,
        ).returncode
    except (ConfigurationError, OSError) as error:
        if isinstance(error, ConfigurationError):
            print(str(error), file=sys.stderr)
        else:
            print("Environment configuration file could not be read or written.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
