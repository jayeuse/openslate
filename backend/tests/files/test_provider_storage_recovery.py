"""Real-provider recovery checks for partial Supabase Storage operations."""

from __future__ import annotations

import os
from collections.abc import Iterator
from uuid import uuid4

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.supabase_storage import SupabaseStorage
from tests.conftest import _guard_integration_database

pytestmark = pytest.mark.integration

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
def stored_object(
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


def test_upload_lands_in_the_private_ready_bucket(stored_object) -> None:
    _settings, storage, _client, key, content = stored_object
    assert storage.download(key) == content


def test_delete_retries_after_a_failed_provider_delete(stored_object) -> None:
    settings, storage, _client, key, content = stored_object

    injected = FailOneStorageDelete(_READY, key)
    failing_storage, client = _new_storage(settings, injected)
    try:
        with pytest.raises(ProviderUnavailable):
            failing_storage.delete(key)
        assert injected.failures == 1
    finally:
        client.close()

    # The failed delete kept the bytes; a retry removes them.
    assert storage.download(key) == content

    storage.delete(key)
    assert storage.download(key) is None
