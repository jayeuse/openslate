"""The read-only file and Storage check: each difference kind, the clean case, exit codes."""

import json
from uuid import UUID

import httpx
import pytest

from operations import check_file_storage as check
from operations.storage.listing import StorageListingError, list_bucket

ORG = "0198a0b0-0000-7000-8000-000000000001"
USER = "0198a0b0-0000-7000-8000-000000000002"
READY_KEY = f"org/{ORG}/{'a' * 32}"
AVATAR_KEY = f"user/{USER}/{'b' * 32}"


def _row(number: int, key: str, state: str = "ready", size: int | None = 10) -> check.FileRow:
    return check.FileRow(UUID(int=number), key, state, size)


class Storage:
    """A Storage double: nested folders, paged lists, sizes in the object metadata."""

    def __init__(self, buckets: dict[str, dict[str, int]], *, fault: bool = False) -> None:
        self.buckets = buckets
        self.fault = fault
        self.methods: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.methods.append(request.method)
        bucket = request.url.path.removeprefix("/storage/v1/object/list/")
        if self.fault or bucket not in self.buckets:
            return httpx.Response(500, json={"code": "Internal"})
        body = json.loads(request.content)
        prefix, names = body["prefix"], {}
        for key, size in self.buckets[bucket].items():
            if prefix and not key.startswith(prefix + "/"):
                continue
            head, _, rest = key[len(prefix) + 1 if prefix else 0 :].partition("/")
            names[head] = None if rest else size
        page = sorted(names)[body["offset"] : body["offset"] + body["limit"]]
        return httpx.Response(200, json=[
            {"name": name, "id": None, "metadata": None} if names[name] is None
            else {"name": name, "id": f"id-{name}", "metadata": {"size": names[name]}}
            for name in page
        ])


def _objects(storage: Storage) -> dict[str, dict[str, int | None]]:
    with httpx.Client(
        base_url="http://owned.test/storage/v1/", transport=httpx.MockTransport(storage)
    ) as client:
        return check.list_objects(client)


def test_an_unchanged_installation_reports_no_difference() -> None:
    inventory = check.Inventory([_row(1, READY_KEY), _row(2, AVATAR_KEY, size=7)])
    storage = Storage({
        "slateops-ready": {READY_KEY: 10},
        "slateops-avatars": {AVATAR_KEY: 7},
    })

    result = check.report(inventory, _objects(storage))

    assert result["status"] == "ok" and result["differences"] == []
    assert result["ready_files"] == 2
    assert result["objects"] == {"slateops-ready": 1, "slateops-avatars": 1}
    assert set(storage.methods) == {"POST"}  # Listing only: the check changes nothing.


def test_each_difference_names_its_kind_bucket_and_file() -> None:
    missing, resized = f"org/{ORG}/{'c' * 32}", f"org/{ORG}/{'d' * 32}"
    purged, orphan = f"org/{ORG}/{'e' * 32}", f"user/{USER}/{'f' * 32}"
    inventory = check.Inventory([
        _row(1, READY_KEY), _row(2, missing), _row(3, resized, size=10),
        _row(4, purged, state="purged", size=None),
    ])
    storage = Storage({
        "slateops-ready": {READY_KEY: 10, resized: 11, purged: 5},
        "slateops-avatars": {orphan: 3},
    })

    result = check.report(inventory, _objects(storage))

    assert result["status"] == "attention"
    assert sorted(
        (item["kind"], item["bucket"], item["file_id"], item["expected_size"],
         item["object_size"])
        for item in result["differences"]
    ) == [
        ("extra_object", "slateops-avatars", None, None, 3),
        ("extra_object", "slateops-ready", str(UUID(int=4)), None, 5),
        ("missing_object", "slateops-ready", str(UUID(int=2)), 10, None),
        ("size_difference", "slateops-ready", str(UUID(int=3)), 10, 11),
    ]


def test_objects_of_unfinished_operations_and_comms_exports_are_expected() -> None:
    uploading, deleting = f"org/{ORG}/{'1' * 32}", f"org/{ORG}/{'2' * 32}"
    export = f"org/{ORG}/{'3' * 32}"
    inventory = check.Inventory(
        [_row(1, uploading, state="uploading"), _row(2, deleting, state="deleting")],
        {export},
    )
    storage = Storage({
        "slateops-ready": {uploading: 4, deleting: 4, export: 9},
        "slateops-avatars": {},
    })

    assert check.report(inventory, _objects(storage))["differences"] == []


def test_the_listing_reads_every_page_and_folder() -> None:
    keys = {f"org/{ORG}/{number:032x}": number + 1 for number in range(205)}
    storage = Storage({"slateops-ready": keys})
    with httpx.Client(
        base_url="http://owned.test/storage/v1/", transport=httpx.MockTransport(storage)
    ) as client:
        assert list_bucket(client, "slateops-ready") == keys
        with pytest.raises(StorageListingError):
            list_bucket(client, "slateops-unknown")


@pytest.mark.parametrize(
    ("objects", "code"),
    [
        pytest.param({"slateops-ready": {READY_KEY: 10}, "slateops-avatars": {}}, 0, id="ok"),
        pytest.param({"slateops-ready": {}, "slateops-avatars": {}}, 1, id="attention"),
        pytest.param(None, 2, id="unavailable"),
    ],
)
def test_the_command_exit_code_follows_the_result(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    objects: dict[str, dict[str, int]] | None, code: int,
) -> None:
    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def execute(self, *_args, **_kwargs):
            return None

        def rollback(self):
            return None

    class Engine:
        def connect(self):
            return Connection()

    monkeypatch.setattr(check, "get_engine", Engine)
    monkeypatch.setattr(check, "read_inventory", lambda _c: check.Inventory([_row(1, READY_KEY)]))
    monkeypatch.setattr(check, "environment_inputs", lambda _path: {})
    monkeypatch.setattr(
        check, "_storage_client",
        lambda _values: httpx.Client(
            base_url="http://owned.test/storage/v1/",
            transport=httpx.MockTransport(Storage({}, fault=True)),
        ),
    )
    if objects is not None:
        monkeypatch.setattr(check, "list_objects", lambda _client: objects)

    assert check.main() == code
    printed = json.loads(capsys.readouterr().out)
    assert printed["status"] == {0: "ok", 1: "attention", 2: "unavailable"}[code]
