"""Real-provider recovery checks for partial Supabase Storage operations."""

from __future__ import annotations

import os
from collections.abc import Iterator
from hashlib import sha256
from uuid import uuid4

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.supabase_storage import SupabaseStorage
from tests.conftest import _guard_integration_database

pytestmark = pytest.mark.integration

_QUARANTINE = "openslate-quarantine"
_READY = "openslate-ready"
_MEDIA_TYPE = "application/octet-stream"


class FailOneStorageDelete(httpx.BaseTransport):
    """Inject one failure for a single bucket/key DELETE and forward every other request."""

    def __init__(self, bucket: str, key: str) -> None:
        self._target = f"/storage/v1/object/{bucket}/{key}"
        self.failures = 0
        self._real = httpx.HTTPTransport(trust_env=False)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE" and request.url.path == self._target and self.failures == 0:
            self.failures += 1
            return httpx.Response(503, request=request, json={"code": "InjectedUnavailable"})
        return self._real.handle_request(request)

    def close(self) -> None:
        self._real.close()


def _new_storage(
    settings: Settings, transport: httpx.BaseTransport | None = None
) -> tuple[SupabaseStorage, httpx.Client]:
    selected = transport if transport is not None else httpx.HTTPTransport(trust_env=False)
    client = httpx.Client(transport=selected, follow_redirects=False, trust_env=False)
    storage = SupabaseStorage(
        str(settings.supabase_url),
        settings.supabase_secret_key.get_secret_value(),
        float(settings.supabase_timeout_seconds),
        client=client,
    )
    return storage, client


@pytest.fixture
def live_provider_storage() -> Iterator[tuple[Settings, SupabaseStorage, httpx.Client]]:
    if not os.getenv("TEST_DATABASE_URL"):
        pytest.skip("Runner-owned Supabase Storage is required for this integration test")
    values = dict(os.environ)
    owner_url = values.get("MIGRATION_DATABASE_URL", "")
    if not owner_url:
        raise RuntimeError("Runner-owned PostgreSQL is required for Storage integration tests")
    _guard_integration_database(owner_url)
    assert_provider_instance(values, database_url=owner_url, expected_user="openslate_owner")

    settings = get_settings()
    storage, client = _new_storage(settings)
    try:
        yield settings, storage, client
    finally:
        client.close()


@pytest.fixture
def quarantine_object(
    live_provider_storage,
) -> Iterator[tuple[Settings, SupabaseStorage, httpx.Client, str, bytes]]:
    settings, storage, client = live_provider_storage
    key = uuid4().hex
    content = b"storage-recovery-" + uuid4().bytes
    try:
        storage.upload(key, content, _MEDIA_TYPE)
        yield settings, storage, client, key, content
    finally:
        storage.delete(key)


def _copy_to_ready(settings: Settings, key: str, client: httpx.Client) -> None:
    secret = settings.supabase_secret_key.get_secret_value()
    response = client.post(
        f"{str(settings.supabase_url).rstrip('/')}/storage/v1/object/copy",
        headers={
            "apikey": secret,
            "authorization": f"Bearer {secret}",
            "x-upsert": "false",
        },
        json={
            "bucketId": _QUARANTINE,
            "sourceKey": key,
            "destinationBucket": _READY,
            "destinationKey": key,
        },
        timeout=float(settings.supabase_timeout_seconds),
    )
    assert 200 <= response.status_code < 300, "Live Supabase Storage copy failed"


def test_promotion_retries_after_copy_succeeded_but_quarantine_delete_failed(
    quarantine_object,
) -> None:
    settings, storage, _client, key, content = quarantine_object
    digest = sha256(content).hexdigest()
    injected = FailOneStorageDelete(_QUARANTINE, key)
    failing_storage, client = _new_storage(settings, injected)
    try:
        with pytest.raises(ProviderUnavailable):
            failing_storage.promote(key, expected_digest=digest, expected_size=len(content))
        assert injected.failures == 1
    finally:
        client.close()

    # The real copy remains in Ready and the failed cleanup preserves Quarantine bytes.
    assert storage.read_quarantine(key) == content
    assert storage.download(key) == content

    storage.promote(key, expected_digest=digest, expected_size=len(content))
    assert storage.read_quarantine(key) is None
    assert storage.download(key) == content


def test_delete_retries_after_quarantine_was_removed_but_ready_delete_failed(
    quarantine_object,
) -> None:
    settings, storage, client, key, content = quarantine_object
    _copy_to_ready(settings, key, client)

    assert storage.read_quarantine(key) == content
    assert storage.download(key) == content

    injected = FailOneStorageDelete(_READY, key)
    failing_storage, client = _new_storage(settings, injected)
    try:
        with pytest.raises(ProviderUnavailable):
            failing_storage.delete(key)
        assert injected.failures == 1
    finally:
        client.close()

    # Quarantine deletion reached the provider; the targeted Ready delete did not.
    assert storage.read_quarantine(key) is None
    assert storage.download(key) == content

    storage.delete(key)
    assert storage.read_quarantine(key) is None
    assert storage.download(key) is None
