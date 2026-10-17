"""Real-provider recovery checks for partial Supabase Storage operations."""

from __future__ import annotations

import os
from collections.abc import Iterator
from uuid import UUID, uuid4

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.systems.platform.files import delivery
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.supabase_storage import SupabaseStorage, bucket_for
from tests.conftest import _guard_integration_database
from tests.files.test_workspace_policy_integration import _actor_with_record, _client, _png

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


# Organization files and account avatars live in their own private buckets (D17).
@pytest.fixture(params=["org", "user"])
def stored_object(
    live_provider_storage, request
) -> Iterator[tuple[Settings, SupabaseStorage, httpx.Client, str, bytes]]:
    settings, storage, client = live_provider_storage
    key = f"{request.param}/{uuid4()}/{uuid4().hex}"
    content = b"storage-recovery-" + uuid4().bytes
    try:
        # The avatar bucket accepts PNG and JPEG only (D17).
        storage.upload(key, content, "image/png" if request.param == "user" else _MEDIA_TYPE)
        yield settings, storage, client, key, content
    finally:
        storage.delete(key)


def test_upload_lands_in_its_private_bucket(stored_object) -> None:
    _settings, storage, _client, key, content = stored_object
    assert storage.download(key) == content


def test_avatar_bucket_refuses_other_media_types(live_provider_storage) -> None:
    _settings, storage, _client = live_provider_storage
    with pytest.raises(ProviderUnavailable):
        storage.upload(f"user/{uuid4()}/{uuid4().hex}", b"%PDF-1.7", "application/pdf")


def test_fastapi_file_roundtrip_reaches_real_private_storage(
    guarded_db, live_provider_storage, monkeypatch
):
    _settings, storage, _provider = live_provider_storage
    actor, _grant, record = _actor_with_record(guarded_db, role="admin")
    # The test's organization exists only in its own transaction, so the separately
    # committed access event is captured here; it must name the record's organization.
    download_events: list[object] = []
    monkeypatch.setattr(
        delivery, "append_committed_security_event",
        lambda event, *, org_id=None: download_events.append(org_id),
    )
    content = _png()
    with _client(guarded_db, actor, storage) as client:
        reserved = client.post(
            "/api/files",
            json={
                "purpose": "record_attachment",
                "record_id": str(record.id),
                "filename": "provider-roundtrip.png",
                "expected_size": len(content),
            },
        )
        assert reserved.status_code == 201, reserved.text
        file_id = UUID(reserved.json()["id"])
        key = guarded_db.get(File, file_id).object_key
        try:
            uploaded = client.put(
                f"/api/files/{file_id}/content",
                headers={"Content-Type": "application/octet-stream"},
                content=content,
            )
            assert uploaded.status_code == 200, uploaded.text
            assert uploaded.json()["state"] == "ready"
            assert storage.download(key) == content
            downloaded = client.get(f"/api/files/{file_id}/content")
            assert downloaded.status_code == 200, downloaded.text
            assert download_events == [record.org_id]
            assert downloaded.content == content
            assert downloaded.headers["content-disposition"].startswith("attachment;")
            assert downloaded.headers["x-content-type-options"] == "nosniff"
        finally:
            storage.delete(key)


def test_delete_retries_after_a_failed_provider_delete(stored_object) -> None:
    settings, storage, _client, key, content = stored_object

    injected = FailOneStorageDelete(bucket_for(key), key)
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
