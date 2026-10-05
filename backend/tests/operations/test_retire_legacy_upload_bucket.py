"""The one-time legacy upload bucket retirement: dry run, execute, idempotence, failures."""

import functools
import json

import httpx
import pytest

from app.core.config.instance import InstanceTargetError
from operations import retire_legacy_upload_bucket as operation

VALUES = {
    "DATABASE_URL": "synthetic-runtime-url", "SUPABASE_URL": "http://owned.test",
    "SUPABASE_SECRET_KEY": "synthetic-secret", "ENVIRONMENT": "production",
}
BUCKET = "/storage/v1/bucket/openslate-quarantine"
OBJECTS = "/storage/v1/object/openslate-quarantine"
LIST = "/storage/v1/object/list/openslate-quarantine"


class Provider:
    """A Storage double with one legacy bucket, nested keys, and injectable faults."""

    def __init__(self, keys: set[str] | None = None, *, fault: str = "") -> None:
        self.exists = keys is not None
        self.keys = set(keys or ())
        self.fault = fault
        self.requests: list[tuple[str, str]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        self.requests.append((method, path))
        assert request.headers["apikey"] == "synthetic-secret"
        assert "openslate-ready" not in str(request.url)
        if self.fault == "unavailable":
            raise httpx.ConnectError("synthetic outage", request=request)
        if path == BUCKET and method == "GET":
            if not self.exists:
                return httpx.Response(400, json={"code": "NoSuchBucket"})
            return httpx.Response(200, json={"id": "openslate-quarantine", "public": False})
        if not self.exists:
            return httpx.Response(400, json={"code": "NoSuchBucket"})
        if path == LIST and method == "POST":
            if self.fault == "list" and any(m == "DELETE" for m, _ in self.requests):
                return httpx.Response(500, json={"code": "Internal"})
            return self._list(json.loads(request.content))
        if path == OBJECTS and method == "DELETE":
            if self.fault == "objects":
                return httpx.Response(500, json={"code": "Internal"})
            if self.fault != "objects-ignored":
                self.keys -= set(json.loads(request.content)["prefixes"])
            return httpx.Response(200, json=[])
        if path == BUCKET and method == "DELETE":
            if self.fault == "bucket" or self.keys:
                return httpx.Response(400, json={"code": "InvalidRequest"})
            if self.fault != "bucket-ignored":
                self.exists = False
            return httpx.Response(200, json={"message": "Successfully deleted"})
        raise AssertionError(f"unexpected request {method} {path}")

    def _list(self, body: dict) -> httpx.Response:
        prefix = body["prefix"]
        names: dict[str, bool] = {}
        for key in self.keys:
            if prefix and not key.startswith(prefix + "/"):
                continue
            head, _, rest = key[len(prefix) + 1 if prefix else 0 :].partition("/")
            names[head] = names.get(head, False) or bool(rest)
        page = sorted(names)[body["offset"] : body["offset"] + body["limit"]]
        return httpx.Response(
            200, json=[{"name": n, "id": None if names[n] else f"id-{n}"} for n in page]
        )

    @property
    def mutations(self) -> list[tuple[str, str]]:
        return [request for request in self.requests if request[0] == "DELETE"]


KEYS = {f"{n:032x}" for n in range(203)} | {"legacy/a", "legacy/deeper/b"}


@pytest.fixture(autouse=True)
def admitted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(operation, "assert_provider_instance", lambda *a, **k: None)


def run(provider: Provider, *, execute: bool) -> str:
    return operation.retire_legacy_upload_bucket(
        VALUES, execute=execute, transport=httpx.MockTransport(provider)
    )


def test_dry_run_counts_every_page_and_folder_and_changes_nothing() -> None:
    provider = Provider(set(KEYS))

    message = run(provider, execute=False)

    assert "holds 205 objects" in message and "Nothing was deleted" in message
    assert provider.mutations == [] and provider.keys == KEYS and provider.exists


def test_execute_deletes_every_object_then_the_bucket_and_confirms_it_is_gone() -> None:
    provider = Provider(set(KEYS))

    message = run(provider, execute=True)

    assert message.startswith("Deleted 205 objects") and "confirms the bucket is gone" in message
    assert not provider.exists and not provider.keys
    assert provider.mutations[-1] == ("DELETE", BUCKET)
    assert provider.requests[-1] == ("GET", BUCKET)


@pytest.mark.parametrize("execute", (False, True))
def test_an_absent_bucket_is_nothing_to_retire(execute: bool) -> None:
    provider = Provider(None)

    assert run(provider, execute=execute).startswith("Nothing to retire")
    assert provider.requests == [("GET", BUCKET)]


def test_a_retired_bucket_stays_retired_on_a_second_run() -> None:
    provider = Provider({"only"})
    run(provider, execute=True)

    assert run(provider, execute=True).startswith("Nothing to retire")


@pytest.mark.parametrize(
    "fault", ("unavailable", "list", "objects", "objects-ignored", "bucket", "bucket-ignored")
)
def test_a_provider_failure_never_claims_success(fault: str) -> None:
    with pytest.raises(operation.RetirementError):
        run(Provider(set(KEYS), fault=fault), execute=True)


def test_an_unadmitted_provider_never_receives_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    def deny(*args, **kwargs):
        raise InstanceTargetError("wrong installation")

    monkeypatch.setattr(operation, "assert_provider_instance", deny)
    provider = Provider(set(KEYS))

    with pytest.raises(InstanceTargetError):
        run(provider, execute=False)
    assert provider.requests == []


def _command(monkeypatch: pytest.MonkeyPatch, provider: Provider, environment: str) -> None:
    monkeypatch.setattr(
        operation, "environment_inputs", lambda _path: {**VALUES, "ENVIRONMENT": environment}
    )
    monkeypatch.setattr(
        operation,
        "retire_legacy_upload_bucket",
        functools.partial(
            operation.retire_legacy_upload_bucket, transport=httpx.MockTransport(provider)
        ),
    )


def test_execute_outside_development_needs_confirm(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = Provider(set(KEYS))
    _command(monkeypatch, provider, "production")

    with pytest.raises(SystemExit, match="--confirm"):
        operation.main(["--execute"])
    assert provider.requests == []


def test_the_command_exits_non_zero_and_prints_no_success_on_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _command(monkeypatch, Provider(set(KEYS), fault="bucket"), "development")

    with pytest.raises(SystemExit) as failure:
        operation.main(["--execute"])

    assert failure.value.code not in (0, None)
    assert "failed" in str(failure.value.code)
    assert capsys.readouterr().out == ""


def test_the_command_prints_the_dry_run_report(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    provider = Provider({"one", "two"})
    _command(monkeypatch, provider, "production")

    operation.main([])

    assert "holds 2 objects" in capsys.readouterr().out
    assert provider.mutations == []
