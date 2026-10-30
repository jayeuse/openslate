"""Transport contract for the authenticated sample-data API client."""

import json
import stat
import time
from pathlib import Path

import httpx
import pytest

from operations.sample.client import (
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


def test_publication_waits_longer_than_ordinary_requests(tmp_path: Path) -> None:
    # A live run saw a 23.7 s publication succeed after the 20 s default gave up;
    # the browser has no such limit, so a publish must not become "outcome unknown".
    timeouts: dict[str, float] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        timeouts[request.url.path] = request.extensions["timeout"]["read"]
        return httpx.Response(201, json={}, headers={"X-Request-ID": REQUEST_ID})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        client.request("POST", "/api/sandbox/publications", json_body={})
        client.request("POST", "/api/records", json_body={})

    assert timeouts["/api/records"] == 20.0
    assert timeouts["/api/sandbox/publications"] >= 120.0


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
    "detail,code",
    [
        ({"code": "files_busy", "message": "File capacity is busy"}, "files_busy"),
        ({"code": "file_integrity_error", "message": "unavailable"}, "file_integrity_error"),
        ({"code": "Private Value 42", "message": "unavailable"}, "other"),
        ({"code": "x" * 65, "message": "unavailable"}, "other"),
        ({"message": "unavailable"}, "other"),
    ],
)
def test_server_error_journal_names_the_api_error_code_only_when_it_is_a_bounded_slug(
    tmp_path: Path, detail: dict[str, str], code: str
) -> None:
    # A 503 card download recorded only "other", so the run could not tell a refused
    # transfer slot from missing bytes (F6). Messages are never journaled.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        return httpx.Response(503, json={"detail": detail})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        assert client.request("GET", f"/api/files/{REQUEST_ID}/content").status_code == 503

    contents = (tmp_path / "private" / "requests.jsonl").read_text()
    assert json.loads(contents.splitlines()[-1])["failure_code"] == code
    assert "unavailable" not in contents and "capacity" not in contents


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


FILES_BUSY = {"code": "files_busy", "message": "File capacity is busy"}


@pytest.mark.parametrize("method", ["GET", "PUT"])
@pytest.mark.parametrize(
    ("busy", "detail", "statuses", "sleeps"),
    [
        (2, FILES_BUSY, [503, 503, 200], [1.0, 1.0]),
        (99, FILES_BUSY, [503] * 61, [1.0] * 60),
        (1, {"code": "file_integrity_error", "message": "unavailable"}, [503], []),
    ],
    ids=["retried-until-free", "bounded-total-wait", "other-503-not-retried"],
)
def test_a_refused_file_transfer_is_retried_after_retry_after_within_a_bounded_wait(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method, busy, detail, statuses, sleeps
) -> None:
    # The API refuses files_busy before any work, so any method can be resent (C3).
    seen: list[int] = []
    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", slept.append)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        status = 503 if len(seen) < busy else 200
        seen.append(status)
        if status == 503:
            return httpx.Response(503, json={"detail": detail}, headers={"Retry-After": "1"})
        return httpx.Response(200, json={"id": "file"})

    path = f"/api/files/{REQUEST_ID}/content"
    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        if method == "PUT" and statuses[-1] == 503:
            with pytest.raises(SampleWriteOutcomeUnknown) as unknown:
                client.request(method, path, content=b"bytes")
            assert unknown.value.failure_code == detail["code"]
        else:
            response = client.request(method, path, content=b"bytes" if method == "PUT" else None)
            assert response.status_code == statuses[-1]

    assert seen == statuses
    assert slept == sleeps


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
        with pytest.raises(
            ValueError, match="Sample journal mappings accept identifier values only"
        ):
            client.record_mapping(
                "person", "jane@example.test", "019c6e27-e55b-73d1-87d8-4e01f1f75044"
            )
        with pytest.raises(ValueError, match="Sample journal server mappings require a UUID"):
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


