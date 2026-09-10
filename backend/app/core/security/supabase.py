from functools import lru_cache
from typing import Any
from uuid import UUID

from jwt import InvalidTokenError, PyJWKClient, PyJWKClientError, decode

from app.core.config import get_settings

ALLOWED_ALGORITHMS = ["ES256", "RS256"]

@lru_cache(maxsize=8)
def _cached_jwks_client(jwks_url: str, factory: Any) -> Any:
    """Cache by URL and factory identity so test seams cannot leak clients."""

    return factory(jwks_url)


def _verification_settings() -> tuple[str, str, str]:
    settings = get_settings()
    return settings.supabase_jwks_url, settings.supabase_jwt_issuer, settings.supabase_jwt_audience


def verify_supabase_jwt(token: str) -> dict[str, Any] | None:
    """Verify a Supabase access token and return its claims when it is valid."""

    jwks_url, issuer, audience = _verification_settings()
    if not token or not jwks_url or not issuer or not audience:
        return None

    try:
        signing_key = _cached_jwks_client(jwks_url, PyJWKClient).get_signing_key_from_jwt(token)
        claims = decode(
            token,
            signing_key.key,
            algorithms=ALLOWED_ALGORITHMS,
            issuer=issuer,
            audience=audience,
        )
    except (InvalidTokenError, PyJWKClientError, TypeError, ValueError):
        return None

    # PyJWT validates exp when present. Requiring it here also prevents a
    # token with an omitted expiry from being accepted.
    if not isinstance(claims, dict) or any(
        claim not in claims for claim in ("sub", "iss", "aud", "exp")
    ):
        return None
    if claims.get("iss") != issuer:
        return None
    token_audience = claims.get("aud")
    if not (
        token_audience == audience
        or isinstance(token_audience, list)
        and audience in token_audience
    ):
        return None
    subject = claims.get("sub")
    try:
        UUID(subject) if isinstance(subject, str) else None
    except ValueError:
        return None
    if not isinstance(subject, str) or not subject:
        return None
    return claims
