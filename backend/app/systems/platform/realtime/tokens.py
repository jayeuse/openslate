"""Short-lived Realtime channel tokens for one person in one organization.

Supabase Realtime verifies these ES256 tokens with the public key in ``JWT_JWKS``.
They are never application or provider sessions: Supabase Auth signs and publishes
only its own keys, so FastAPI and ``/auth/v1/user`` reject them, and Storage grants
``authenticated`` nothing. The ``realtime.messages`` policy accepts a channel only for
``purpose: realtime``, a topic under ``org:<org_id>:``, and a live membership
(``public.can_join_realtime_topic``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from jwt import PyJWK, encode

from app.core.config import Settings

LIFETIME = timedelta(minutes=5)
PURPOSE = "realtime"
ROLE = "authenticated"
_ISSUER_SUFFIX = "/api/realtime"


@dataclass(frozen=True, slots=True)
class RealtimeToken:
    token: str
    expires_at: datetime
    topic_prefix: str


def topic_prefix(org_id: UUID) -> str:
    """Every topic of an organization starts with this prefix (D24)."""

    return f"org:{org_id}:"


def issuer(settings: Settings) -> str:
    return f"{settings.public_origin.rstrip('/')}{_ISSUER_SUFFIX}"


def mint_realtime_token(
    settings: Settings, *, user_id: UUID, org_id: UUID, now: datetime | None = None
) -> RealtimeToken:
    jwk = json.loads(settings.realtime_token_signing_key.get_secret_value())
    key = PyJWK(jwk, algorithm="ES256")
    # Realtime compares whole seconds; drop the fraction so exp is exact.
    issued_at = (now or datetime.now(UTC)).replace(microsecond=0)
    expires_at = issued_at + LIFETIME
    token = encode(
        {
            "iss": issuer(settings),
            "sub": str(user_id),
            "role": ROLE,
            "org_id": str(org_id),
            "purpose": PURPOSE,
            "iat": int(issued_at.timestamp()),
            "exp": int(expires_at.timestamp()),
        },
        key.key,
        algorithm="ES256",
        headers={"kid": jwk["kid"]},
    )
    return RealtimeToken(token, expires_at, topic_prefix(org_id))
