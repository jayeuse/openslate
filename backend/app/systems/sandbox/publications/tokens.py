"""Short-lived actor/session-bound publication preview tokens."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from uuid import UUID

from jwt import InvalidTokenError, decode, encode

from app.core.config import get_settings

_ALGORITHM = "HS256"
_AUDIENCE = "sandbox-publication-preview"
_ISSUER_SUFFIX = "/sandbox-publication-preview"
_LIFETIME = timedelta(minutes=5)


@dataclass(frozen=True, slots=True)
class PreviewTokenClaims:
    actor_id: UUID
    session_id: UUID
    document_revision: int
    document_hash: str
    impact_digest: str
    live_state_digest: str
    expires_at: datetime
    nonce: str


def issue_preview_token(
    *,
    actor_id: UUID,
    session_id: UUID,
    document_revision: int,
    document_hash: str,
    impact_digest: str,
    live_state_digest: str,
    now: datetime | None = None,
) -> tuple[str, PreviewTokenClaims]:
    timestamp = now or datetime.now(UTC)
    expires_at = timestamp + _LIFETIME
    settings = get_settings()
    nonce = token_urlsafe(24)
    claims = PreviewTokenClaims(
        actor_id=actor_id,
        session_id=session_id,
        document_revision=document_revision,
        document_hash=document_hash,
        impact_digest=impact_digest,
        live_state_digest=live_state_digest,
        expires_at=expires_at,
        nonce=nonce,
    )
    return (
        encode(
            {
                "sub": str(actor_id),
                "sid": str(session_id),
                "rev": document_revision,
                "hash": document_hash,
                "impact": impact_digest,
                "live": live_state_digest,
                "nonce": nonce,
                "operation": "publish",
                "iss": f"{settings.auth_jwt_issuer}{_ISSUER_SUFFIX}",
                "aud": _AUDIENCE,
                "iat": timestamp,
                "nbf": timestamp,
                "exp": expires_at,
            },
            settings.auth_jwt_secret.get_secret_value(),
            algorithm=_ALGORITHM,
        ),
        claims,
    )


def decode_preview_token(token: str, *, now: datetime | None = None) -> PreviewTokenClaims | None:
    settings = get_settings()
    try:
        payload = decode(
            token,
            settings.auth_jwt_secret.get_secret_value(),
            algorithms=[_ALGORITHM],
            audience=_AUDIENCE,
            issuer=f"{settings.auth_jwt_issuer}{_ISSUER_SUFFIX}",
            options={
                "require": ["sub", "sid", "rev", "hash", "impact", "live", "nonce", "exp"],
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
            },
            leeway=0,
        )
        if payload.get("operation") != "publish":
            return None
        expires_at = datetime.fromtimestamp(float(payload["exp"]), UTC)
        if expires_at <= (now or datetime.now(UTC)):
            return None
        revision = payload["rev"]
        hashes = (payload["hash"], payload["impact"], payload["live"])
        if (
            not isinstance(revision, int)
            or revision <= 0
            or any(not isinstance(value, str) or len(value) != 64 for value in hashes)
        ):
            return None
        return PreviewTokenClaims(
            actor_id=UUID(str(payload["sub"])),
            session_id=UUID(str(payload["sid"])),
            document_revision=revision,
            document_hash=str(payload["hash"]),
            impact_digest=str(payload["impact"]),
            live_state_digest=str(payload["live"]),
            expires_at=expires_at,
            nonce=str(payload["nonce"]),
        )
    except (InvalidTokenError, KeyError, TypeError, ValueError):
        return None
