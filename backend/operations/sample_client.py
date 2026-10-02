"""Authenticated API transport used by sample-data operator commands."""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx

from operations.sample_client_events import check_event_stream
from operations.sample_journal import append_event
from operations.sample_route_coverage import route_template

_SAFE_METHODS = frozenset({"GET"})
_ALLOWED_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})
_UNSAFE_METHODS = _ALLOWED_METHODS - _SAFE_METHODS
_SESSION_HEADERS = frozenset({"authorization", "cookie", "origin", "x-csrf-token"})
_LOGIN_PATH = "/api/auth/login"
_REFRESH_PATH = "/api/auth/refresh"
_INVITATION_PATH = "/api/auth/invitations/complete"
_RECOVERY_PATH = "/api/auth/recovery/complete"
_MAX_GET_RATE_LIMIT_RETRIES = 1
_MAX_RETRY_AFTER_SECONDS = 2.0
_ROLLED_BACK_RECORD_RETRY_DELAYS = (0.1, 0.3)
_ROLLED_BACK_DETAIL = "Relationship operation is temporarily unavailable"
_SAFE_MAPPING_VALUE = re.compile(r"[A-Za-z0-9_:-]{1,160}\Z")
# The API rotates an access token only when it has 30 seconds or less left, so
# an earlier refresh returns the same token and cannot extend the session.
_REFRESH_WITHIN_SECONDS = 20.0


