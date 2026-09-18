"""Bounded Supabase Storage cleanup for the local application reset."""

from __future__ import annotations

import os
import shlex
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

if __package__:
    from .reset_models import ResetError  # type: ignore[import-not-found]
else:
    from reset_models import ResetError


STORAGE_BUCKET = "openslate-files"
STORAGE_BATCH_SIZE = 1_000
_LOCAL_STORAGE_HOST = "127.0.0.1"
_LOCAL_STORAGE_PORT = 54321


def _normalized_local_storage_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "http"
            or parsed.hostname != _LOCAL_STORAGE_HOST
            or parsed.port != _LOCAL_STORAGE_PORT
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
        return f"http://{_LOCAL_STORAGE_HOST}:{_LOCAL_STORAGE_PORT}"
    except (AttributeError, TypeError, ValueError):
        raise ResetError("SUPABASE_URL must target the local Supabase Storage API") from None


def validate_local_storage_url(url: str, expected_url: str | None = None) -> None:
    """Require the configured Storage API to match the local CLI status target."""
    normalized = _normalized_local_storage_url(url)
    if expected_url is not None and normalized != _normalized_local_storage_url(expected_url):
        raise ResetError("The configured and Supabase status Storage API URLs do not match")


def parse_supabase_status_storage_url(output: str) -> str:
    """Parse one local Storage API URL without exposing the rest of CLI status."""
    try:
        matches = [line for line in output.splitlines() if line.startswith("API_URL=")]
        if len(matches) != 1:
            raise ValueError
        tokens = shlex.split(matches[0], comments=False, posix=True)
        if len(tokens) != 1 or not tokens[0].startswith("API_URL="):
            raise ValueError
        value = tokens[0][len("API_URL=") :]
        validate_local_storage_url(value)
        return value
    except (AttributeError, IndexError, TypeError, ValueError, ResetError):
        raise ResetError("Supabase status did not provide one local Storage API URL") from None


def read_supabase_status_storage_url(
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """Read the Storage target from local CLI status without printing its secrets."""
    path = os.environ.get("PATH")
    if not path:
        raise ResetError("PATH is required to inspect local Supabase status")
    try:
        result = run_command(
            ["supabase", "status", "-o", "env"],
            cwd=Path(__file__).resolve().parents[2],
            env={"PATH": path},
            capture_output=True,
            text=True,
            check=True,
            shell=False,
        )
        return parse_supabase_status_storage_url(result.stdout)
    except ResetError:
        raise
    except Exception:
        raise ResetError("Unable to inspect local Supabase status") from None


def require_api_stopped(
    backend_port: str,
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> None:
    """Fail closed unless the canonical local API listener is absent."""
    if backend_port != "8000":
        raise ResetError("BACKEND_PORT must be the canonical local API port")
    try:
        result = run_command(
            ["lsof", "-nP", "-iTCP:8000", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
            shell=False,
        )
    except Exception:
        raise ResetError("Unable to verify that the API server is stopped") from None
    if result.returncode == 0:
        raise ResetError("The API server must be stopped before reset")
    if result.returncode != 1:
        raise ResetError("Unable to verify that the API server is stopped")


class ResetStorage:
    """Server-only listing and deletion through the Storage API, never Storage SQL."""

    def __init__(
        self,
        base_url: str,
        secret: str,
        *,
        client_factory: Callable[..., httpx.Client] = httpx.Client,
    ) -> None:
        if not isinstance(secret, str) or not secret:
            raise ResetError("SUPABASE_SECRET_KEY is required for Storage cleanup")
        self.base_url = _normalized_local_storage_url(base_url)
        self.headers = {"apikey": secret, "Authorization": f"Bearer {secret}"}
        self._client_factory = client_factory

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            with self._client_factory(timeout=30, follow_redirects=False) as client:
                response = client.request(
                    method, self.base_url + path, headers=self.headers, **kwargs
                )
                response.raise_for_status()
                return response
        except httpx.HTTPError:
            raise ResetError("Storage object inventory or cleanup is unavailable") from None

    def list_object_keys(self) -> tuple[str, ...]:
        """Return the complete sorted Storage-visible inventory without printing keys."""
        keys: set[str] = set()
        pending_prefixes = [""]
        visited_prefixes: set[str] = set()
        while pending_prefixes:
            prefix = pending_prefixes.pop()
            if prefix in visited_prefixes:
                continue
            visited_prefixes.add(prefix)
            offset = 0
            while True:
                response = self._request(
                    "POST",
                    f"/storage/v1/object/list/{STORAGE_BUCKET}",
                    json={
                        "prefix": prefix,
                        "limit": STORAGE_BATCH_SIZE,
                        "offset": offset,
                        "sortBy": {"column": "name", "order": "asc"},
                    },
                )
                try:
                    rows = response.json()
                except ValueError:
                    raise ResetError("Storage object inventory is invalid") from None
                if not isinstance(rows, list):
                    raise ResetError("Storage object inventory is invalid")
                for row in rows:
                    if not isinstance(row, dict):
                        raise ResetError("Storage object inventory is invalid")
                    object_id = row.get("id")
                    name = row.get("name")
                    if not isinstance(name, str) or not name or name.startswith("/"):
                        raise ResetError("Storage object inventory is invalid")
                    key = name if name.startswith(prefix) else prefix + name
                    if object_id is None:
                        pending_prefixes.append(key.rstrip("/") + "/")
                    elif key in keys:
                        raise ResetError("Storage object inventory is ambiguous")
                    else:
                        keys.add(key)
                if len(rows) < STORAGE_BATCH_SIZE:
                    break
                offset += len(rows)
        return tuple(sorted(keys))

    def delete_and_verify_empty(self, object_keys: Sequence[str]) -> None:
        """Delete the confirmed inventory in API batches and prove the bucket is empty."""
        for start in range(0, len(object_keys), STORAGE_BATCH_SIZE):
            batch = list(object_keys[start : start + STORAGE_BATCH_SIZE])
            if not batch:
                continue
            self._request(
                "DELETE",
                f"/storage/v1/object/{STORAGE_BUCKET}",
                json={"prefixes": batch},
            )
        if self.list_object_keys():
            raise ResetError("Storage cleanup is incomplete; run a fresh dry run before retrying")
