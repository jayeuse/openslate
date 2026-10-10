"""Secure email-change protocol for the pinned GoTrue provider only."""

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
    _json_response,
    _provider_tokens,
    _provider_user,
)


@dataclass(frozen=True, slots=True)
class EmailChangeConfirmation:
    # None is the provider's exact first-address acknowledgment, never an identity.
    tokens: ProviderTokens | None = field(default=None, repr=False)


def _email_response(response: httpx.Response) -> dict[str, Any]:
    if response.status_code in {400, 401, 403, 422}:
        raise InvalidProviderCredentials("Email change denied")
    return _json_response(response)


def request_email_change(client: SupabaseAuthClient, access_token: str, email: str) -> ProviderUser:
    return _provider_user(
        _email_response(client._request("PUT", "user", token=access_token, json={"email": email}))
    )


def verify_email_change(client: SupabaseAuthClient, token_hash: str) -> EmailChangeConfirmation:
    data = _email_response(
        client._request("POST", "verify", json={"token_hash": token_hash, "type": "email_change"})
    )
    partial = {
        "code": "200",
        "msg": "Confirmation link accepted. Please proceed to confirm link sent to the other email",
    }
    if data == partial:
        return EmailChangeConfirmation()
    if "code" in data or "msg" in data:
        raise SupabaseAuthUnavailable("Invalid email-change confirmation")
    return EmailChangeConfirmation(_provider_tokens(data))
