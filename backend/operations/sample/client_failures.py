"""Bounded, non-private failure classification for the sample HTTP transport."""

import re
from uuid import UUID

import httpx

_ROLLED_BACK_DETAIL = "Relationship operation is temporarily unavailable"
_API_ERROR_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")


def _error_detail(response: httpx.Response) -> object:
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
        return payload["detail"]
    return None


def _api_error_code(detail: object) -> str | None:
    """The API's own error code slug; its message is never recorded."""
    code = detail.get("code") if isinstance(detail, dict) else None
    return code if isinstance(code, str) and _API_ERROR_CODE.fullmatch(code) else None


def failure_code(response: httpx.Response, method: str, path: str) -> str | None:
    if response.status_code < 500:
        return None
    payload = _error_detail(response)
    detail = payload if isinstance(payload, str) else None
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
    return _api_error_code(payload) or "other"
