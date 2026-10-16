import json

import httpx
import pytest

from app.core.config.instance import InstanceTargetError
from operations import provision_storage as operation

VALUES = {
    "DATABASE_URL": "synthetic-runtime-url", "SUPABASE_URL": "http://owned.test",
    "SUPABASE_SECRET_KEY": "synthetic-secret",
}


def test_storage_initialization_creates_private_buckets_and_repeats_without_overwrite(monkeypatch):
    buckets: dict[str, dict] = {}
    created: list[str] = []
    monkeypatch.setattr(operation, "assert_provider_instance", lambda *a, **k: None, raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["public"] is False
            buckets[body["id"]] = body
            created.append(body["id"])
            return httpx.Response(201, json={"name": body["id"]})
        name = request.url.path.rsplit("/", 1)[1]
        if name not in buckets:
            return httpx.Response(400, json={"code": "NoSuchBucket"})
        return httpx.Response(200, json=buckets[name])

    for _ in range(2):
        operation.provision_storage(VALUES, transport=httpx.MockTransport(handler))
    assert created == ["openslate-ready", "openslate-avatars"]
    assert buckets["openslate-ready"]["file_size_limit"] == 10 * 1024 * 1024
    assert buckets["openslate-avatars"]["allowed_mime_types"] == ["image/png", "image/jpeg"]


def test_existing_private_bucket_takes_the_current_limits(monkeypatch):
    monkeypatch.setattr(operation, "assert_provider_instance", lambda *a, **k: None, raising=False)
    buckets = {name: {"id": name, "public": False} for name in operation.BUCKETS}
    updated: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[1]
        if request.method == "PUT":
            body = json.loads(request.content)
            assert body["public"] is False
            buckets[name].update(body)
            updated.append(name)
            return httpx.Response(200, json={"message": "Successfully updated"})
        assert request.method == "GET"
        return httpx.Response(200, json=buckets[name])

    operation.provision_storage(VALUES, transport=httpx.MockTransport(handler))
    assert updated == list(operation.BUCKETS)


def test_public_bucket_is_refused_without_mutation(monkeypatch):
    monkeypatch.setattr(operation, "assert_provider_instance", lambda *a, **k: None, raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        return httpx.Response(200, json={"id": "openslate-ready", "public": True})

    with pytest.raises(operation.StorageProvisionError):
        operation.provision_storage(VALUES, transport=httpx.MockTransport(handler))


def test_unadmitted_provider_never_receives_the_privileged_key(monkeypatch):
    def deny(*args, **kwargs):
        raise InstanceTargetError("wrong installation")

    monkeypatch.setattr(operation, "assert_provider_instance", deny, raising=False)
    requests: list[bool] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(True)
        return httpx.Response(200)

    with pytest.raises(InstanceTargetError):
        operation.provision_storage(VALUES, transport=httpx.MockTransport(handler))
    assert not requests
