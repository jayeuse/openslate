from datetime import UTC, datetime, timedelta
from enum import StrEnum

import jwt
from jwt import InvalidTokenError

from app.core.config import get_settings

ALGORITHM = "HS256"
class TokenType(StrEnum):
    ACCESS = "access"
    REFRESH = "refresh"


def _create_token(subject: str, token_type: TokenType, expires_delta: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": subject,
            "type": token_type.value,
            "iat": now,
            "exp": now + expires_delta,
        },
        settings.secret_key.get_secret_value(),
        algorithm=ALGORITHM,
    )


def create_access_token(subject: str) -> str:
    settings = get_settings()
    return _create_token(
        subject,
        TokenType.ACCESS,
        timedelta(minutes=settings.access_token_expire_minutes),
    )


def create_refresh_token(subject: str) -> str:
    settings = get_settings()
    return _create_token(
        subject,
        TokenType.REFRESH,
        timedelta(days=settings.refresh_token_expire_days),
    )


def _decode_token(token: str, expected_type: TokenType) -> str | None:
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.secret_key.get_secret_value(),
            algorithms=[ALGORITHM],
        )
    except InvalidTokenError:
        return None

    if payload.get("type") != expected_type.value:
        return None
    subject = payload.get("sub")
    return subject if isinstance(subject, str) else None


def decode_access_token(token: str) -> str | None:
    return _decode_token(token, TokenType.ACCESS)


def decode_refresh_token(token: str) -> str | None:
    return _decode_token(token, TokenType.REFRESH)
