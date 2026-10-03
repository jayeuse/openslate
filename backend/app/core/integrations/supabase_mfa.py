"""Pinned user-token TOTP factor operations; credentials remain ephemeral."""

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import httpx

from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
    _json_response,
    _provider_tokens,
    _required_string,
)


@dataclass(frozen=True, slots=True)
class TotpEnrollment:
    id: UUID
    qr_code: str = field(repr=False)
    secret: str = field(repr=False)
    uri: str = field(repr=False)


class SupabaseMfaClient:
    def __init__(self, auth: SupabaseAuthClient) -> None:
        self.auth = auth

    def enroll_totp(self, access_token: str, *, friendly_name: str | None = None) -> TotpEnrollment:
        payload = {"factor_type": "totp"}
        if friendly_name is not None:
            payload["friendly_name"] = friendly_name
        data = _mfa_json(self.auth._request("POST", "factors", token=access_token, json=payload))
        try:
            if data.get("type") != "totp" or not isinstance(data.get("totp"), dict):
                raise ValueError("Invalid TOTP enrollment")
            totp = data["totp"]
            return TotpEnrollment(
                UUID(_required_string(data, "id")),
                _required_string(totp, "qr_code"),
                _required_string(totp, "secret"),
                _required_string(totp, "uri"),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseAuthUnavailable("Provider returned an invalid MFA enrollment") from error

    def challenge_and_verify(self, access_token: str, factor_id: UUID, code: str) -> ProviderTokens:
        challenge = _mfa_json(
            self.auth._request(
                "POST", f"factors/{factor_id}/challenge", token=access_token, json={}
            )
        )
        try:
            if challenge.get("type") != "totp":
                raise ValueError("Invalid TOTP challenge")
            challenge_id = UUID(_required_string(challenge, "id"))
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseAuthUnavailable("Provider returned an invalid MFA challenge") from error
        data = _mfa_json(
            self.auth._request(
                "POST",
                f"factors/{factor_id}/verify",
                token=access_token,
                json={"challenge_id": str(challenge_id), "code": code},
            )
        )
        return _provider_tokens(data)

    def unenroll(self, access_token: str, factor_id: UUID) -> None:
        data = _mfa_json(self.auth._request("DELETE", f"factors/{factor_id}", token=access_token))
        try:
            if UUID(_required_string(data, "id")) != factor_id:
                raise ValueError("Factor deletion does not match")
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseAuthUnavailable("Provider returned an invalid MFA removal") from error


def _mfa_json(response: httpx.Response) -> dict[str, Any]:
    if response.status_code in {400, 401, 403, 404, 422}:
        raise InvalidProviderCredentials("MFA action denied")
    return _json_response(response)
