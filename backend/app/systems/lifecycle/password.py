"""Password-grant verification used only for lifecycle step-up checks."""

from collections.abc import Callable
from typing import Any, Protocol, cast
from uuid import UUID

import httpx

from app.core.config import Settings, get_settings
from app.systems.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)


class PasswordGrantClient(Protocol):
    def verify_password(self, email: str, password: str) -> UUID:
        """Verify credentials and return the identity from the temporary session."""


class SupabasePasswordGrantClient:
    """A non-retrying, short-lived Supabase password-grant client.

    The access token is kept only in local scope long enough to revoke the
    temporary session.  It is never returned, persisted, or included in an
    exception message.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        http_client: Any | None = None,
        client_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        key = self.settings.supabase_publishable_key
        if not self.settings.supabase_url or key is None:
            raise LifecyclePasswordServiceUnavailable(
                "Supabase password verification is not configured"
            )
        self._base_url = self.settings.supabase_url.rstrip("/")
        self._api_key = key.get_secret_value()
        self._http_client = http_client
        self._client_factory = client_factory or httpx.Client

    def _headers(self, access_token: str | None = None) -> dict[str, str]:
        headers = {
            "apikey": self._api_key,
            "Content-Type": "application/json",
        }
        if access_token is not None:
            headers["Authorization"] = f"Bearer {access_token}"
        return headers

    def _post(
        self,
        path: str,
        *,
        payload: dict[str, str] | None,
        headers: dict[str, str],
    ) -> httpx.Response:
        try:
            if self._http_client is not None:
                return cast(
                    httpx.Response,
                    self._http_client.post(path, json=payload, headers=headers),
                )
            with self._client_factory(
                base_url=self._base_url,
                timeout=10.0,
            ) as client:
                return cast(
                    httpx.Response,
                    client.post(path, json=payload, headers=headers),
                )
        except httpx.HTTPError:
            raise LifecyclePasswordServiceUnavailable(
                "Supabase password verification is unavailable"
            ) from None

    @staticmethod
    def _raise_for_status(status_code: int) -> None:
        if status_code in {400, 401, 403}:
            raise LifecycleInvalidCredentials("The supplied password is invalid")
        if status_code == 429:
            raise LifecyclePasswordRateLimited(
                "Supabase password verification is rate limited"
            )
        if status_code < 200 or status_code >= 300:
            raise LifecyclePasswordServiceUnavailable(
                "Supabase password verification is unavailable"
            )

    def verify_password(self, email: str, password: str) -> UUID:
        response = self._post(
            "/auth/v1/token?grant_type=password",
            payload={"email": email, "password": password},
            headers=self._headers(),
        )
        self._raise_for_status(response.status_code)

        access_token: str | None = None
        result: UUID | None = None
        verification_error: Exception | None = None
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError
            raw_token = payload.get("access_token")
            user = payload.get("user")
            raw_user_id = user.get("id") if isinstance(user, dict) else None
            if not isinstance(raw_token, str) or not raw_token:
                raise ValueError
            access_token = raw_token
            result = UUID(str(raw_user_id))
        except (TypeError, ValueError, KeyError):
            verification_error = LifecyclePasswordServiceUnavailable(
                "Supabase password verification returned an invalid response"
            )

        if access_token is not None:
            try:
                revoke_response = self._post(
                    "/auth/v1/logout",
                    payload=None,
                    headers=self._headers(access_token),
                )
                self._raise_for_status(revoke_response.status_code)
            except (LifecycleInvalidCredentials, LifecyclePasswordRateLimited):
                verification_error = LifecyclePasswordServiceUnavailable(
                    "Supabase temporary session could not be revoked"
                )
            except LifecyclePasswordServiceUnavailable as error:
                verification_error = error

        if verification_error is not None:
            raise verification_error
        if result is None:  # pragma: no cover - defensive for strict type checking
            raise LifecyclePasswordServiceUnavailable(
                "Supabase password verification returned an invalid response"
            )
        return result


__all__ = ["PasswordGrantClient", "SupabasePasswordGrantClient"]
