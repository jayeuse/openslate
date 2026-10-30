"""Local session credentials and their binding to a Supabase Auth session.

The refresh handle and the CSRF token are stored only as digests, the provider tokens
are encrypted at rest, and a local session is live only while its provider session
row still exists.
"""

from __future__ import annotations

from hashlib import sha256
from hmac import compare_digest
from uuid import UUID

from cryptography.fernet import Fernet
from sqlalchemy import Uuid, column, select, table
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.identity.models import IdentitySession

_AUTH_SESSIONS = table("sessions", column("id", Uuid()), column("user_id", Uuid()), schema="auth")


def _digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def validate_csrf(session: IdentitySession, csrf_token: str) -> bool:
    return bool(csrf_token) and compare_digest(session.csrf_token_digest, _digest(csrf_token))


def _fernet() -> Fernet:
    secret = get_settings().supabase_session_encryption_key.get_secret_value()
    return Fernet(secret.encode("ascii"))


def _provider_session_exists(db: Session, user_id: UUID, session_id: UUID) -> bool:
    # This is a read-only exception to the application's public-schema ownership.
    # The runtime role receives only SELECT(id, user_id) on auth.sessions.
    result = db.execute(
        select(
            select(1)
            .select_from(_AUTH_SESSIONS)
            .where(
                _AUTH_SESSIONS.c.id == session_id,
                _AUTH_SESSIONS.c.user_id == user_id,
            )
            .exists()
        )
    )
    return result.scalar_one() is True
