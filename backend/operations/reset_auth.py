"""Bounded administrative Auth calls for the guarded local reset command."""

from __future__ import annotations

import json
import math
from contextlib import nullcontext
from uuid import UUID

import httpx

from operations.reset_models import ResetError

_MAX_RESPONSE_BYTES = 65536
_MAX_ACCOUNT_PAGES = 100
_ACCOUNT_PAGE_SIZE = 50


class ResetAuth:
    """Hard-delete only the provider IDs pinned in the confirmed reset plan."""

    def __init__(
        self,
        url: str,
        secret_key: str,
        timeout_seconds: float,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        try:
            parsed = httpx.URL(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.host
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
                or parsed.username
                or parsed.password
                or not secret_key
                or not math.isfinite(timeout_seconds)
                or timeout_seconds <= 0
            ):
                raise ValueError
        except (TypeError, ValueError):
            raise ResetError("The provider Auth reset configuration is invalid") from None
        self._origin = str(parsed).rstrip("/")
        self._secret_key = secret_key
        self._timeout = timeout_seconds
        self._client = client
        self._preserved_id: UUID | None = None

    def _request(
        self, method: str, user_id: UUID | None, *, params: dict[str, str] | None = None
    ) -> tuple[int, bytes]:
        context = (
            nullcontext(self._client)
            if self._client is not None
            else httpx.Client(follow_redirects=False, trust_env=False)
        )
        try:
            with context as client:
                assert client is not None
                with client.stream(
                    method,
                    f"{self._origin}/auth/v1/admin/users"
                    + (f"/{user_id}" if user_id is not None else ""),
                    headers={"apikey": self._secret_key},
                    params=params,
                    timeout=self._timeout,
                    follow_redirects=False,
                ) as response:
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > _MAX_RESPONSE_BYTES:
                            raise ResetError("The provider Auth response is too large")
                    return response.status_code, bytes(content)
        except httpx.RequestError:
            raise ResetError("The provider Auth API is unavailable") from None

    def list_account_ids(
        self,
        preserved_provider_id: UUID,
        preserved_email: str,
        *,
        page_size: int = _ACCOUNT_PAGE_SIZE,
    ) -> tuple[UUID, ...]:
        """List every non-admin Auth account through bounded provider pages."""
        if not 1 <= page_size <= _ACCOUNT_PAGE_SIZE:
            raise ResetError("The provider Auth inventory page size is invalid")
        expected_email = preserved_email.strip().casefold()
        if not expected_email:
            raise ResetError("The preserved administrator email is invalid")
        seen: set[UUID] = set()
        accounts: list[UUID] = []
        admin_seen = False
        for page in range(1, _MAX_ACCOUNT_PAGES + 1):
            status, body = self._request(
                "GET", None, params={"page": str(page), "per_page": str(page_size)}
            )
            if status != 200:
                raise ResetError("The provider Auth inventory is unavailable")
            try:
                payload = json.loads(body)
                users = payload["users"]
                if not isinstance(users, list) or len(users) > page_size:
                    raise ValueError
                for user in users:
                    if not isinstance(user, dict):
                        raise ValueError
                    user_id = UUID(user["id"])
                    email = user["email"]
                    if not isinstance(email, str) or not email.strip() or user_id in seen:
                        raise ValueError
                    seen.add(user_id)
                    if user_id == preserved_provider_id:
                        if email.strip().casefold() != expected_email:
                            raise ResetError("The preserved administrator identity changed")
                        admin_seen = True
                    elif email.strip().casefold() == expected_email:
                        raise ResetError("The preserved administrator identity is ambiguous")
                    else:
                        accounts.append(user_id)
            except (ValueError, TypeError, KeyError):
                raise ResetError("The provider Auth inventory is invalid") from None
            if len(users) < page_size:
                if not admin_seen:
                    raise ResetError("The preserved administrator is missing from Auth")
                return tuple(sorted(accounts, key=str))
        raise ResetError("The provider Auth inventory is incomplete")

    def _read(self, user_id: UUID) -> bool:
        status, body = self._request("GET", user_id)
        if status == 404:
            return False
        if status != 200:
            raise ResetError("The provider account could not be verified")
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or UUID(data["id"]) != user_id:
                raise ValueError
        except (ValueError, TypeError, KeyError):
            raise ResetError("The provider account identity did not match") from None
        return True

    def require_present(self, user_id: UUID) -> None:
        if not self._read(user_id):
            raise ResetError("The administrator provider identity is missing")
        self._preserved_id = user_id

    def delete_and_verify_missing(self, user_ids: tuple[UUID, ...]) -> None:
        if self._preserved_id is None:
            raise ResetError("The preserved administrator was not verified")
        if len(set(user_ids)) != len(user_ids):
            raise ResetError("The provider account deletion plan is ambiguous")
        if self._preserved_id in user_ids:
            raise ResetError("The preserved administrator cannot be deleted")
        for user_id in user_ids:
            if not self._read(user_id):
                continue
            status, _ = self._request("DELETE", user_id)
            if status not in {200, 204, 404} or self._read(user_id):
                raise ResetError("The provider account deletion was not confirmed")
