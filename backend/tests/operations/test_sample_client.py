"""Transport contract for the authenticated sample-data API client."""

import json
import stat
import time
from pathlib import Path

import httpx
import pytest

from operations.sample_client import (
    SampleAuthenticationError,
    SampleClient,
    SampleClientError,
    SampleRateLimitedError,
    SampleWriteOutcomeUnknown,
)

ORIGIN = "https://workspace.example.test"
BASE_URL = "https://api.example.test"
EMAIL = "sample-admin@example.test"
PASSWORD = "synthetic-test-password"
ACCESS = "synthetic-access-cookie"
REFRESH = "synthetic-refresh-cookie"
CSRF = "synthetic-csrf-cookie"
REQUEST_ID = "019c6e27-e55b-73d1-87d8-4e01f1f75043"


def _client(tmp_path: Path, handler: httpx.MockTransport | None = None) -> SampleClient:
    return SampleClient(
        BASE_URL,
        ORIGIN,
        tmp_path / "private" / "requests.jsonl",
        transport=handler,
    )


def _login_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={"authenticated": True, "setup_required": False},
        headers=[
            ("set-cookie", f"openslate_access={ACCESS}; Path=/; HttpOnly"),
            ("set-cookie", f"openslate_refresh={REFRESH}; Path=/api/auth; HttpOnly"),
            ("set-cookie", f"openslate_csrf={CSRF}; Path=/"),
            ("X-Request-ID", REQUEST_ID),
        ],
    )


def test_invitation_completion_is_public_and_never_uses_an_admin_session(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        assert request.url.path == "/api/auth/invitations/complete"
        assert request.headers["origin"] == ORIGIN
        assert "cookie" not in request.headers
        assert "x-csrf-token" not in request.headers
        assert json.loads(request.content) == {"token_hash": "a" * 56, "password": PASSWORD}
        return httpx.Response(204)

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        assert client.complete_invitation("a" * 56, PASSWORD).status_code == 204
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleAuthenticationError, match="cookie-free"):
            client.complete_invitation("a" * 56, PASSWORD)
    journal = (tmp_path / "private" / "requests.jsonl").read_text()
    assert PASSWORD not in journal and "a" * 56 not in journal


def test_login_and_mutation_use_ui_cookie_csrf_origin_and_private_request_journal(
    tmp_path: Path,
) -> None:
    observed: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        if request.url.path == "/api/auth/login":
            assert request.headers["origin"] == ORIGIN
            assert json.loads(request.content) == {"email": EMAIL, "password": PASSWORD}
            return _login_response()
        assert request.url.path == "/api/records/record-1"
        assert request.headers["origin"] == ORIGIN
        assert request.headers["x-csrf-token"] == CSRF
        cookie = request.headers["cookie"]
        assert f"openslate_access={ACCESS}" in cookie
        assert f"openslate_csrf={CSRF}" in cookie
        return httpx.Response(200, json={"id": "record-1"}, headers={"X-Request-ID": REQUEST_ID})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        assert client.login(EMAIL, PASSWORD).status_code == 200
        response = client.request(
            "PATCH",
            "/api/records/record-1",
            params={"sensitive_query": "query-secret"},
            json_body={"private_value": "payload-secret"},
        )
        assert response.json() == {"id": "record-1"}

    journal = tmp_path / "private" / "requests.jsonl"
    entries = [json.loads(line) for line in journal.read_text().splitlines()]
    assert [entry["event"] for entry in entries] == [
        "request_started",
        "request_finished",
        "request_started",
        "request_finished",
    ]
    assert entries[1]["request_id"] == REQUEST_ID
    assert entries[3]["request_id"] == REQUEST_ID
    assert stat.S_IMODE(journal.stat().st_mode) == 0o600
    serialized = journal.read_text()
    for secret in (EMAIL, PASSWORD, ACCESS, REFRESH, CSRF, "payload-secret", "query-secret"):
        assert secret not in serialized
    assert len(observed) == 2


def test_cookie_jars_are_isolated_and_missing_csrf_stops_before_a_write(tmp_path: Path) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _login_response()

    transport = httpx.MockTransport(handler)
    with _client(tmp_path, transport) as first, _client(tmp_path, transport) as second:
        assert first.login(EMAIL, PASSWORD).status_code == 200
        with pytest.raises(SampleAuthenticationError, match="CSRF"):
            second.request("POST", "/api/records", json_body={"name": "Sensitive"})

    assert len(requests) == 1
    assert requests[0].url.path == "/api/auth/login"


