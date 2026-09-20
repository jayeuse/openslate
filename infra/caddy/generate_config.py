#!/usr/bin/env python3
"""Render a secret-free Caddyfile for OpenSlate's single-origin gateway."""

from __future__ import annotations

import argparse
import ipaddress
import re
from pathlib import Path, PureWindowsPath

TEMPLATE_PATH = Path(__file__).with_name("Caddyfile.template")
_PLACEHOLDER = re.compile(r"\{\{([A-Z_]+)\}\}")
_HOSTNAME = re.compile(
    r"(?=.{1,253}\Z)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\Z"
)
_LISTENER_PORT_LABELS = ("HTTPS_PORT", "HEALTH_PORT", "BACKEND_PORT", "FRONTEND_PORT")


class ConfigurationError(ValueError):
    """Raised when a generated gateway configuration would be unsafe or invalid."""


def _port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer port") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("must be between 1 and 65535")
    return port


def _public_host(value: str) -> str:
    if not value or value != value.strip() or any(character.isspace() for character in value):
        raise argparse.ArgumentTypeError("must be a hostname or IP address without whitespace")
    if _HOSTNAME.fullmatch(value):
        return value.lower()
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a hostname or IP address") from error


def _listen_address(value: str) -> str:
    invalid_character = any(
        character.isspace() or not character.isprintable() for character in value
    )
    if not value or "%" in value or invalid_character:
        raise argparse.ArgumentTypeError("must be an unscoped literal IPv4 or IPv6 address")
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a literal IPv4 or IPv6 address") from error
    return str(address)


def _absolute_path(value: str) -> Path:
    path = Path(value)
    if not (path.is_absolute() or PureWindowsPath(value).is_absolute()):
        raise argparse.ArgumentTypeError("must be an absolute path")
    if any(not character.isprintable() for character in value):
        raise argparse.ArgumentTypeError("must be an absolute path without control characters")
    if "{" in value or "}" in value:
        raise argparse.ArgumentTypeError("must not contain Caddy interpolation braces")
    return path


def _certificate_path(path: Path) -> Path:
    return _absolute_path(str(path))


def _caddy_string_token(value: str) -> str:
    """Return one Caddyfile token without allowing token-boundary injection."""
    if "{" in value or "}" in value:
        raise ConfigurationError("Caddy interpolation braces are not allowed in certificate paths")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _site_host(host: str) -> str:
    """Return a Caddy site-address host, adding brackets only for IPv6."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host
    return f"[{address}]" if address.version == 6 else str(address)


def validate_listener_ports(
    *,
    https_port: int,
    health_port: int,
    backend_port: int,
    frontend_port: int,
    labels: tuple[str, str, str, str] = _LISTENER_PORT_LABELS,
    require_host_namespace_separation: bool = True,
    published_gateway_port: int | None = None,
    published_gateway_label: str = "GATEWAY_PORT",
) -> None:
    """Reject collisions in Caddy and, when applicable, its host namespace."""
    ports = (https_port, health_port, backend_port, frontend_port)
    pairs = (
        ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
        if require_host_namespace_separation
        else ((0, 1), (2, 3))
    )
    for first, second in pairs:
        if ports[first] == ports[second]:
            raise ConfigurationError(f"{labels[second]} conflicts with {labels[first]}")
    if published_gateway_port is not None:
        for index in (2, 3):
            if published_gateway_port == ports[index]:
                raise ConfigurationError(
                    f"{published_gateway_label} conflicts with {labels[index]}"
                )


def render_config(
    *,
    public_host: str,
    listen_address: str,
    https_port: int,
    health_port: int = 3449,
    backend_port: int,
    frontend_port: int,
    tls_mode: str,
    upstream_host: str = "127.0.0.1",
    cert_file: Path | None = None,
    key_file: Path | None = None,
    require_host_namespace_separation: bool = True,
) -> str:
    """Render the checked-in template after validating all operator inputs."""
    if tls_mode == "internal":
        if cert_file is not None or key_file is not None:
            raise ConfigurationError("certificate paths are only valid with custom TLS")
        tls_directive = "internal"
    elif tls_mode == "custom":
        if cert_file is None or key_file is None:
            raise ConfigurationError("custom TLS requires both certificate and key paths")
        tls_directive = " ".join(
            (
                _caddy_string_token(str(_certificate_path(cert_file))),
                _caddy_string_token(str(_certificate_path(key_file))),
            )
        )
    else:
        raise ConfigurationError("TLS mode must be internal or custom")

    rendered_https_port = _port(str(https_port))
    rendered_health_port = _port(str(health_port))
    rendered_backend_port = _port(str(backend_port))
    rendered_frontend_port = _port(str(frontend_port))
    validate_listener_ports(
        https_port=rendered_https_port,
        health_port=rendered_health_port,
        backend_port=rendered_backend_port,
        frontend_port=rendered_frontend_port,
        require_host_namespace_separation=require_host_namespace_separation,
    )

    replacements = {
        "PUBLIC_HOST": _site_host(_public_host(public_host)),
        "LISTEN_ADDRESS": _listen_address(listen_address),
        "HTTPS_PORT": str(rendered_https_port),
        "HEALTH_PORT": str(rendered_health_port),
        "BACKEND_PORT": str(rendered_backend_port),
        "FRONTEND_PORT": str(rendered_frontend_port),
        "UPSTREAM_HOST": _site_host(_public_host(upstream_host)),
        "TLS_DIRECTIVE": tls_directive,
    }
    rendered = _PLACEHOLDER.sub(
        lambda match: replacements[match.group(1)], TEMPLATE_PATH.read_text(encoding="utf-8")
    )
    remaining = _PLACEHOLDER.search(rendered)
    if remaining:
        raise ConfigurationError(f"unreplaced template variable: {remaining.group(1)}")
    return rendered


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-host", required=True, type=_public_host)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--listen-address", default="0.0.0.0", type=_listen_address)
    parser.add_argument("--https-port", default=443, type=_port)
    parser.add_argument("--health-port", default=3449, type=_port)
    parser.add_argument("--backend-port", default=8000, type=_port)
    parser.add_argument("--frontend-port", default=3000, type=_port)
    parser.add_argument("--upstream-host", default="127.0.0.1", type=_public_host)
    parser.add_argument("--tls-mode", choices=("internal", "custom"), default="internal")
    parser.add_argument("--cert-file", type=_absolute_path)
    parser.add_argument("--key-file", type=_absolute_path)
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    try:
        rendered = render_config(
            public_host=arguments.public_host,
            listen_address=arguments.listen_address,
            https_port=arguments.https_port,
            health_port=arguments.health_port,
            backend_port=arguments.backend_port,
            frontend_port=arguments.frontend_port,
            tls_mode=arguments.tls_mode,
            upstream_host=arguments.upstream_host,
            cert_file=arguments.cert_file,
            key_file=arguments.key_file,
        )
    except ConfigurationError as error:
        raise SystemExit(f"invalid gateway configuration: {error}") from error
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
