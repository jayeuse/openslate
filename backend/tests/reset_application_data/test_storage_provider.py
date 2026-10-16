"""Storage API inventory and cleanup for the guarded reset."""

import json

import httpx
import pytest

from operations.reset.models import ResetError
from operations.reset.storage import ResetStorage


def _storage_api(*, public_bucket: str | None = None):
    buckets = {
        "openslate-ready": {"folder/orphan", "folder/deep/unlinked"}
        | {f"root-{index:03d}" for index in range(101)},
        "openslate-avatars": {"user/account/avatar"},
    }
    deleted: list[tuple[str, tuple[str, ...]]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        parts = request.url.path.strip("/").split("/")
        assert parts[:2] == ["storage", "v1"]
        if parts[2] == "bucket" and request.method == "GET":
            bucket = parts[3]
            return httpx.Response(
                200, json={"id": bucket, "name": bucket, "public": bucket == public_bucket}
            )
        if parts[2:4] == ["object", "list"] and request.method == "POST":
            bucket = parts[4]
            options = json.loads(request.content)
            prefix = options["prefix"]
            names: dict[str, bool] = {}
            for key in buckets[bucket]:
                remainder = key[len(prefix) + 1:] if prefix else key
                if prefix and not key.startswith(prefix + "/"):
                    continue
                name, separator, _ = remainder.partition("/")
                names[name] = names.get(name, False) or bool(separator)
            ordered = sorted(names.items())
            page = ordered[options["offset"]:options["offset"] + options["limit"]]
            return httpx.Response(
                200, json=[{"name": name, "id": None if folder else name}
                           for name, folder in page]
            )
        if parts[2] == "object" and request.method == "DELETE":
            bucket = parts[3]
            keys = tuple(json.loads(request.content)["prefixes"])
            deleted.append((bucket, keys))
            buckets[bucket].difference_update(keys)
            return httpx.Response(200, json=[])
        raise AssertionError("Unexpected Storage request")

    return httpx.Client(transport=httpx.MockTransport(respond)), buckets, deleted


def test_storage_reset_lists_every_private_object_across_pages_and_nested_paths() -> None:
    client, buckets, deleted = _storage_api()
    storage = ResetStorage("http://provider.local", "server-secret", 2, client=client)

    keys = storage.list_object_keys()

    assert len(keys) == 104
    assert "openslate-avatars/user/account/avatar" in keys
    assert "openslate-ready/folder/deep/unlinked" in keys
    assert "openslate-ready/folder/orphan" in keys
    assert "openslate-ready/root-100" in keys
    storage.delete_and_verify_empty(keys)
    assert buckets == {"openslate-ready": set(), "openslate-avatars": set()}
    assert {bucket for bucket, _ in deleted} == set(buckets)
    assert storage.list_object_keys() == ()


def test_storage_reset_rejects_public_bucket_without_deleting_anything() -> None:
    client, buckets, deleted = _storage_api(public_bucket="openslate-ready")
    storage = ResetStorage("http://provider.local", "server-secret", 2, client=client)

    with pytest.raises(ResetError, match="private"):
        storage.list_object_keys()

    assert len(buckets["openslate-ready"]) == 103
    assert deleted == []


def test_storage_reset_rejects_changed_inventory_before_cleanup() -> None:
    client, buckets, deleted = _storage_api()
    storage = ResetStorage("http://provider.local", "server-secret", 2, client=client)
    keys = storage.list_object_keys()
    buckets["openslate-ready"].add("new-orphan")

    with pytest.raises(ResetError, match="plan changed"):
        storage.delete_and_verify_empty(keys)
    assert deleted == []
