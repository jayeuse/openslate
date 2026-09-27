"""Storage API boundary: immutable private objects and explicit uncertainty."""

from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from app.systems.platform.files import storage as storage_module
from app.systems.platform.files.providers import ProviderRejected, ProviderUnavailable
from app.systems.platform.files.supabase_storage import SupabaseStorage

KEY = "a" * 32
CONTENT = b"scanned bytes"
DIGEST = sha256(CONTENT).hexdigest()


class StorageAPI:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.missing_status = 404
        self.duplicate_status = 409
        self.duplicate_code = "ResourceAlreadyExists"
        self.fail_copy: int | None = None
        self.fail_delete: int | None = None
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.headers["apikey"] == "server-secret"
        assert request.headers["authorization"] == "Bearer server-secret"
        parts = request.url.path.removeprefix("/storage/v1/").split("/")
        if parts[:2] == ["object", "copy"]:
            assert request.headers.get("x-upsert") != "true"
            if self.fail_copy is not None:
                return httpx.Response(self.fail_copy, json={"code": "DatabaseError"})
            data = __import__("json").loads(request.content)
            source = (data["bucketId"], data["sourceKey"])
            target = (data["destinationBucket"], data["destinationKey"])
            if source not in self.objects:
                return httpx.Response(self.missing_status, json={"code": "NoSuchKey"})
            if target in self.objects:
                return httpx.Response(
                    self.duplicate_status, json={"code": self.duplicate_code}
                )
            self.objects[target] = self.objects[source]
            return httpx.Response(200, json={"Key": "/".join(target)})
        if parts[:2] == ["object", "authenticated"]:
            bucket, key = parts[2:]
        else:
            bucket, key = parts[1:]
        item = (bucket, key)
        if request.method == "POST":
            assert request.headers.get("x-upsert") != "true"
            if item in self.objects:
                return httpx.Response(
                    self.duplicate_status, json={"code": self.duplicate_code}
                )
            self.objects[item] = request.content
            return httpx.Response(200, json={"Key": "/".join(item)})
        if request.method == "DELETE":
            if self.fail_delete is not None:
                return httpx.Response(self.fail_delete, json={"code": "DatabaseError"})
            if item not in self.objects:
                return httpx.Response(self.missing_status, json={"code": "NoSuchKey"})
            del self.objects[item]
            return httpx.Response(200, json={"message": "Successfully deleted"})
        if item not in self.objects:
            return httpx.Response(self.missing_status, json={"code": "NoSuchKey"})
        return httpx.Response(200, content=self.objects[item])


def make_storage(api: StorageAPI) -> SupabaseStorage:
    client = httpx.Client(transport=httpx.MockTransport(api), follow_redirects=False)
    return SupabaseStorage("http://storage.internal", "server-secret", 2, client=client)


def test_upload_is_immutable_and_ready_bytes_require_promotion() -> None:
    api = StorageAPI()
    storage = make_storage(api)
    storage.upload(KEY, CONTENT, "application/octet-stream")
    assert storage.read_quarantine(KEY) == CONTENT
    assert storage.download(KEY) is None
    with pytest.raises(ProviderRejected):
        storage.upload(KEY, b"replacement", "application/octet-stream")
    assert storage.read_quarantine(KEY) == CONTENT
    storage.promote(KEY, expected_digest=DIGEST, expected_size=len(CONTENT))
    assert storage.download(KEY) == CONTENT
    assert storage.read_quarantine(KEY) is None
    assert storage.stat(KEY, quarantine=False).digest == DIGEST


def test_promotion_recovers_exact_ready_copy_after_quarantine_was_removed() -> None:
    api = StorageAPI()
    api.objects[("openslate-ready", KEY)] = CONTENT
    make_storage(api).promote(KEY, expected_digest=DIGEST, expected_size=len(CONTENT))
    assert api.objects == {("openslate-ready", KEY): CONTENT}


