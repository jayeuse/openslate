from dataclasses import dataclass
from urllib.parse import quote
from uuid import UUID

import httpx

from app.core.config import Settings, get_settings


class SupabaseAdminError(RuntimeError):
    """A safe, non-sensitive error from the Supabase Admin API."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class SupabaseAuthUser:
    id: UUID
    email: str


@dataclass(frozen=True)
class InvalidationEvent:
    """Opaque data used to invalidate a client cache; never a row snapshot."""

    entity: str
    entity_id: UUID | None = None


class SupabaseAdminClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        if not self.settings.supabase_url or not self.settings.supabase_secret_key:
            raise SupabaseAdminError("Supabase integration is not configured")
        self._base_url = self.settings.supabase_url.rstrip("/")
        secret = self.settings.supabase_secret_key.get_secret_value()
        self._headers = {
            "apikey": secret,
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, object] | None = None,
        *,
        params: dict[str, str] | None = None,
    ) -> object:
        try:
            with httpx.Client(
                base_url=self._base_url,
                headers=self._headers,
                timeout=10.0,
            ) as client:
                response = client.request(method, path, json=payload, params=params)
                response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise SupabaseAdminError(
                "Supabase Auth request failed",
                status_code=error.response.status_code,
            ) from error
        except httpx.HTTPError as error:
            raise SupabaseAdminError("Supabase Auth request failed") from error
        try:
            return response.json()
        except ValueError:
            return {}

    def invite_user(self, email: str, username: str) -> SupabaseAuthUser:
        if not self.settings.supabase_auth_redirect_url:
            raise SupabaseAdminError("Supabase Auth redirect is not configured")
        result = self._request(
            "POST",
            "/auth/v1/invite",
            {"email": email, "data": {"username": username}},
            params={"redirect_to": self.settings.supabase_auth_redirect_url},
        )
        data = result.get("user", result) if isinstance(result, dict) else {}
        if not isinstance(data, dict):
            raise SupabaseAdminError("Supabase Auth returned an invalid user")
        try:
            user_id = UUID(str(data["id"]))
            returned_email = str(data.get("email") or email)
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseAdminError("Supabase Auth returned an invalid user") from error
        return SupabaseAuthUser(id=user_id, email=returned_email)

    def delete_user(self, user_id: UUID) -> None:
        self._request("DELETE", f"/auth/v1/admin/users/{user_id}")

    def disable_user(self, user_id: UUID) -> None:
        self._request(
            "PUT",
            f"/auth/v1/admin/users/{user_id}",
            {"ban_duration": "876000h"},
        )

    def enable_user(self, user_id: UUID) -> None:
        self._request(
            "PUT",
            f"/auth/v1/admin/users/{user_id}",
            {"ban_duration": "none"},
        )

    def broadcast(self, event: InvalidationEvent) -> None:
        if not self.settings.supabase_url or not self.settings.supabase_secret_key:
            raise SupabaseAdminError("Supabase integration is not configured")
        payload: dict[str, object] = {"type": event.entity}
        if event.entity_id is not None:
            payload["entity_id"] = str(event.entity_id)
        try:
            with httpx.Client(
                base_url=self.settings.supabase_url.rstrip("/"),
                headers=self._headers,
                timeout=10.0,
            ) as client:
                topic = quote("openslate:invalidation", safe="")
                event_name = quote("invalidate", safe="")
                client.post(
                    f"/realtime/v1/api/broadcast/{topic}/events/{event_name}",
                    params={"private": "true"},
                    json=payload,
                ).raise_for_status()
        except httpx.HTTPError as error:
            raise SupabaseAdminError("Supabase Realtime request failed") from error


def broadcast_invalidation(event: InvalidationEvent) -> None:
    """Publish only an opaque post-commit invalidation event."""

    SupabaseAdminClient().broadcast(event)
