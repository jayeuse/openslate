"""Server-only private Storage API adapter; application policy stays in FastAPI."""

import json
import re
from contextlib import nullcontext
from hashlib import sha256
from typing import Any

import httpx

from app.systems.platform.files.providers import ProviderRejected, ProviderUnavailable, StorageStat
from app.systems.platform.files.validation import MAX_BYTES

_KEY = re.compile(r"[0-9a-f]{32}\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_QUARANTINE = "openslate-quarantine"
_READY = "openslate-ready"
_ERROR_LIMIT = 4096


class SupabaseStorage:
    """Opaque immutable keys in two private, preprovisioned Supabase buckets."""

    def __init__(
        self,
        url: str,
        secret_key: str,
        timeout_seconds: float,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        parsed = httpx.URL(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.host
            or parsed.path not in {"", "/"}
        ):
            raise ProviderUnavailable("Storage gateway origin is invalid")
        if not secret_key or timeout_seconds <= 0:
            raise ProviderUnavailable("Storage credentials or timeout are invalid")
        self._origin = str(parsed).rstrip("/")
        self._key = secret_key
        self._timeout = timeout_seconds
        self._client = client

    @staticmethod
    def _validate_key(key: str) -> None:
        if not _KEY.fullmatch(key):
            raise ProviderRejected("Storage key is invalid")

    @staticmethod
    def _validate_expected(digest: str, size: int) -> None:
        if not _DIGEST.fullmatch(digest) or not 0 < size <= MAX_BYTES:
            raise ProviderRejected("Storage integrity expectation is invalid")

    def _request(
        self,
        method: str,
        route: str,
        *,
        content: bytes | None = None,
        payload: dict[str, Any] | None = None,
        media_type: str | None = None,
        object_read: bool = False,
    ) -> tuple[int, bytes]:
        headers = {
            "apikey": self._key,
            "authorization": f"Bearer {self._key}",
            "x-upsert": "false",
        }
        if media_type is not None:
            headers["content-type"] = media_type
        context = nullcontext(self._client) if self._client is not None else httpx.Client(
            follow_redirects=False, trust_env=False
        )
        try:
            with context as client:
                assert client is not None
                with client.stream(
                    method,
                    f"{self._origin}/storage/v1/{route}",
                    headers=headers,
                    content=content,
                    json=payload,
                    follow_redirects=False,
                    timeout=self._timeout,
                ) as response:
                    limit = (
                        MAX_BYTES if object_read and response.status_code == 200 else _ERROR_LIMIT
                    )
                    chunks: list[bytes] = []
                    size = 0
                    for chunk in response.iter_bytes(chunk_size=65536):
                        size += len(chunk)
                        if size > limit:
                            raise ProviderUnavailable(
                                "Storage response exceeded the configured limit"
                            )
                        chunks.append(chunk)
                    return response.status_code, b"".join(chunks)
        except httpx.RequestError as exc:
            raise ProviderUnavailable("Storage API is unavailable") from exc

    @staticmethod
    def _is_missing(status: int, body: bytes) -> bool:
        # The pinned self-hosted Storage route can return NoSuchKey with 400;
        # only its exact object code proves absence, never a bare 400/404.
        if status not in {400, 404}:
            return False
        try:
            error = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False
        return isinstance(error, dict) and error.get("code") == "NoSuchKey"

    @staticmethod
    def _is_conflict(status: int, body: bytes) -> bool:
        if status not in {400, 409}:
            return False
        try:
            error = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return False
        return isinstance(error, dict) and error.get("code") in {
            "KeyAlreadyExists",
            "ResourceAlreadyExists",
        }

    @staticmethod
    def _require_success(status: int) -> None:
        if not 200 <= status < 300:
            raise ProviderUnavailable("Storage API request failed")

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        self._validate_key(key)
        if len(content) > MAX_BYTES:
            raise ProviderRejected("Storage object exceeds the configured limit")
        status, body = self._request(
            "POST", f"object/{_QUARANTINE}/{key}", content=content, media_type=media_type
        )
        if self._is_conflict(status, body):
            raise ProviderRejected("An immutable storage object already exists")
        self._require_success(status)

    def _read(self, bucket: str, key: str) -> bytes | None:
        self._validate_key(key)
        status, body = self._request(
            "GET", f"object/authenticated/{bucket}/{key}", object_read=True
        )
        if self._is_missing(status, body):
            return None
        self._require_success(status)
        return body

    def read_quarantine(self, key: str) -> bytes | None:
        return self._read(_QUARANTINE, key)

    def download(self, key: str) -> bytes | None:
        return self._read(_READY, key)

    def stat(self, key: str, *, quarantine: bool) -> StorageStat | None:
        content = self._read(_QUARANTINE if quarantine else _READY, key)
        if content is None:
            return None
        return StorageStat(size=len(content), digest=sha256(content).hexdigest())

    @staticmethod
    def _verify(content: bytes, digest: str, size: int) -> None:
        if len(content) != size or sha256(content).hexdigest() != digest:
            raise ProviderRejected("Storage object integrity changed")

    def _delete_location(self, bucket: str, key: str) -> None:
        status, body = self._request("DELETE", f"object/{bucket}/{key}")
        if not self._is_missing(status, body):
            self._require_success(status)
        if self._read(bucket, key) is not None:
            raise ProviderUnavailable("Storage deletion was not confirmed")

    def promote(self, key: str, *, expected_digest: str, expected_size: int) -> None:
        self._validate_key(key)
        self._validate_expected(expected_digest, expected_size)
        quarantine = self.read_quarantine(key)
        if quarantine is not None:
            self._verify(quarantine, expected_digest, expected_size)
        ready = self.download(key)
        if ready is not None:
            self._verify(ready, expected_digest, expected_size)
        if quarantine is None:
            if ready is None:
                raise ProviderRejected("Quarantined storage object is unavailable")
            return
        if ready is None:
            status, body = self._request(
                "POST",
                "object/copy",
                payload={
                    "bucketId": _QUARANTINE,
                    "sourceKey": key,
                    "destinationBucket": _READY,
                    "destinationKey": key,
                },
            )
            if not self._is_conflict(status, body):
                self._require_success(status)
            ready = self.download(key)
            if ready is None:
                raise ProviderUnavailable("Ready storage copy was not confirmed")
            self._verify(ready, expected_digest, expected_size)
        self._delete_location(_QUARANTINE, key)

    def delete(self, key: str) -> None:
        self._validate_key(key)
        self._delete_location(_QUARANTINE, key)
        self._delete_location(_READY, key)
