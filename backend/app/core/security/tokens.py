"""Locally issued, purpose-bound JWTs."""

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from secrets import token_urlsafe
from typing import Any
from uuid import UUID

from jwt import InvalidTokenError, decode, encode

from app.core.config import get_settings

ALGORITHM = "HS256"


class TokenType(StrEnum):
    ACCESS = "access"
    REFRESH = "refresh"


def create_token(
    subject: UUID,
    session_id: UUID,
    token_type: TokenType,
    *,
    now: datetime | None = None,
    token_id: str | None = None,
    setup_only: bool = False,
) -> str:
    settings = get_settings()
    issued_at = now or datetime.now(UTC)
    lifetime = (
        timedelta(minutes=settings.auth_access_token_minutes)
        if token_type is TokenType.ACCESS
        else timedelta(days=settings.auth_refresh_token_days)
    )
    if setup_only and token_type is TokenType.ACCESS:
        lifetime = min(lifetime, timedelta(minutes=10))
    return encode(
        {
            "sub": str(subject),
            "sid": str(session_id),
            "jti": token_id or token_urlsafe(32),
            "type": token_type.value,
            "setup": setup_only,
            "iss": settings.auth_jwt_issuer,
            "aud": settings.auth_jwt_audience,
            "iat": issued_at,
            "nbf": issued_at,
            "exp": issued_at + lifetime,
        },
        settings.auth_jwt_secret.get_secret_value(),
        algorithm=ALGORITHM,
    )


def decode_token(
    token: str,
    expected_type: TokenType,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    settings = get_settings()
    try:
        claims = decode(
            token,
            settings.auth_jwt_secret.get_secret_value(),
            algorithms=[ALGORITHM],
            issuer=settings.auth_jwt_issuer,
            audience=settings.auth_jwt_audience,
            options={"require": ["sub", "sid", "jti", "type", "iat", "nbf", "exp"]},
            leeway=0,
        )
    except (InvalidTokenError, TypeError, ValueError):
        return None
    if now is not None:
        expiry = claims.get("exp")
        if not isinstance(expiry, (int, float)) or expiry <= now.timestamp():
            return None
    try:
        UUID(str(claims.get("sub")))
        UUID(str(claims.get("sid")))
    except ValueError:
        return None
    if claims.get("type") != expected_type.value or not isinstance(claims.get("jti"), str):
        return None
    return claims
