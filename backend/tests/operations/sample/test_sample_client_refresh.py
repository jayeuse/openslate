"""Session refresh timing for the authenticated sample-data API client."""

import base64
import json
import time
from pathlib import Path

import httpx
import pytest

from operations.sample.client import SampleAuthenticationError, SampleClient

ORIGIN = "https://workspace.example.test"
BASE_URL = "https://api.example.test"
EMAIL = "sample-admin@example.test"
PASSWORD = "synthetic-test-password"
REFRESH = "synthetic-refresh-cookie"
CSRF = "synthetic-csrf-cookie"


def _client(tmp_path: Path, handler: httpx.MockTransport) -> SampleClient:
    return SampleClient(
        BASE_URL, ORIGIN, tmp_path / "private" / "requests.jsonl", transport=handler
    )


def _jwt(expires_at: int) -> str:
    """An unsigned access-token shape; the client reads only its expiry."""

    def part(value: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part({'exp': expires_at})}.signature"


def _session_response(access: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={"authenticated": True, "setup_required": False},
        headers=[
            ("set-cookie", f"openslate_access={access}; Path=/; HttpOnly"),
            ("set-cookie", f"openslate_refresh={REFRESH}; Path=/api/auth; HttpOnly"),
            ("set-cookie", f"openslate_csrf={CSRF}; Path=/"),
        ],
    )


def test_long_runs_refresh_only_when_the_access_token_nears_expiry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The API returns the same access token until it has 30 seconds left, so an
    # earlier refresh cannot extend the session.
    clock = [1_000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _session_response(_jwt(1_900))
        if request.url.path == "/api/auth/refresh":
            return _session_response(_jwt(2_800))
        return httpx.Response(201, json={"id": "record"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        clock[0] = 1_600.0
        assert client.request("POST", "/api/records", json_body={}).status_code == 201
        clock[0] = 1_885.0
        assert client.request("POST", "/api/records", json_body={}).status_code == 201
        clock[0] = 2_500.0
        assert client.request("POST", "/api/records", json_body={}).status_code == 201
    assert seen == [
        "/api/auth/login",
        "/api/records",
        "/api/auth/refresh",
        "/api/records",
        "/api/records",
    ]


@pytest.mark.parametrize("refresh", ["rejected", "not_extended"])
def test_a_refresh_that_does_not_extend_the_session_stops_before_the_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, refresh: str
) -> None:
    clock = [1_000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _session_response(_jwt(1_900))
        if request.url.path == "/api/auth/refresh":
            if refresh == "rejected":
                return httpx.Response(401, json={"authenticated": False})
            return _session_response(_jwt(1_900))
        return httpx.Response(201, json={"id": "record"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        clock[0] = 1_885.0
        with pytest.raises(SampleAuthenticationError):
            client.request("POST", "/api/records", json_body={})
    assert seen == ["/api/auth/login", "/api/auth/refresh"]


def test_an_unreadable_token_expiry_never_crashes_a_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(time, "time", lambda: 1_000.0)
    huge = base64.urlsafe_b64encode(json.dumps({"exp": 10**400}).encode()).decode().rstrip("=")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return _session_response(f"e30.{huge}.signature")
        return httpx.Response(201, json={"id": "record"})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        assert client.request("POST", "/api/records", json_body={}).status_code == 201


def test_a_sign_out_probe_reads_a_revoked_session_without_refreshing_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Smoke runs use 60-second access tokens: after a bulk sign-out, the probe ran inside
    # the refresh window, and the refused refresh stopped the run before the probe.
    clock = [1_000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return _session_response(_jwt(1_060))
        if request.url.path == "/api/auth/refresh":
            return httpx.Response(401, json={"detail": "Invalid authentication credentials"})
        return httpx.Response(200, json={"authenticated": False})

    with _client(tmp_path, httpx.MockTransport(handler)) as client:
        client.login(EMAIL, PASSWORD)
        clock[0] = 1_050.0
        response = client.request("GET", "/api/auth/session", refresh_first=False)
        assert response.json() == {"authenticated": False}
    assert seen == ["/api/auth/login", "/api/auth/session"]
