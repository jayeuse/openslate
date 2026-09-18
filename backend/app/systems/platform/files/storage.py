"""Server-only immutable Supabase Storage operations, never Storage SQL."""

import json
import os
import subprocess
import sys
from pathlib import Path
from time import monotonic
from urllib.parse import quote

import httpx

from app.core.config import Settings, get_settings
from app.systems.platform.files import providers
from app.systems.platform.files.providers import (
    ProviderRejected,
    ProviderUnavailable,
    Storage,
    StorageCleanupUncertain,
)
from app.systems.platform.files.storage_download_client import missing_object
from app.systems.platform.files.validation import MAX_BYTES

DOWNLOAD_SECONDS = 120


def _missing_object(response: httpx.Response) -> bool:
    try:
        return missing_object(response)
    except ValueError:
        raise ProviderUnavailable("Storage error response exceeds bounds") from None


class SupabaseStorage:
    def __init__(self, settings: Settings) -> None:
        if not settings.supabase_url or not settings.supabase_secret_key:
            raise ProviderUnavailable("Storage is not configured")
        self.base_url = settings.supabase_url.rstrip("/")
        secret = settings.supabase_secret_key.get_secret_value()
        self.headers = {"apikey": secret, "Authorization": f"Bearer {secret}"}

    def _path(self, key: str) -> str:
        return "/storage/v1/object/openslate-files/" + quote(key, safe="")

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        try:
            with httpx.Client(timeout=120, follow_redirects=False) as client:
                response = client.post(
                    self.base_url + self._path(key),
                    content=content,
                    headers={**self.headers, "Content-Type": media_type, "x-upsert": "false"},
                )
                if response.status_code in {401, 403, 413, 415, 422}:
                    raise ProviderRejected("Storage rejected upload")
                response.raise_for_status()
        except httpx.HTTPError as error:
            raise ProviderUnavailable("Storage upload outcome is unresolved") from error

    def download(self, key: str) -> bytes | None:
        deadline = monotonic() + DOWNLOAD_SECONDS
        payload = json.dumps(
            {
                "url": self.base_url + self._path(key),
                "headers": self.headers,
                "max_bytes": MAX_BYTES,
            }
        ).encode()
        env = {"PATH": os.defpath, "PYTHONNOUSERSITE": "1", "TZ": "UTC", "LC_ALL": "C"}
        for name in (
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
        ):
            if name in os.environ:
                env[name] = os.environ[name]
        if providers._storage_cleanup_uncertain:
            raise StorageCleanupUncertain("Storage cleanup is unresolved")
        # Trusted fixed child writes only one frame capped at MAX_BYTES + 5;
        # neither provider bodies nor credentials are forwarded to stderr/logs.
        try:
            process = subprocess.Popen(
                [sys.executable, "-m", "app.systems.platform.files.storage_download_client"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=Path(__file__).resolve().parents[4],
                env=env,
            )
        except OSError:
            raise ProviderUnavailable("Storage client could not start") from None
        try:
            output, _ = process.communicate(payload, timeout=max(0, deadline - monotonic() - 2))
        except (subprocess.TimeoutExpired, OSError):
            try:
                process.kill()
                process.communicate(timeout=max(0, deadline - monotonic()))
            except (subprocess.TimeoutExpired, OSError):
                providers._storage_cleanup_uncertain = True
                raise StorageCleanupUncertain("Storage cleanup is unresolved") from None
            raise ProviderUnavailable("Storage download timed out") from None
        if process.returncode != 0 or len(output) < 5 or len(output) > MAX_BYTES + 5:
            raise ProviderUnavailable("Storage client response is invalid")
        kind, size, content = output[:1], int.from_bytes(output[1:5], "big"), output[5:]
        if size != len(content):
            raise ProviderUnavailable("Storage client response is invalid")
        if kind == b"D":
            return content
        if kind == b"N" and not content:
            return None
        raise ProviderUnavailable("Storage download is unavailable")

    def delete(self, key: str) -> None:
        try:
            with httpx.Client(timeout=120, follow_redirects=False) as client:
                response = client.delete(self.base_url + self._path(key), headers=self.headers)
                if not _missing_object(response):
                    response.raise_for_status()
        except httpx.HTTPError as error:
            raise ProviderUnavailable("Storage deletion outcome is unresolved") from error


def get_storage() -> Storage:
    try:
        return SupabaseStorage(get_settings())
    except ProviderUnavailable as error:
        from fastapi import HTTPException

        raise HTTPException(
            503, detail={"code": "storage_unavailable", "message": "Storage is unavailable"}
        ) from error
