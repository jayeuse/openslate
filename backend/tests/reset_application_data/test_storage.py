"""Storage API safety contracts for the local reset utility."""

import json
import subprocess

import httpx
import pytest

from scripts.reset_models import ResetError
from scripts.reset_storage import ResetStorage, require_api_stopped, validate_local_storage_url


def test_storage_inventory_includes_orphans_deletes_in_bounded_batches_and_verifies_empty() -> None:
    objects = [f"object-{number}" for number in range(1_001)] + ["orphan-not-in-files"]
    nested_objects = ["nested-orphan-not-in-files"]
    deleted: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/storage/v1/object/list/openslate-files":
            payload = json.loads(request.content)
            offset = payload["offset"]
            limit = payload["limit"]
            if payload["prefix"] == "":
                page = objects[offset : offset + limit]
                rows = [{"name": key, "id": key} for key in page]
                if offset + limit >= len(objects):
                    rows.append({"name": "nested", "id": None})
                return httpx.Response(200, json=rows)
            if payload["prefix"] == "nested/":
                page = nested_objects[offset : offset + limit]
                return httpx.Response(200, json=[{"name": key, "id": key} for key in page])
            return httpx.Response(400)
        if request.url.path == "/storage/v1/object/openslate-files":
            prefixes = json.loads(request.content)["prefixes"]
            deleted.append(prefixes)
            for key in prefixes:
                (nested_objects if key.startswith("nested/") else objects).remove(
                    key.removeprefix("nested/")
                )
            return httpx.Response(200, json={})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    storage = ResetStorage(
        "http://127.0.0.1:54321",
        "test-secret",
        client_factory=lambda **kwargs: httpx.Client(transport=transport, **kwargs),
    )

    inventory = storage.list_object_keys()
    assert inventory[-1] == "orphan-not-in-files"
    assert "nested/nested-orphan-not-in-files" in inventory
    storage.delete_and_verify_empty(inventory)

    assert objects == [] and nested_objects == []
    assert [len(batch) for batch in deleted] == [1_000, 3]


def test_storage_inventory_failure_never_leaks_object_keys() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="private-object-key")

    storage = ResetStorage(
        "http://127.0.0.1:54321",
        "test-secret",
        client_factory=lambda **kwargs: httpx.Client(
            transport=httpx.MockTransport(handler), **kwargs
        ),
    )

    with pytest.raises(ResetError) as error:
        storage.list_object_keys()

    assert "private-object-key" not in str(error.value)


def test_storage_inventory_rejects_duplicate_object_keys() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[{"name": "duplicate", "id": "first"}, {"name": "duplicate", "id": "second"}],
        )

    storage = ResetStorage(
        "http://127.0.0.1:54321",
        "test-secret",
        client_factory=lambda **kwargs: httpx.Client(
            transport=httpx.MockTransport(handler), **kwargs
        ),
    )

    with pytest.raises(ResetError, match="ambiguous"):
        storage.list_object_keys()


def test_local_storage_and_api_writer_admission_fail_closed() -> None:
    assert validate_local_storage_url(
        "http://127.0.0.1:54321", expected_url="http://127.0.0.1:54321/"
    ) is None
    assert require_api_stopped(
        "8000", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1)
    ) is None

    with pytest.raises(ResetError, match="API server must be stopped"):
        require_api_stopped(
            "8000", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0)
        )
    with pytest.raises(ResetError, match="Storage API"):
        validate_local_storage_url("http://127.0.0.1:54322")
