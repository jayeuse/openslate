"""Development-only runtime policy shared by browser-facing boundaries."""

from __future__ import annotations

import ipaddress
from typing import Protocol
from urllib.parse import urlsplit

_IPV4_PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
_IPV6_UNIQUE_LOCAL_NETWORK = ipaddress.ip_network("fc00::/7")


class DevelopmentRuntimeSettings(Protocol):
    environment: str
    backend_bind_host: str
    public_origin: str


def is_relaxed_development(settings: DevelopmentRuntimeSettings) -> bool:
    """Return whether this process is a loopback-only development server."""

    return (
        getattr(settings, "environment", None) == "development"
        and is_loopback_host(getattr(settings, "backend_bind_host", ""))
    )


def browser_origin_is_permitted(settings: DevelopmentRuntimeSettings, origin: str | None) -> bool:
    """Allow local development origins; require the configured origin everywhere else."""

    if not is_relaxed_development(settings):
        return origin is not None and origin == settings.public_origin
    if origin is None:
        return True
    host = _local_origin_host(origin)
    return host is not None and is_local_development_host(host)


def is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _local_origin_host(origin: str) -> str | None:
    if origin != origin.strip():
        return None
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return None
    try:
        _port = parsed.port
    except ValueError:
        return None
    return parsed.hostname


def is_local_development_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if address.is_loopback or address.is_link_local:
        return True
    if isinstance(address, ipaddress.IPv4Address):
        return any(address in network for network in _IPV4_PRIVATE_NETWORKS)
    return address in _IPV6_UNIQUE_LOCAL_NETWORK
