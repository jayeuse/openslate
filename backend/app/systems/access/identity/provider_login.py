"""Provider password verification with the application's durable admission budget."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity import rate_limits
from app.systems.access.identity.contracts import (
    IdentityRateLimited,
    InvalidCredentials,
    IssuedSession,
)
from app.systems.access.identity.provider_sessions import admit_provider_session
from app.systems.manage.workspace.security_policy import load_workspace_policy


def login_with_provider(
    db: Session,
    email: str,
    password: str,
    client: SupabaseAuthClient,
    *,
    source: str | None = None,
    user_agent: str | None = None,
    now: datetime | None = None,
    enforce_rate_limit: bool = True,
) -> IssuedSession:
    """Exchange a password, then admit only a bound local user and provider session."""

    timestamp = now or utc_now()
    policy = load_workspace_policy(db)
    fingerprint: str | None = None
    bucket = None
    if enforce_rate_limit:
        rate_limits.cleanup_expired_buckets(db, now_value=timestamp)
        fingerprint = rate_limits.login_fingerprint(email, source)
        bucket = rate_limits.lock_bucket(db, fingerprint)
        retry_after = rate_limits.login_retry_after(db, bucket, timestamp, policy)
        if retry_after is not None:
            raise IdentityRateLimited("Too many attempts", retry_after=retry_after)
    try:
        tokens = client.password_grant(email, password)
    except InvalidProviderCredentials as error:
        if fingerprint is not None:
            rate_limits.record_attempt(db, fingerprint, bucket, timestamp, policy=policy)
        raise InvalidCredentials("Invalid credentials") from error
    try:
        issued = admit_provider_session(db, tokens, client, user_agent=user_agent)
    except InvalidCredentials:
        if fingerprint is not None:
            rate_limits.record_attempt(db, fingerprint, bucket, timestamp, policy=policy)
        try:
            client.sign_out(tokens.access_token)
        except (InvalidProviderCredentials, SupabaseAuthUnavailable):
            pass
        raise
    except InvalidProviderToken as error:
        raise SupabaseAuthUnavailable("Supabase Auth returned an invalid session") from error
    if bucket is not None:
        db.delete(bucket)
    return issued