def test_promotion_rejects_conflicting_ready_bytes_without_overwriting() -> None:
    api = StorageAPI()
    api.objects[("openslate-quarantine", KEY)] = CONTENT
    api.objects[("openslate-ready", KEY)] = b"different"
    with pytest.raises(ProviderRejected):
        make_storage(api).promote(KEY, expected_digest=DIGEST, expected_size=len(CONTENT))
    assert api.objects[("openslate-ready", KEY)] == b"different"


def test_copy_failure_retains_quarantine_for_retry() -> None:
    api = StorageAPI()
    api.objects[("openslate-quarantine", KEY)] = CONTENT
    api.fail_copy = 503
    with pytest.raises(ProviderUnavailable):
        make_storage(api).promote(KEY, expected_digest=DIGEST, expected_size=len(CONTENT))
    assert api.objects == {("openslate-quarantine", KEY): CONTENT}


def test_delete_confirms_both_locations_absent_and_retries_idempotently() -> None:
    api = StorageAPI()
    api.objects[("openslate-quarantine", KEY)] = CONTENT
    api.objects[("openslate-ready", KEY)] = CONTENT
    storage = make_storage(api)
    storage.delete(KEY)
    storage.delete(KEY)
    assert api.objects == {}


def test_confirmed_missing_object_code_at_live_provider_status_is_absent() -> None:
    api = StorageAPI()
    api.missing_status = 400
    storage = make_storage(api)
    assert storage.read_quarantine(KEY) is None
    assert storage.download(KEY) is None
    storage.delete(KEY)
    assert api.objects == {}


def test_live_provider_duplicate_code_rejects_without_replacing_bytes() -> None:
    api = StorageAPI()
    api.duplicate_status = 400
    api.duplicate_code = "KeyAlreadyExists"
    storage = make_storage(api)
    storage.upload(KEY, CONTENT, "application/octet-stream")
    with pytest.raises(ProviderRejected):
        storage.upload(KEY, b"replacement", "application/octet-stream")
    assert storage.read_quarantine(KEY) == CONTENT


def test_bucket_or_auth_404_is_not_object_absence() -> None:
    def unavailable(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"code": "NoSuchBucket"})

    client = httpx.Client(transport=httpx.MockTransport(unavailable))
    storage = SupabaseStorage("http://storage.internal", "server-secret", 2, client=client)
    with pytest.raises(ProviderUnavailable):
        storage.download(KEY)
    with pytest.raises(ProviderUnavailable):
        storage.delete(KEY)


def test_redirect_and_oversized_download_fail_closed() -> None:
    def redirect(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://attacker.example/bytes"})

    client = httpx.Client(transport=httpx.MockTransport(redirect))
    storage = SupabaseStorage("http://storage.internal", "server-secret", 2, client=client)
    with pytest.raises(ProviderUnavailable):
        storage.download(KEY)

    api = StorageAPI()
    api.objects[("openslate-ready", KEY)] = b"x" * (25 * 1024 * 1024 + 1)
    with pytest.raises(ProviderUnavailable):
        make_storage(api).download(KEY)


def test_invalid_key_and_content_size_are_rejected_before_request() -> None:
    api = StorageAPI()
    storage = make_storage(api)
    with pytest.raises(ProviderRejected):
        storage.upload("../secret", b"data", "application/octet-stream")
    with pytest.raises(ProviderRejected):
        storage.upload(KEY, b"x" * (25 * 1024 * 1024 + 1), "application/octet-stream")
    assert api.requests == []


def test_product_factory_uses_server_only_supabase_settings(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(
        storage_module,
        "get_settings",
        lambda: SimpleNamespace(
            files_storage_root=tmp_path / "unused-local-root",
            supabase_url="http://storage.internal",
            supabase_secret_key=SecretStr("server-secret"),
            supabase_timeout_seconds=2,
        ),
    )
    result = storage_module.get_storage()
    assert isinstance(result, SupabaseStorage)
    assert not (tmp_path / "unused-local-root").exists()
