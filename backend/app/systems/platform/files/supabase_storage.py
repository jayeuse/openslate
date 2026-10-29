"""Server-only private Storage API adapter; application policy stays in FastAPI."""

import json
import re
from contextlib import nullcontext

import httpx

from app.systems.platform.files.providers import ProviderRejected, ProviderUnavailable
from app.systems.platform.files.validation import MAX_BYTES

# Organization files live under their organization; avatars are account files (D17).
_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_KEY = re.compile(rf"(org|user)/{_UUID}/[0-9a-f]{{32}}\Z")
_READY = "openslate-ready"
_AVATARS = "openslate-avatars"


def bucket_for(key: str) -> str:
    return _AVATARS if key.startswith("user/") else _READY


_ERROR_LIMIT = 4096


class SupabaseStorage:
    """Opaque immutable keys in private, preprovisioned Supabase buckets."""

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

    def _request(
        self,
        method: str,
        route: str,
        *,
        content: bytes | None = None,
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
            kind = (
                "timeout" if isinstance(exc, httpx.TimeoutException)
                else "connect" if isinstance(exc, httpx.ConnectError) else "transport"
            )
            raise ProviderUnavailable("Storage API is unavailable", kind=kind) from exc

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
            raise ProviderUnavailable("Storage API request failed", kind=f"http_{status}")

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        self._validate_key(key)
        if len(content) > MAX_BYTES:
            raise ProviderRejected("Storage object exceeds the configured limit")
        status, body = self._request(
            "POST", f"object/{bucket_for(key)}/{key}", content=content, media_type=media_type
        )
        if self._is_conflict(status, body):
            raise ProviderRejected("An immutable storage object already exists")
        self._require_success(status)

    def download(self, key: str) -> bytes | None:
        self._validate_key(key)
        status, body = self._request(
            "GET", f"object/authenticated/{bucket_for(key)}/{key}", object_read=True
        )
        if self._is_missing(status, body):
            return None
        self._require_success(status)
        return body

    def delete(self, key: str) -> None:
        self._validate_key(key)
        status, body = self._request("DELETE", f"object/{bucket_for(key)}/{key}")
        if not self._is_missing(status, body):
            self._require_success(status)
        if self.download(key) is not None:
            raise ProviderUnavailable("Storage deletion was not confirmed")
