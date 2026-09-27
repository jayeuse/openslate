"""Storage API inventory and cleanup for the guarded local reset."""

from __future__ import annotations

import errno
import json
import math
import socket
from collections.abc import Sequence
from contextlib import nullcontext
from typing import Any

import httpx

if __package__:
    from .reset_models import ResetError  # type: ignore[import-not-found]
else:
    from reset_models import ResetError

_BUCKETS = ("openslate-quarantine", "openslate-ready")
_PAGE_SIZE = 100
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def require_api_stopped(backend_host: str, backend_port: str) -> None:
    """Reject reset while the configured IPv4/IPv6 API listener accepts connections."""
    try:
        port = int(backend_port)
        if not 1 <= port <= 65535:
            raise ValueError
    except (TypeError, ValueError):
        raise ResetError("BACKEND_PORT must be a valid local API port") from None
    targets = {
        "127.0.0.1": (("127.0.0.1", port),),
        "localhost": (("127.0.0.1", port), ("::1", port)),
        "::1": (("::1", port),),
        "0.0.0.0": (("127.0.0.1", port),),
        "::": (("127.0.0.1", port), ("::1", port)),
    }.get(backend_host)
    if targets is None:
        raise ResetError("BACKEND_BIND_HOST is not supported for local reset")
    for target in targets:
        try:
            with socket.create_connection(target, timeout=0.5):
                raise ResetError("The API server must be stopped before reset")
        except ConnectionRefusedError:
            continue
        except OSError as error:
            if error.errno in {errno.ECONNREFUSED, errno.EADDRNOTAVAIL}:
                continue
            raise ResetError("Unable to verify that the API server is stopped") from None


class ResetStorage:
    """Inventory and delete every object in only OpenSlate's two private buckets."""

    def __init__(
        self, url: str, secret_key: str, timeout_seconds: float,
        *, client: httpx.Client | None = None,
    ) -> None:
        try:
            parsed = httpx.URL(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.host
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
                or parsed.username
                or parsed.password
                or not secret_key
                or not math.isfinite(timeout_seconds)
                or timeout_seconds <= 0
            ):
                raise ValueError
        except (TypeError, ValueError):
            raise ResetError("The provider Storage reset configuration is invalid") from None
        self._origin = str(parsed).rstrip("/")
        self._secret_key = secret_key
        self._timeout = timeout_seconds
        self._client = client

    def _request(
        self, method: str, path: str, *, payload: dict[str, Any] | None = None,
    ) -> tuple[int, bytes]:
        context = nullcontext(self._client) if self._client is not None else httpx.Client(
            follow_redirects=False, trust_env=False
        )
        try:
            with context as client:
                assert client is not None
                with client.stream(
                    method,
                    f"{self._origin}/storage/v1/{path}",
                    headers={"apikey": self._secret_key},
                    json=payload,
                    timeout=self._timeout,
                    follow_redirects=False,
                ) as response:
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > _MAX_RESPONSE_BYTES:
                            raise ResetError("The provider Storage response is too large")
                    return response.status_code, bytes(content)
        except httpx.RequestError:
            raise ResetError("The provider Storage API is unavailable") from None

    @staticmethod
    def _json(body: bytes) -> Any:
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ResetError("The provider Storage response is invalid") from None

    def _require_private_bucket(self, bucket: str) -> None:
        status, body = self._request("GET", f"bucket/{bucket}")
        if status != 200:
            raise ResetError("A required private Storage bucket is unavailable")
        data = self._json(body)
        if (
            not isinstance(data, dict)
            or data.get("id") != bucket
            or data.get("name") != bucket
            or data.get("public") is not False
        ):
            raise ResetError("A required Storage bucket is not private")

    def _list_folder(
        self, bucket: str, folder: str, seen_folders: set[str], objects: set[str],
    ) -> None:
        if folder in seen_folders:
            raise ResetError("The private Storage inventory is ambiguous")
        seen_folders.add(folder)
        offset = 0
        children: list[str] = []
        seen_names: set[str] = set()
        while True:
            status, body = self._request(
                "POST", f"object/list/{bucket}",
                payload={
                    "prefix": folder, "limit": _PAGE_SIZE, "offset": offset,
                    "sortBy": {"column": "name", "order": "asc"},
                },
            )
            if status != 200:
                raise ResetError("The private Storage inventory is unavailable")
            entries = self._json(body)
            if not isinstance(entries, list) or len(entries) > _PAGE_SIZE:
                raise ResetError("The private Storage inventory is invalid")
            for entry in entries:
                if not isinstance(entry, dict):
                    raise ResetError("The private Storage inventory is invalid")
                name = entry.get("name")
                if (
                    not isinstance(name, str)
                    or not name
                    or "/" in name
                    or name in {".", ".."}
                    or name in seen_names
                ):
                    raise ResetError("The private Storage inventory is ambiguous")
                seen_names.add(name)
                key = f"{folder}/{name}" if folder else name
                if entry.get("id") is None:
                    children.append(key)
                elif isinstance(entry.get("id"), str) and entry["id"]:
                    if key in objects:
                        raise ResetError("The private Storage inventory is ambiguous")
                    objects.add(key)
                else:
                    raise ResetError("The private Storage inventory is invalid")
            if len(entries) < _PAGE_SIZE:
                break
            offset += len(entries)
        for child in children:
            self._list_folder(bucket, child, seen_folders, objects)

    def list_object_keys(self) -> tuple[str, ...]:
        all_keys: list[str] = []
        for bucket in _BUCKETS:
            self._require_private_bucket(bucket)
            objects: set[str] = set()
            self._list_folder(bucket, "", set(), objects)
            all_keys.extend(f"{bucket}/{key}" for key in objects)
        return tuple(sorted(all_keys))

    def delete_and_verify_empty(self, object_keys: Sequence[str]) -> None:
        expected = tuple(object_keys)
        if tuple(sorted(expected)) != expected or len(set(expected)) != len(expected):
            raise ResetError("Private Storage cleanup plan is invalid")
        if self.list_object_keys() != expected:
            raise ResetError("Private Storage cleanup plan changed; run a fresh dry run")
        for bucket in _BUCKETS:
            prefix = f"{bucket}/"
            keys = [full_key[len(prefix):] for full_key in expected if full_key.startswith(prefix)]
            for offset in range(0, len(keys), _PAGE_SIZE):
                status, _ = self._request(
                    "DELETE", f"object/{bucket}",
                    payload={"prefixes": keys[offset:offset + _PAGE_SIZE]},
                )
                if status != 200:
                    raise ResetError("Private Storage cleanup is incomplete")
        if self.list_object_keys():
            raise ResetError("Private Storage cleanup is incomplete")