class SampleClientError(RuntimeError):
    """A safe operator-facing sample API client failure."""

    def __init__(
        self,
        message: str,
        *,
        attempt_id: str | None = None,
        request_id: str | None = None,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.attempt_id = attempt_id
        self.request_id = request_id
        self.status_code = status_code


class SampleAuthenticationError(SampleClientError):
    """Authentication failed and the client did not replay the request."""


class SampleRateLimitedError(SampleClientError):
    """A request was rate-limited and was not replayed beyond the GET bound."""

    def __init__(self, method: str, *, attempt_id: str, request_id: str | None = None) -> None:
        super().__init__(
            f"{method} was rate-limited (HTTP 429); no write was replayed",
            attempt_id=attempt_id,
            request_id=request_id,
            status_code=429,
        )


class SampleWriteOutcomeUnknown(SampleClientError):
    """A write may have reached the API, so it must not be replayed blindly."""

    def __init__(
        self,
        method: str,
        *,
        attempt_id: str,
        request_id: str | None = None,
        status_code: int | None = None,
        failure_code: str | None = None,
    ) -> None:
        self.failure_code = failure_code
        request_text = f", request {request_id}" if request_id is not None else ""
        status_text = f", HTTP {status_code}" if status_code is not None else ""
        super().__init__(
            f"{method} outcome is unknown for attempt {attempt_id}{request_text}{status_text}; "
            "do not replay it before reconciling the server state",
            attempt_id=attempt_id,
            request_id=request_id,
            status_code=status_code,
        )


def _origin(value: str) -> str:
    parts = urlsplit(value)
    if (
        parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise ValueError("Sample API and browser origin must be HTTP origins")
    return f"{parts.scheme}://{parts.netloc}"


def _request_id(response: httpx.Response) -> str | None:
    value = response.headers.get("X-Request-ID")
    if value is None:
        return None
    try:
        return str(UUID(value))
    except ValueError:
        return None


def _simple_error_detail(response: httpx.Response) -> str | None:
    if (
        response.headers.get("content-type", "").partition(";")[0].strip().lower()
        != "application/json"
        or len(response.content) > 512
    ):
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    if isinstance(payload, dict) and set(payload) == {"detail"}:
        detail = payload["detail"]
        return detail if isinstance(detail, str) else None
    return None


def _failure_code(response: httpx.Response, method: str, path: str) -> str | None:
    if response.status_code < 500:
        return None
    detail = _simple_error_detail(response)
    if response.status_code == 503:
        # Record writes reach this detail only from lock_row, which rolls back
        # before create/update can flush or commit. Relationship mutations can
        # emit the same detail after commit, so they are deliberately excluded.
        record_patch = method == "PATCH" and path.startswith("/api/records/")
        if record_patch:
            try:
                UUID(path.removeprefix("/api/records/"))
            except ValueError:
                record_patch = False
        if detail == _ROLLED_BACK_DETAIL and (
            (method == "POST" and path == "/api/records") or record_patch
        ):
            return "rollback_busy"
        if detail == _ROLLED_BACK_DETAIL and path.startswith("/api/relationships"):
            return "relationship_busy"  # May follow a commit; the caller must reconcile.
        known = {
            "Database unavailable": "database_unavailable",
            "Authentication service unavailable": "authentication_unavailable",
            "Authorization unavailable": "authorization_unavailable",
        }
        if detail in known:
            return known[detail]
    return "other"


class SampleClient:
    """A per-actor browser-cookie client for authenticated OpenSlate API calls."""

    def __init__(
        self,
        base_url: str,
        origin: str,
        journal_path: Path,
        *,
        timeout: float = 20.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        api_origin = _origin(base_url)
        self._origin = _origin(origin)
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Sample API timeout must be a positive finite number")
        self._journal_path = Path(journal_path)
        self._last_auth_at: float | None = None
        self._client = httpx.Client(
            base_url=f"{api_origin}/",
            headers={"Accept": "application/json", "Origin": self._origin},
            timeout=timeout,
            follow_redirects=False,
            transport=transport,
        )

    def login(self, email: str, password: str) -> httpx.Response:
        self._last_auth_at = None
        self._client.cookies.clear()
        response = self._request(
            "POST",
            _LOGIN_PATH,
            json_body={"email": email, "password": password},
            allow_unauthorized=True,
        )
        if response.is_success:
            self._last_auth_at = time.monotonic()
        return response

    def refresh(self) -> httpx.Response:
        response = self._request("POST", _REFRESH_PATH, allow_unauthorized=True)
        self._last_auth_at = time.monotonic() if response.is_success else None
        return response

    def complete_invitation(self, token_hash: str, password: str) -> httpx.Response:
        return self._request(
            "POST",
            _INVITATION_PATH,
            json_body={"token_hash": token_hash, "password": password},
            allow_unauthorized=True,
        )

    def complete_recovery(self, token_hash: str, password: str) -> httpx.Response:
        return self._request(
            "POST",
            _RECOVERY_PATH,
            json_body={"token_hash": token_hash, "password": password},
            allow_unauthorized=True,
        )

    def check_event_stream(self) -> dict[str, object]:
        return check_event_stream(self._client, self._origin, self._append_event)

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        data: Mapping[str, str] | None = None,
        files: Mapping[str, Any] | None = None,
        content: bytes | None = None,
    ) -> httpx.Response:
        expires_at = self._access_expires_at() if self._last_auth_at is not None else None
        if expires_at is not None and expires_at - time.time() <= _REFRESH_WITHIN_SECONDS:
            refreshed = self.refresh()
            if not refreshed.is_success:
                raise SampleAuthenticationError(
                    "Session refresh was refused; the requested operation was not sent",
                    status_code=refreshed.status_code,
                )
            renewed_at = self._access_expires_at()
            if renewed_at is None or renewed_at <= expires_at:
                raise SampleAuthenticationError(
                    "Session refresh did not extend the session; the operation was not sent",
                    status_code=refreshed.status_code,
                )
        return self._request(
            method,
            path,
            json_body=json_body,
            params=params,
            headers=headers,
            data=data,
            files=files,
            content=content,
            allow_unauthorized=False,
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        data: Mapping[str, str] | None = None,
        files: Mapping[str, Any] | None = None,
        content: bytes | None = None,
        allow_unauthorized: bool,
    ) -> httpx.Response:
        normalized_method = method.upper()
        self._validate_path(path)
        if normalized_method not in _ALLOWED_METHODS:
            raise ValueError("Unsupported sample API method")
        if content is not None and any(value is not None for value in (json_body, data, files)):
            raise ValueError("Raw file content cannot be combined with JSON or multipart fields")
        is_write = normalized_method in _UNSAFE_METHODS
        request_headers = httpx.Headers(headers or {})
        if any(name.lower() in _SESSION_HEADERS for name in request_headers.keys()):
            raise SampleAuthenticationError(
                "Cookie-session authentication and origin headers are managed by the client"
            )
        request_headers["Origin"] = self._origin
        if path in {_INVITATION_PATH, _RECOVERY_PATH} and self._client.cookies:
            raise SampleAuthenticationError("Action completion requires a cookie-free client")
        if is_write and path not in {_LOGIN_PATH, _INVITATION_PATH, _RECOVERY_PATH}:
            csrf = self._csrf_cookie()
            if not csrf:
                raise SampleAuthenticationError(
                    "Authenticated write refused because CSRF is missing"
                )
            request_headers["X-CSRF-Token"] = csrf

        retries = 0
        rollback_retries = 0
        while True:
            attempt_id = str(uuid4())
            self._append_event(
                {
                    "event": "request_started",
                    "attempt_id": attempt_id,
                    "method": normalized_method,
                    "route_template": route_template(normalized_method, path),
                }
            )
            try:
                response = self._client.request(
                    normalized_method,
                    path,
                    params=params,
                    headers=request_headers,
                    json=json_body,
                    data=data,
                    files=files,
                    content=content,
                )
            except httpx.HTTPError:
                self._finish_without_response(attempt_id, normalized_method, is_write)
                if is_write:
                    raise SampleWriteOutcomeUnknown(
                        normalized_method, attempt_id=attempt_id
                    ) from None
                raise SampleClientError(
                    f"{normalized_method} request failed; no automatic retry was attempted",
                    attempt_id=attempt_id,
                ) from None

            request_id = _request_id(response)
            failure_code = _failure_code(response, normalized_method, path)
            try:
                self._append_event(
                    {
                        "event": "request_finished",
                        "attempt_id": attempt_id,
                        "request_id": request_id,
                        "status_code": response.status_code,
                        **({"failure_code": failure_code} if failure_code is not None else {}),
                    }
                )
            except SampleClientError:
                if is_write:
                    raise SampleWriteOutcomeUnknown(
                        normalized_method,
                        attempt_id=attempt_id,
                        request_id=request_id,
                        status_code=response.status_code,
                    ) from None
                raise

            if response.status_code == 401 and not allow_unauthorized:
                raise SampleAuthenticationError(
                    f"{normalized_method} returned HTTP 401; it was not replayed. "
                    "Refresh separately and reconcile any prior write before resubmitting",
                    attempt_id=attempt_id,
                    request_id=request_id,
                    status_code=401,
                )
            if response.status_code == 429:
                delay = self._get_retry_delay(response) if normalized_method == "GET" else None
                if delay is not None and retries < _MAX_GET_RATE_LIMIT_RETRIES:
                    retries += 1
                    time.sleep(delay)
                    continue
                raise SampleRateLimitedError(
                    normalized_method, attempt_id=attempt_id, request_id=request_id
                )
            if is_write and response.status_code >= 500:
                if failure_code == "rollback_busy" and rollback_retries < len(
                    _ROLLED_BACK_RECORD_RETRY_DELAYS
                ):
                    time.sleep(_ROLLED_BACK_RECORD_RETRY_DELAYS[rollback_retries])
                    rollback_retries += 1
                    continue
                raise SampleWriteOutcomeUnknown(
                    normalized_method,
                    attempt_id=attempt_id,
                    request_id=request_id,
                    status_code=response.status_code,
                    failure_code=failure_code,
                )
            return response

    @staticmethod
    def _validate_path(path: str) -> None:
        parts = urlsplit(path)
        if (
            not path.startswith("/api/")
            or parts.scheme
            or parts.netloc
            or parts.query
            or parts.fragment
            or "\r" in path
            or "\n" in path
        ):
            raise ValueError("Sample API paths must be absolute /api paths without a query string")

    def _access_expires_at(self) -> float | None:
        """Read the access token expiry only to schedule a refresh; the API verifies it."""
        try:
            token = self._client.cookies.get("openslate_access")
        except httpx.CookieConflict:
            return None
        parts = token.split(".") if token else []
        if len(parts) != 3:
            return None
        try:
            payload = parts[1] + "=" * (-len(parts[1]) % 4)
            expiry = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
            value = float(expiry) if isinstance(expiry, int | float) else None
        except (binascii.Error, UnicodeDecodeError, ValueError, AttributeError, OverflowError,
                RecursionError):  # fmt: skip
            return None
        return value if value is not None and math.isfinite(value) else None

    def _csrf_cookie(self) -> str | None:
        try:
            return self._client.cookies.get("openslate_csrf")
        except httpx.CookieConflict:
            raise SampleAuthenticationError(
                "Authenticated write refused because CSRF is ambiguous"
            ) from None

    @staticmethod
    def _get_retry_delay(response: httpx.Response) -> float | None:
        value = response.headers.get("Retry-After")
        try:
            delay = float(value) if value is not None else math.nan
        except ValueError:
            return None
        if not math.isfinite(delay) or delay < 0 or delay > _MAX_RETRY_AFTER_SECONDS:
            return None
        return delay

    def _finish_without_response(self, attempt_id: str, method: str, is_write: bool) -> None:
        try:
            self._append_event(
                {
                    "event": "request_finished",
                    "attempt_id": attempt_id,
                    "outcome": "outcome_unknown" if is_write else "transport_error",
                }
            )
        except SampleClientError:
            if is_write:
                raise SampleWriteOutcomeUnknown(method, attempt_id=attempt_id) from None
            raise

    def _append_event(self, values: Mapping[str, object]) -> None:
        try:
            append_event(self._journal_path, values)
        except OSError:
            raise SampleClientError("Unable to append to the private sample journal") from None

    def record_mapping(self, kind: str, logical_id: str, server_id: str) -> None:
        if not all(_SAFE_MAPPING_VALUE.fullmatch(value) for value in (kind, logical_id, server_id)):
            raise ValueError("Sample journal mappings accept identifier values only")
        try:
            server_id = str(UUID(server_id))
        except ValueError:
            raise ValueError("Sample journal server mappings require a UUID") from None
        self._append_event(
            {
                "event": "id_mapping",
                "kind": kind,
                "logical_id": logical_id,
                "server_id": server_id,
            }
        )

    def close(self) -> None:
        self._client.cookies.clear()
        self._client.close()

    def __enter__(self) -> SampleClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