def test_session_auth_headers_cannot_be_replaced_by_a_caller(tmp_path: Path) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _login_response()

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleAuthenticationError) as rejected:
            client.request(
                "POST",
                "/api/records",
                headers={"Authorization": "Bearer provider-secret"},
                json_body={"name": "record"},
            )

    assert "provider-secret" not in str(rejected.value)
    assert len(requests) == 1


def test_refresh_uses_refresh_cookie_csrf_and_updates_the_private_actor_session(
    tmp_path: Path,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return _login_response()
        if request.url.path == "/api/auth/refresh":
            assert request.headers["origin"] == ORIGIN
            assert request.headers["x-csrf-token"] == CSRF
            assert f"openslate_refresh={REFRESH}" in request.headers["cookie"]
            return httpx.Response(
                200,
                json={"authenticated": True, "setup_required": False},
                headers=[
                    ("set-cookie", "openslate_access=renewed-access; Path=/; HttpOnly"),
                    ("set-cookie", "openslate_csrf=renewed-csrf; Path=/"),
                    ("X-Request-ID", REQUEST_ID),
                ],
            )
        assert request.url.path == "/api/records"
        return httpx.Response(200, json={"id": "record"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        assert client.refresh().status_code == 200
        response = client.request("POST", "/api/records", json_body={"name": "safe"})
        assert response.status_code == 200

    assert [request.url.path for request in seen] == [
        "/api/auth/login",
        "/api/auth/refresh",
        "/api/records",
    ]
    assert seen[2].headers["x-csrf-token"] == "renewed-csrf"


def test_multipart_upload_keeps_the_browser_session_headers(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return _login_response()
        assert request.headers["origin"] == ORIGIN
        assert request.headers["x-csrf-token"] == CSRF
        assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
        assert b"demo-file-bytes" in request.content
        assert b"attachment" in request.content
        return httpx.Response(201, json={"id": "file"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        response = client.request(
            "POST",
            "/api/files",
            data={"purpose": "attachment"},
            files={"file": ("sample.txt", b"demo-file-bytes", "text/plain")},
        )

    assert response.status_code == 201
    assert len(seen) == 2


def test_raw_file_upload_preserves_octet_stream_bytes_and_never_journals_them(
    tmp_path: Path,
) -> None:
    seen: list[httpx.Request] = []
    file_bytes = b"%PDF-private-demo\x00\xff"

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/api/auth/login":
            return _login_response()
        assert request.method == "PUT"
        assert request.url.path == "/api/boards/board-1/files/file-1/content"
        assert request.headers["origin"] == ORIGIN
        assert request.headers["x-csrf-token"] == CSRF
        assert request.headers["content-type"] == "application/octet-stream"
        assert request.content == file_bytes
        return httpx.Response(204)

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        response = client.request(
            "PUT",
            "/api/boards/board-1/files/file-1/content",
            headers={"Content-Type": "application/octet-stream"},
            content=file_bytes,
        )

    assert response.status_code == 204
    journal = (tmp_path / "private" / "requests.jsonl").read_bytes()
    assert file_bytes not in journal
    assert len(seen) == 2


def test_unauthorized_write_is_not_refreshed_or_replayed(tmp_path: Path) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _login_response()
        return httpx.Response(401, json={"detail": "Invalid authentication credentials"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleAuthenticationError, match="not replayed"):
            client.request("POST", "/api/records", json_body={"name": "record"})

    assert seen == ["/api/auth/login", "/api/records"]


def test_write_server_error_is_unknown_and_does_not_expose_response_content(
    tmp_path: Path,
) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _login_response()
        return httpx.Response(
            503,
            text="provider-secret",
            headers={"X-Request-ID": REQUEST_ID},
        )

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleWriteOutcomeUnknown) as unknown:
            client.request("POST", "/api/records", json_body={"name": "record"})

    assert unknown.value.status_code == 503
    assert unknown.value.request_id == REQUEST_ID
    assert "provider-secret" not in str(unknown.value)
    assert seen == ["/api/auth/login", "/api/records"]
    entries = [
        json.loads(line)
        for line in (tmp_path / "private" / "requests.jsonl").read_text().splitlines()
    ]
    assert entries[-1]["failure_code"] == "other"


@pytest.mark.parametrize(
    "method,path,failures,success,attempts,delays,code",
    [
        ("POST", "/api/records", 1, 201, 2, [0.1], "rollback_busy"),
        ("PATCH", f"/api/records/{REQUEST_ID}", 1, 200, 2, [0.1], "rollback_busy"),
        ("POST", "/api/records", 3, None, 3, [0.1, 0.3], "rollback_busy"),
        ("POST", "/api/relationships", 3, None, 1, [], "relationship_busy"),
        (
            "PUT",
            "/api/relationships/fields/field-id/sources/source-id",
            3,
            None,
            1,
            [],
            "relationship_busy",
        ),
        ("POST", "/api/records/not-a-record-id", 3, None, 1, [], "other"),
    ],
)
def test_only_confirmed_prewrite_record_503_gets_bounded_retry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    failures: int,
    success: int | None,
    attempts: int,
    delays: list[float],
    code: str,
) -> None:
    seen: list[str] = []
    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", slept.append)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        seen.append(request.url.path)
        if len(seen) <= failures:
            return httpx.Response(
                503, json={"detail": "Relationship operation is temporarily unavailable"}
            )
        return httpx.Response(success, json={"id": "record"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        if success is None:
            with pytest.raises(SampleWriteOutcomeUnknown):
                client.request(method, path, json_body={})
        else:
            assert client.request(method, path, json_body={}).status_code == success

    assert seen == [path] * attempts
    assert slept == delays
    entries = [
        json.loads(line)
        for line in (tmp_path / "private" / "requests.jsonl").read_text().splitlines()
    ]
    assert {entry["failure_code"] for entry in entries if entry.get("status_code") == 503} == {code}


def test_write_rate_limit_is_reported_without_replay(tmp_path: Path) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _login_response()
        return httpx.Response(429, headers={"Retry-After": "0"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleRateLimitedError, match="no write was replayed") as limited:
            client.request("POST", "/api/records", json_body={"name": "record"})

    assert limited.value.status_code == 429
    assert seen == ["/api/auth/login", "/api/records"]


def test_journal_failure_stops_before_any_api_request(tmp_path: Path) -> None:
    calls: list[httpx.Request] = []
    journal_is_directory = tmp_path / "journal-directory"
    journal_is_directory.mkdir()

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200)

    with SampleClient(
        BASE_URL,
        ORIGIN,
        journal_is_directory,
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(SampleClientError, match="private sample journal"):
            client.request("GET", "/api/records")

    assert calls == []


def test_get_rate_limit_retries_once_and_stops_at_the_bound(tmp_path: Path, monkeypatch) -> None:
    seen: list[str] = []
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _login_response()
        return httpx.Response(429, headers={"Retry-After": "1"})

    monkeypatch.setattr(time, "sleep", sleeps.append)
    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleRateLimitedError):
            client.request("GET", "/api/records")

    assert seen == ["/api/auth/login", "/api/records", "/api/records"]
    assert sleeps == [1.0]


def test_transport_failure_on_write_records_unknown_outcome_without_secrets(
    tmp_path: Path,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/auth/login":
            return _login_response()
        raise httpx.ConnectError("failure included payload-secret", request=request)

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleWriteOutcomeUnknown) as unknown:
            client.request("POST", "/api/records", json_body={"private": "payload-secret"})

    assert len(requests) == 2
    assert "payload-secret" not in str(unknown.value)
    journal = (tmp_path / "private" / "requests.jsonl").read_text()
    assert "outcome_unknown" in journal
    assert "payload-secret" not in journal
    assert PASSWORD not in journal


def test_only_explicit_safe_identifier_mappings_enter_the_journal(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        client.record_mapping("record", "customer:001", "019c6e27-e55b-73d1-87d8-4e01f1f75043")
        with pytest.raises(ValueError):
            client.record_mapping(
                "person", "jane@example.test", "019c6e27-e55b-73d1-87d8-4e01f1f75044"
            )
        with pytest.raises(ValueError):
            client.record_mapping("person", "jane-001", "provider-secret")

    journal = (tmp_path / "private" / "requests.jsonl").read_text()
    assert '"event":"id_mapping"' in journal
    assert "customer:001" in journal
    assert "jane@example.test" not in journal
    assert "provider-secret" not in journal


def test_a_busy_relationship_write_is_reported_as_busy_without_a_retry(tmp_path: Path) -> None:
    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        attempts.append(request.url.path)
        return httpx.Response(
            503, json={"detail": "Relationship operation is temporarily unavailable"}
        )

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        with pytest.raises(SampleWriteOutcomeUnknown) as raised:
            client.request("POST", "/api/relationships", json_body={})
    assert raised.value.failure_code == "relationship_busy"
    assert attempts == ["/api/relationships"]
