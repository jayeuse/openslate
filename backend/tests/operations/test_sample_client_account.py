"""Public recovery and bounded authenticated SSE transport boundaries."""

import json
from pathlib import Path

import httpx
import pytest

from operations.sample_client import (
    SampleAuthenticationError,
    SampleClient,
    SampleClientError,
    SampleWriteOutcomeUnknown,
)

ORIGIN = "https://workspace.example.test"
TOKEN = "a" * 56
PASSWORD = "generated-fixture-password"
REQUEST_ID = "019c6e27-e55b-73d1-87d8-4e01f1f75043"


def _client(tmp_path: Path, handler) -> SampleClient:
    return SampleClient(
        "https://api.example.test",
        ORIGIN,
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )


def _login() -> httpx.Response:
    return httpx.Response(
        200,
        json={"authenticated": True, "setup_required": False},
        headers=[
            ("Set-Cookie", "openslate_access=private-access; Path=/; HttpOnly"),
            ("Set-Cookie", "openslate_csrf=private-csrf; Path=/"),
            ("X-Request-ID", REQUEST_ID),
        ],
    )


def test_recovery_completion_is_cookie_free_and_never_journals_action_material(tmp_path) -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _login()
        assert request.url.path == "/api/auth/recovery/complete"
        assert request.headers["origin"] == ORIGIN
        assert "cookie" not in request.headers and "x-csrf-token" not in request.headers
        assert json.loads(request.content) == {"token_hash": TOKEN, "password": PASSWORD}
        return httpx.Response(204, headers={"X-Request-ID": REQUEST_ID})

    with _client(tmp_path, handler) as client:
        assert client.complete_recovery(TOKEN, PASSWORD).status_code == 204
        client.login("person@example.test", PASSWORD)
        with pytest.raises(SampleAuthenticationError, match="cookie-free"):
            client.complete_recovery(TOKEN, PASSWORD)
    assert seen == ["/api/auth/recovery/complete", "/api/auth/login"]
    journal = (tmp_path / "requests.jsonl").read_text()
    for secret in (TOKEN, PASSWORD, "private-access", "private-csrf"):
        assert secret not in journal


def test_uncertain_recovery_write_is_not_replayed(tmp_path) -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(503, json={"detail": "Recovery service unavailable"})

    with _client(tmp_path, handler) as client:
        with pytest.raises(SampleWriteOutcomeUnknown):
            client.complete_recovery(TOKEN, PASSWORD)
    assert seen == ["/api/auth/recovery/complete"]


class _Stream(httpx.SyncByteStream):
    def __init__(self, content: bytes, *, failure: bool = False) -> None:
        self.content = content
        self.closed = False
        self.failure = failure

    def __iter__(self):
        if self.failure:
            raise httpx.ReadTimeout("synthetic private timeout")
        yield self.content
        raise AssertionError("The initial resync must close without reading later events")

    def close(self) -> None:
        self.closed = True


def test_event_probe_authenticates_reads_one_resync_and_closes_without_journaling_data(
    tmp_path,
) -> None:
    stream = _Stream(b": heartbeat\n\nevent: resync\ndata: {}\n\n")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        assert request.url.path == "/api/events" and not request.url.query
        assert request.headers["origin"] == ORIGIN
        assert request.headers["sec-fetch-site"] == "same-origin"
        assert request.headers["accept"] == "text/event-stream"
        assert "openslate_access=private-access" in request.headers["cookie"]
        assert "authorization" not in request.headers
        return httpx.Response(
            200,
            stream=stream,
            headers={
                "Content-Type": "text/event-stream",
                "X-Request-ID": REQUEST_ID,
            },
        )

    with _client(tmp_path, handler) as client:
        client.login("person@example.test", PASSWORD)
        evidence = client.check_event_stream()
    assert evidence == {"status_code": 200, "request_id": REQUEST_ID, "resyncs": 1}
    assert stream.closed
    journal = (tmp_path / "requests.jsonl").read_text()
    assert "private-access" not in journal and "heartbeat" not in journal
    entries = [json.loads(line) for line in journal.splitlines()]
    assert entries[-2]["method"] == "GET"
    assert entries[-2]["route_template"] == "/api/events"
    assert entries[-1]["status_code"] == 200


@pytest.mark.parametrize("mode", ["unauthorized", "wrong_content", "timeout", "oversized"])
def test_event_probe_fails_closed_and_releases_the_stream(tmp_path, mode) -> None:
    stream = _Stream(
        b"x" * 20_000 if mode == "oversized" else b"event: resync\ndata: {}\n\n",
        failure=mode == "timeout",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login()
        return httpx.Response(
            401 if mode == "unauthorized" else 200,
            stream=stream,
            headers={
                "Content-Type": "application/json"
                if mode == "wrong_content"
                else "text/event-stream",
            },
        )

    with _client(tmp_path, handler) as client:
        client.login("person@example.test", PASSWORD)
        with pytest.raises(SampleClientError) as error:
            client.check_event_stream()
    assert stream.closed and "private" not in str(error.value)
