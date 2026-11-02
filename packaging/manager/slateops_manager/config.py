"""Public configuration parsing for the unprivileged desktop shell."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import SplitResult, urlsplit, urlunsplit

_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
_PUBLIC_FIELDS = frozenset({"origin", "version"})


class ManagerConfigError(ValueError):
    """Raised when the bundled public manager configuration is unsafe."""


@dataclass(frozen=True)
class ManagerConfig:
    """The only values a Gate 0 Manager distribution is allowed to contain."""

    origin: str
    version: str


def _canonical_https_origin(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ManagerConfigError("Manager origin must be a non-empty HTTPS URL")
    if any(
        character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value
    ):
        raise ManagerConfigError("Manager origin cannot contain whitespace or control characters")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ManagerConfigError("Manager origin has an invalid host or port") from error
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ManagerConfigError("Manager origin must use HTTPS and include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ManagerConfigError("Manager origin cannot contain user credentials")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ManagerConfigError("Manager origin must not contain a path, query, or fragment")
    hostname = parsed.hostname
    host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    netloc = host if port is None else f"{host}:{port}"
    canonical = SplitResult("https", netloc, "", "", "")
    return urlunsplit(canonical)


def _version(value: object) -> str:
    if not isinstance(value, str) or not _VERSION.fullmatch(value):
        raise ManagerConfigError("Manager version must be a short release identifier")
    return value


def parse_public_config(value: object) -> ManagerConfig:
    """Validate the public, secret-free manager configuration document."""

    if not isinstance(value, dict) or set(value) != _PUBLIC_FIELDS:
        raise ManagerConfigError("Manager configuration must contain only origin and version")
    return ManagerConfig(
        origin=_canonical_https_origin(value["origin"]), version=_version(value["version"])
    )


def read_public_config(path: Path) -> ManagerConfig:
    """Read and validate one JSON configuration document without executing it."""

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManagerConfigError(f"Cannot read manager configuration: {path}") from error
    return parse_public_config(value)
