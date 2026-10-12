"""Stateless HTTP boundary for one self-hosted Supabase Auth installation."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from threading import Lock
from typing import TYPE_CHECKING, Any
from uuid import UUID

import httpx
import jwt
from jwt import InvalidTokenError
from jwt.exceptions import InvalidKeyError
from pydantic import SecretStr

from app.core.config import get_settings

if TYPE_CHECKING:
    from app.core.integrations.supabase_email_changes import EmailChangeConfirmation


class SupabaseAuthUnavailable(Exception):
    """The provider could not establish an authoritative answer."""


class InvalidProviderCredentials(Exception):
    """The provider explicitly denied a credential exchange."""


class ProviderUserNotFound(InvalidProviderCredentials):
    """The admin endpoint authoritatively reported an absent provider user."""


class InvalidProviderToken(Exception):
    """An access token failed local signature or claim validation."""


@dataclass(frozen=True, slots=True)
class ProviderAccessIdentity:
    user_id: UUID
    session_id: UUID
    issued_at: datetime
    expires_at: datetime
    assurance_level: str = "aal1"


@dataclass(frozen=True, slots=True)
class ProviderTokens:
    access_token: str
    refresh_token: str
    user_id: UUID
    expires_in: int


@dataclass(frozen=True, slots=True)
class ProviderFactor:
    id: UUID
    factor_type: str
    status: str


@dataclass(frozen=True, slots=True)
class ProviderUser:
    id: UUID
    banned_until: datetime | None
    email: str | None = None
    app_metadata: dict[str, Any] = field(default_factory=dict)
    email_confirmed_at: datetime | None = None
    factors: tuple[ProviderFactor, ...] = ()

    def is_eligible(self, *, now: datetime | None = None) -> bool:
        return self.banned_until is None or self.banned_until <= (now or datetime.now(UTC))


class SupabaseAuthClient:
    """No mutable user session or privileged key is shared between requests."""

    def __init__(self, settings: Any, *, transport: httpx.BaseTransport | None = None) -> None:
        self._base_url = str(settings.supabase_url).rstrip("/")
        self._issuer = str(settings.supabase_auth_issuer)
        self._audience = str(settings.supabase_auth_audience)
        self._publishable_key = _secret(settings.supabase_publishable_key)
        self._secret_key = _secret(settings.supabase_secret_key)
        self._timeout = float(settings.supabase_timeout_seconds)
        self._transport = transport
        self._jwks: dict[str, Any] = {}
        self._jwks_expires_at = 0.0
        self._next_jwks_fetch_at = 0.0
        self._last_jwks_fetch_failed = False
        self._jwks_lock = Lock()
        self._jwks_fetch_lock = Lock()

    def _request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        admin: bool = False,
        json: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        headers = {"apikey": self._secret_key if admin else self._publishable_key}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                return client.request(
                    method,
                    f"{self._base_url}/auth/v1/{path.lstrip('/')}",
                    headers=headers,
                    json=json,
                    params=params,
                )
        except httpx.RequestError as error:
            raise SupabaseAuthUnavailable("Supabase Auth is unavailable") from error

    def _exchange(self, payload: dict[str, str], grant_type: str) -> ProviderTokens:
        response = self._request("POST", "token", json=payload, params={"grant_type": grant_type})
        if response.status_code in {400, 401, 403, 422}:
            raise InvalidProviderCredentials("Invalid credentials")
        return _provider_tokens(_json_response(response))

    def password_grant(self, email: str, password: str) -> ProviderTokens:
        return self._exchange({"email": email, "password": password}, "password")

    def refresh(self, refresh_token: str) -> ProviderTokens:
        return self._exchange({"refresh_token": refresh_token}, "refresh_token")

    def admin_create_invitation_user(
        self, email: str, local_user_id: UUID, operation_id: UUID
    ) -> ProviderUser:
        response = self._request(
            "POST",
            "admin/users",
            admin=True,
            json={
                "email": email,
                "app_metadata": {
                    "openslate_user_id": str(local_user_id),
                    "openslate_invitation_operation_id": str(operation_id),
                },
            },
        )
        if response.status_code in {400, 409, 422}:
            raise InvalidProviderCredentials("Provider email is unavailable")
        return _provider_user(_json_response(response))

    def find_invitation_user(
        self, email: str, local_user_id: UUID, operation_id: UUID
    ) -> ProviderUser | None:
        """Find only the exact admin-marked user for an explicit reconciliation."""

        matched: ProviderUser | None = None
        for page in range(1, 51):
            response = self._request(
                "GET",
                "admin/users",
                admin=True,
                params={"filter": email, "page": str(page), "per_page": "200"},
            )
            data = _json_response(response)
            users = data.get("users")
            if not isinstance(users, list) or len(users) > 200:
                raise SupabaseAuthUnavailable("Invalid Supabase user list")
            for raw_user in users:
                if not isinstance(raw_user, dict):
                    raise SupabaseAuthUnavailable("Invalid Supabase user list")
                user = _provider_user(raw_user)
                if (
                    user.email == email
                    and user.app_metadata.get("openslate_user_id") == str(local_user_id)
                    and user.app_metadata.get("openslate_invitation_operation_id")
                    == str(operation_id)
                ):
                    if matched is not None and matched.id != user.id:
                        raise SupabaseAuthUnavailable("Ambiguous Supabase invitation")
                    matched = user
            if len(users) < 200:
                return matched
        raise SupabaseAuthUnavailable("Supabase invitation search is incomplete")

    def admin_send_invitation(self, email: str) -> ProviderUser:
        response = self._request("POST", "invite", admin=True, json={"email": email})
        if response.status_code in {400, 409, 422}:
            raise InvalidProviderCredentials("Provider invitation is unavailable")
        return _provider_user(_json_response(response))

    def verify_email_action(self, token_hash: str, kind: str) -> ProviderTokens:
        if kind not in {"invite", "recovery"}:
            raise ValueError("Unsupported email action")
        response = self._request("POST", "verify", json={"token_hash": token_hash, "type": kind})
        if response.status_code in {400, 401, 403, 422}:
            raise InvalidProviderCredentials("Invalid email action")
        return _provider_tokens(_json_response(response))

    def request_recovery(self, email: str) -> None:
        response = self._request("POST", "recover", json={"email": email})
        if response.status_code != 200:
            raise SupabaseAuthUnavailable("Supabase recovery is unavailable")

    def request_email_change(self, access_token: str, email: str) -> ProviderUser:
        from app.core.integrations.supabase_email_changes import request_email_change

        return request_email_change(self, access_token, email)

    def verify_email_change(self, token_hash: str) -> EmailChangeConfirmation:
        from app.core.integrations.supabase_email_changes import verify_email_change

        return verify_email_change(self, token_hash)

    def update_password(self, access_token: str, password: str) -> ProviderUser:
        response = self._request("PUT", "user", token=access_token, json={"password": password})
        if response.status_code in {400, 401, 403, 422}:
            raise InvalidProviderCredentials("Password update denied")
        return _provider_user(_json_response(response))

    def get_user(self, access_token: str) -> ProviderUser:
        response = self._request("GET", "user", token=access_token)
        if response.status_code in {400, 401, 403, 404}:
            raise InvalidProviderCredentials("Invalid credentials")
        return _provider_user(_json_response(response))

    def get_admin_user(self, user_id: UUID) -> ProviderUser:
        response = self._request("GET", f"admin/users/{user_id}", admin=True)
        if response.status_code == 404:
            raise ProviderUserNotFound("Provider user does not exist")
        return _provider_user(_json_response(response))

    def admin_delete_user(self, user_id: UUID) -> None:
        response = self._request("DELETE", f"admin/users/{user_id}", admin=True)
        if response.status_code == 404:
            raise ProviderUserNotFound("Provider user does not exist")
        if response.status_code not in {200, 204}:
            raise SupabaseAuthUnavailable("Supabase Auth is unavailable")

    def admin_list_factors(self, user_id: UUID) -> list[UUID]:
        response = self._request("GET", f"admin/users/{user_id}/factors", admin=True)
        if response.status_code != 200:
            raise SupabaseAuthUnavailable("Supabase factor list is unavailable")
        try:
            data = response.json()
            if not isinstance(data, list):
                raise ValueError("Expected factor array")
            factor_ids: list[UUID] = []
            for factor in data:
                if not isinstance(factor, dict):
                    raise ValueError("Expected factor object")
                factor_id = UUID(_required_string(factor, "id"))
                if factor_id in factor_ids:
                    raise ValueError("Duplicate factor")
                factor_ids.append(factor_id)
            return factor_ids
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseAuthUnavailable("Supabase Auth returned invalid factors") from error

    def admin_delete_factor(self, user_id: UUID, factor_id: UUID) -> None:
        response = self._request("DELETE", f"admin/users/{user_id}/factors/{factor_id}", admin=True)
        try:
            deleted_id = UUID(_required_string(_json_response(response), "id"))
            if deleted_id != factor_id:
                raise ValueError("Factor deletion does not match")
        except (KeyError, TypeError, ValueError) as error:
            raise SupabaseAuthUnavailable("Supabase Auth returned an invalid factor") from error

    def sign_out(self, access_token: str, *, scope: str = "local") -> None:
        if scope not in {"local", "global"}:
            raise ValueError("Unsupported sign-out scope")
        response = self._request("POST", "logout", token=access_token, params={"scope": scope})
        if response.status_code in {400, 401, 403}:
            raise InvalidProviderCredentials("Invalid credentials")
        if response.status_code not in {200, 204}:
            raise SupabaseAuthUnavailable("Supabase Auth is unavailable")

    def verify_access_token(self, token: str) -> ProviderAccessIdentity:
        if not token or len(token) > 16384:
            raise InvalidProviderToken("Invalid access token")
        try:
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if header.get("alg") != "ES256" or not isinstance(kid, str) or not kid:
                raise InvalidProviderToken("Invalid access token")
            key = self._key_for(kid)
            claims = jwt.decode(
                token,
                key,
                algorithms=["ES256"],
                issuer=self._issuer,
                audience=self._audience,
                options={
                    "require": ["sub", "session_id", "iss", "aud", "iat", "exp", "aal"],
                },
                leeway=0,
            )
            if claims.get("aud") != self._audience:
                raise InvalidProviderToken("Invalid access token")
            issued = _numeric_date(claims, "iat")
            expiry = _numeric_date(claims, "exp")
            if expiry <= issued:
                raise InvalidProviderToken("Invalid access token")
            assurance = _required_string(claims, "aal")
            if assurance not in {"aal1", "aal2"}:
                raise InvalidProviderToken("Invalid access token")
            return ProviderAccessIdentity(
                user_id=UUID(_required_string(claims, "sub")),
                session_id=UUID(_required_string(claims, "session_id")),
                issued_at=issued,
                expires_at=expiry,
                assurance_level=assurance,
            )
        except (InvalidTokenError, KeyError, TypeError, ValueError) as error:
            raise InvalidProviderToken("Invalid access token") from error

    def _key_for(self, kid: str) -> Any:
        with self._jwks_lock:
            cached = self._cached_key(kid)
            if cached is not None:
                return cached
        # Only one request performs network I/O. Cached known keys remain
        # available to other requests while an unfamiliar kid is refreshed.
        with self._jwks_fetch_lock:
            with self._jwks_lock:
                cached = self._cached_key(kid)
                if cached is not None:
                    return cached
                if time.monotonic() < self._next_jwks_fetch_at:
                    if self._last_jwks_fetch_failed:
                        raise SupabaseAuthUnavailable("Supabase JWKS is unavailable")
                    raise InvalidProviderToken("Unknown signing key")
                self._next_jwks_fetch_at = time.monotonic() + 10
            try:
                keys = self._fetch_jwks()
            except SupabaseAuthUnavailable:
                with self._jwks_lock:
                    self._last_jwks_fetch_failed = True
                raise
            with self._jwks_lock:
                self._jwks = keys
                self._jwks_expires_at = time.monotonic() + 300
                self._last_jwks_fetch_failed = False
                try:
                    return self._jwks[kid]
                except KeyError as error:
                    raise InvalidProviderToken("Unknown signing key") from error

    def _cached_key(self, kid: str) -> Any | None:
        if time.monotonic() < self._jwks_expires_at:
            return self._jwks.get(kid)
        return None

    def _fetch_jwks(self) -> dict[str, Any]:
        response = self._request("GET", ".well-known/jwks.json")
        data = _json_response(response)
        raw_keys = data.get("keys")
        if not isinstance(raw_keys, list) or len(raw_keys) > 16:
            raise SupabaseAuthUnavailable("Invalid Supabase JWKS")
        keys: dict[str, Any] = {}
        for item in raw_keys:
            if not isinstance(item, dict):
                continue
            kid = item.get("kid")
            if (
                not isinstance(kid, str)
                or not kid
                or item.get("kty") != "EC"
                or item.get("crv") != "P-256"
                or item.get("alg") != "ES256"
                or item.get("use", "sig") != "sig"
            ):
                continue
            try:
                keys[kid] = jwt.PyJWK.from_dict(item, algorithm="ES256").key
            except (InvalidKeyError, InvalidTokenError, TypeError, ValueError):
                continue
        return keys


def _secret(value: SecretStr | str) -> str:
    return value.get_secret_value() if isinstance(value, SecretStr) else str(value)


def _json_response(response: httpx.Response) -> dict[str, Any]:
    if response.status_code != 200:
        raise SupabaseAuthUnavailable("Supabase Auth is unavailable")
    try:
        data = response.json()
    except ValueError as error:
        raise SupabaseAuthUnavailable("Supabase Auth returned invalid JSON") from error
    if not isinstance(data, dict):
        raise SupabaseAuthUnavailable("Supabase Auth returned invalid JSON")
    return data


def _required_string(data: dict[str, Any], key: str) -> str:
    value = data[key]
    if not isinstance(value, str) or not value:
        raise ValueError(f"Invalid provider {key}")
    return value


def _positive_int(data: dict[str, Any], key: str) -> int:
    value = data[key]
    if type(value) is not int or value <= 0:
        raise ValueError(f"Invalid provider {key}")
    return value


def _numeric_date(data: dict[str, Any], key: str) -> datetime:
    value = data[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"Invalid provider {key}")
    return datetime.fromtimestamp(value, UTC)


def _provider_factors(raw: object) -> tuple[ProviderFactor, ...]:
    if not isinstance(raw, list):
        raise ValueError("Invalid provider factors")
    factors: list[ProviderFactor] = []
    ids: set[UUID] = set()
    for value in raw:
        if not isinstance(value, dict):
            raise ValueError("Invalid provider factor")
        factor_id = UUID(_required_string(value, "id"))
        status = _required_string(value, "status")
        if factor_id in ids or status not in {"unverified", "verified"}:
            raise ValueError("Invalid provider factor state")
        ids.add(factor_id)
        factors.append(ProviderFactor(factor_id, _required_string(value, "factor_type"), status))
    return tuple(factors)


def _provider_user(data: dict[str, Any]) -> ProviderUser:
    nested = data.get("user")
    user = nested if isinstance(nested, dict) else data
    try:
        banned = user.get("banned_until")
        if banned is None:
            banned_until = None
        elif isinstance(banned, str) and banned:
            banned_until = datetime.fromisoformat(banned.replace("Z", "+00:00"))
            if banned_until.tzinfo is None:
                raise ValueError("Provider ban timestamp has no timezone")
        else:
            raise ValueError("Invalid provider ban timestamp")
        email = user.get("email")
        metadata = user.get("app_metadata")
        confirmed = user.get("email_confirmed_at")
        if email is not None and not isinstance(email, str):
            raise ValueError("Invalid provider email")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError("Invalid provider metadata")
        if confirmed is None:
            email_confirmed_at = None
        elif isinstance(confirmed, str) and confirmed:
            email_confirmed_at = datetime.fromisoformat(confirmed.replace("Z", "+00:00"))
            if email_confirmed_at.tzinfo is None:
                raise ValueError("Provider confirmation timestamp has no timezone")
        else:
            raise ValueError("Invalid provider confirmation timestamp")
        return ProviderUser(
            id=UUID(_required_string(user, "id")),
            banned_until=banned_until,
            email=email,
            app_metadata=metadata or {},
            email_confirmed_at=email_confirmed_at,
            factors=_provider_factors(user.get("factors", [])),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise SupabaseAuthUnavailable("Supabase Auth returned an invalid user") from error


def _provider_tokens(data: dict[str, Any]) -> ProviderTokens:
    try:
        user = data["user"]
        return ProviderTokens(
            access_token=_required_string(data, "access_token"),
            refresh_token=_required_string(data, "refresh_token"),
            user_id=UUID(_required_string(user, "id")),
            expires_in=_positive_int(data, "expires_in"),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise SupabaseAuthUnavailable("Supabase Auth returned an invalid session") from error


@lru_cache(maxsize=1)
def get_supabase_auth_client() -> SupabaseAuthClient:
    return SupabaseAuthClient(get_settings())