def test_an_organization_bound_client_sends_its_organization_on_every_request(
    tmp_path: Path,
) -> None:
    organization = "0190a000-0000-7000-8000-0000000000aa"
    seen: list[tuple[str, str | None, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.headers.get("x-org"), request.url.params.get("org")))
        if request.url.path == "/api/auth/login":
            return _login_response()
        if request.url.path == "/api/events":
            return httpx.Response(
                200,
                stream=httpx.ByteStream(b"event: resync\ndata: {}\n\n"),
                headers={"Content-Type": "text/event-stream"},
            )
        return httpx.Response(200, json={})

    transport = httpx.MockTransport(handler)
    with SampleClient(
        BASE_URL, ORIGIN, tmp_path / "requests.jsonl", organization, transport=transport
    ) as client:
        client.login(EMAIL, PASSWORD)
        client.request("GET", "/api/records")
        client.request("POST", "/api/records", json_body={"name": "record"})
        client.check_event_stream()
        with pytest.raises(SampleAuthenticationError):
            client.request(
                "GET", "/api/records", headers={"X-Org": "0190a000-0000-7000-8000-0000000000bb"}
            )
    with _client(tmp_path, transport) as unbound:
        unbound.request("GET", "/api/records")

    assert seen == [
        ("/api/auth/login", organization, None),
        ("/api/records", organization, None),
        ("/api/records", organization, None),
        ("/api/events", organization, organization),
        ("/api/records", None, None),
    ]


def test_journal_tags_each_request_with_a_hashed_account_and_never_the_email(
    tmp_path: Path,
) -> None:
    # Live seven-pack run: five packs' refreshes failed at once, and the journal could
    # not say whether they were one shared account.
    import hashlib

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _login_response()
        return httpx.Response(200, json={"ok": True})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        client.request("GET", "/api/auth/me")
    journal = (tmp_path / "private" / "requests.jsonl").read_text()
    started = [json.loads(line) for line in journal.splitlines() if "request_started" in line]
    tag = hashlib.sha256(EMAIL.strip().lower().encode()).hexdigest()[:12]
    assert [row.get("account") for row in started] == [tag, tag]
    assert EMAIL not in journal


def test_idle_connections_expire_before_the_api_closes_them(monkeypatch, tmp_path) -> None:
    # Four-pack run on 2026-10-29: a GET went out on a keep-alive connection the API had
    # closed at its 5 s SERVER_KEEP_ALIVE_SECONDS and failed with no response.
    import httpx as real_httpx

    import operations.sample.client as sample_client

    seen: dict[str, object] = {}
    original = real_httpx.Client

    def recording(*args, **kwargs):
        seen.update(kwargs)
        return original(*args, **kwargs)

    monkeypatch.setattr(sample_client.httpx, "Client", recording)
    with sample_client.SampleClient(
        "https://api.example.test", "https://workspace.example.test", tmp_path / "j.jsonl"
    ):
        pass
    limits = seen["limits"]
    assert isinstance(limits, real_httpx.Limits)
    assert limits.keepalive_expiry is not None and limits.keepalive_expiry < 5


@pytest.mark.parametrize("idle_minutes", [20, 1])
def test_a_session_that_expired_while_idle_signs_in_again_once(
    tmp_path: Path, idle_minutes: int
) -> None:
    # Large Harbor and School on 2026-10-30: the operator's client sat idle for 79 minutes,
    # past the 60-minute session timeout, and its next step stopped on a refused refresh
    # (refresh_session_expired). A person returning after an idle expiry signs in again;
    # a refusal after recent use (a revoked session) still stops the step.
    import base64
    import time

    def token(expires_in: float) -> str:
        claims = json.dumps({"exp": time.time() + expires_in}).encode()
        return "h." + base64.urlsafe_b64encode(claims).rstrip(b"=").decode() + ".s"

    seen: list[str] = []
    logins = iter([token(5), token(3600)])

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True, "setup_required": False},
                headers=[
                    ("set-cookie", f"openslate_access={next(logins)}; Path=/; HttpOnly"),
                    ("set-cookie", f"openslate_refresh={REFRESH}; Path=/api/auth; HttpOnly"),
                    ("set-cookie", f"openslate_csrf={CSRF}; Path=/"),
                    ("X-Request-ID", REQUEST_ID),
                ],
            )
        if request.url.path == "/api/auth/refresh":
            return httpx.Response(
                401, json={"detail": "Expired"}, headers=[("X-Request-ID", REQUEST_ID)]
            )
        return httpx.Response(200, json={"id": "record"}, headers=[("X-Request-ID", REQUEST_ID)])

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        assert client.login(EMAIL, PASSWORD).status_code == 200
        client._last_sent_at = time.monotonic() - idle_minutes * 60
        if idle_minutes >= 15:
            assert (
                client.request("POST", "/api/records", json_body={"name": "x"}).status_code == 200
            )
            assert seen == [
                "/api/auth/login",
                "/api/auth/refresh",
                "/api/auth/login",
                "/api/records",
            ]
        else:
            with pytest.raises(SampleAuthenticationError):
                client.request("POST", "/api/records", json_body={"name": "x"})
            assert seen == ["/api/auth/login", "/api/auth/refresh"]
