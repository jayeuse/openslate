"""Strict, non-secret environment-file parsing shared by runtime entrypoints."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

from dotenv.parser import parse_stream

_NAME: Final = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_REFERENCE: Final = re.compile(r"\$\{([^}]*)\}")


class ConfigurationError(RuntimeError):
    """An environment configuration error that never includes a configured value."""


def with_realtime_publisher(values: Mapping[str, str]) -> dict[str, str]:
    """Project the approved private publisher binding without rewriting the root file."""
    projected = dict(values)
    if values.get("ENVIRONMENT") == "development":
        try:
            port = int(values.get("SUPABASE_REALTIME_PUBLISH_PORT", "58001"))
            if not 1 <= port <= 65535:
                raise ValueError
        except (TypeError, ValueError):
            raise ConfigurationError(
                "Invalid configuration: SUPABASE_REALTIME_PUBLISH_PORT"
            ) from None
        projected.setdefault(
            "REALTIME_PUBLISH_URL", f"http://127.0.0.1:{port}/realtime/v1/api/broadcast"
        )
        try:
            endpoint = urlsplit(projected["REALTIME_PUBLISH_URL"])
            valid = endpoint.hostname in {"127.0.0.1", "localhost"} and endpoint.port == port
        except ValueError:
            valid = False
        if not valid:
            raise ConfigurationError(
                "Development REALTIME_PUBLISH_URL must target the owned loopback publisher"
            )
    elif values.get("ENVIRONMENT") == "production":
        projected.setdefault("REALTIME_PUBLISH_URL", "http://api-gw:8001/realtime/v1/api/broadcast")
    return projected


def read_environment(path: Path) -> dict[str, str]:
    """Read one dotenv file, rejecting ambiguous bindings and external expansion."""

    try:
        with path.open(encoding="utf-8") as stream:
            bindings = tuple(parse_stream(stream))
    except OSError:
        raise ConfigurationError("Environment file is unavailable") from None

    values: dict[str, str] = {}
    for binding in bindings:
        if binding.error:
            raise ConfigurationError("Environment file contains a malformed binding")
        if binding.key is None:
            continue
        if binding.value is None:
            raise ConfigurationError(f"{binding.key} requires an explicit value")
        if binding.key in values:
            raise ConfigurationError(f"Environment file defines {binding.key} more than once")
        values[binding.key] = binding.value
    return {name: _resolve_value(name, values, ()) for name in values}


def environment_inputs(path: Path, *, process: Mapping[str, str] | None = None) -> dict[str, str]:
    """Load the root dotenv file or explicitly injected process configuration."""

    selected_process = process if process is not None else os.environ
    source = selected_process.get("OPENSLATE_ENV_SOURCE", "").strip()
    if source == "process":
        return dict(selected_process)
    if source:
        raise ConfigurationError("OPENSLATE_ENV_SOURCE must be process when set")
    return read_environment(path)


def _resolve_value(name: str, values: Mapping[str, str], chain: tuple[str, ...]) -> str:
    if name in chain:
        raise ConfigurationError(f"Environment reference cycle includes {name}")

    def replace(match: re.Match[str]) -> str:
        reference = match.group(1)
        if not _NAME.fullmatch(reference):
            raise ConfigurationError(f"{name} contains an unsupported environment reference")
        if reference not in values:
            raise ConfigurationError(f"{name} references missing {reference}")
        return _resolve_value(reference, values, (*chain, name))

    return _REFERENCE.sub(replace, values[name])
