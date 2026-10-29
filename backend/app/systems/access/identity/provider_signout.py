"""Bounded durable provider sign-out after local session revocation."""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.session_credentials import _provider_session_exists

MAX_SIGNOUT_ATTEMPTS = 5
SIGNOUT_BATCH_SIZE = 10


def attempt_provider_signout(
    db: Session,
    session_id: UUID,
    client: SupabaseAuthClient,
    *,
    now: datetime | None = None,
) -> bool:
    """Return true once the exact provider session is confirmed absent."""

    timestamp = now or utc_now()
    session = db.get(IdentitySession, session_id, with_for_update=True, populate_existing=True)
    if (
        session is None
        or session.revoked_at is None
        or session.provider_signout_pending_at is None
        or session.provider_signout_attempts >= MAX_SIGNOUT_ATTEMPTS
        or session.provider_signout_next_attempt_at is None
        or session.provider_signout_next_attempt_at > timestamp
    ):
        return False
    if session.provider_user_id is None or session.provider_session_id is None:
        _complete(db, session, timestamp)
        return True
    if not _provider_session_exists(db, session.provider_user_id, session.provider_session_id):
        _complete(db, session, timestamp)
        return True
    try:
        encrypted_refresh = session.provider_refresh_token_encrypted
        if encrypted_refresh is None:
            raise InvalidToken
        cipher = Fernet(get_settings().supabase_session_encryption_key.get_secret_value())
        refresh_token = cipher.decrypt(encrypted_refresh.encode()).decode()
        tokens = client.refresh(refresh_token)
        claims = client.verify_access_token(tokens.access_token)
        if (
            tokens.user_id != session.provider_user_id
            or claims.user_id != session.provider_user_id
            or claims.session_id != session.provider_session_id
        ):
            raise InvalidProviderToken("Provider session changed during sign-out")
        # Keep the rotated credential durable for the next attempt if sign-out
        # fails after Auth has consumed the old refresh token.
        session.provider_access_token_encrypted = cipher.encrypt(
            tokens.access_token.encode()
        ).decode()
        session.provider_refresh_token_encrypted = cipher.encrypt(
            tokens.refresh_token.encode()
        ).decode()
        client.sign_out(tokens.access_token)
        if not _provider_session_exists(db, session.provider_user_id, session.provider_session_id):
            _complete(db, session, timestamp)
            return True
    except (
        InvalidProviderCredentials,
        InvalidProviderToken,
        SupabaseAuthUnavailable,
        InvalidToken,
        UnicodeDecodeError,
    ):
        pass
    _schedule_retry(db, session, timestamp)
    return False


def drain_provider_signouts(db: Session, client: SupabaseAuthClient) -> int:
    """Process a bounded batch; call periodically from the API worker lifespan."""

    timestamp = utc_now()
    ids = db.scalars(
        select(IdentitySession.id)
        .where(
            IdentitySession.provider_signout_pending_at.is_not(None),
            IdentitySession.provider_signout_next_attempt_at <= timestamp,
            IdentitySession.provider_signout_attempts < MAX_SIGNOUT_ATTEMPTS,
        )
        .order_by(IdentitySession.provider_signout_next_attempt_at)
        .limit(SIGNOUT_BATCH_SIZE)
    ).all()
    completed = 0
    for session_id in ids:
        if attempt_provider_signout(db, session_id, client, now=timestamp):
            completed += 1
    return completed


def _complete(db: Session, session: IdentitySession, timestamp: datetime) -> None:
    session.provider_signout_pending_at = None
    session.provider_signout_next_attempt_at = None
    session.provider_signout_completed_at = timestamp
    db.commit()


def _schedule_retry(db: Session, session: IdentitySession, timestamp: datetime) -> None:
    session.provider_signout_attempts += 1
    if session.provider_signout_attempts >= MAX_SIGNOUT_ATTEMPTS:
        session.provider_signout_next_attempt_at = None
    else:
        session.provider_signout_next_attempt_at = timestamp + timedelta(
            minutes=2 ** (session.provider_signout_attempts - 1)
        )
    db.commit()
