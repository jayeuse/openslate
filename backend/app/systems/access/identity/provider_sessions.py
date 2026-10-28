"""Application session admission and liveness for Supabase Auth subjects."""

from __future__ import annotations

from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from hmac import compare_digest
from secrets import token_urlsafe
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import Uuid, column, select, table
from sqlalchemy.exc import InvalidRequestError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    ProviderAccessIdentity,
    ProviderTokens,
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity.contracts import InvalidCredentials, IssuedSession
from app.systems.access.identity.mfa import MFARequired, requires_mfa
from app.systems.access.identity.mfa_observations import (
    initialize_observation,
    observation_started_at,
    record_activity,
    record_provider_observation,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_user_cache import (
    forget_provider_user,
    recent_provider_user,
    remember_provider_user,
)
from app.systems.access.identity.session_revocation import reconcile_session_cap, revoke_session
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.membership import eligible_memberships
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.workspace.models import PlatformSettings
from app.systems.manage.workspace.security_policy import (
    effective_session_expiry,
    load_platform_policy,
    load_workspace_policy,
    renewed_session_expiry,
)

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


def _eligible_user(db: Session, user: User | None, provider_user_id: UUID, now: datetime) -> bool:
    return bool(
        user is not None
        and user.supabase_user_id == provider_user_id
        and user.status == UserStatus.ACTIVE.value
        and is_active_account(db, user, now=now)
    )


def _live_provider_user(
    client: SupabaseAuthClient, user_id: UUID, now: datetime
) -> ProviderUser | None:
    try:
        provider_user = client.get_admin_user(user_id)
    except InvalidProviderCredentials:
        return None
    return (
        provider_user
        if provider_user.id == user_id and provider_user.is_eligible(now=now)
        else None
    )


def admit_provider_session(
    db: Session,
    tokens: ProviderTokens,
    client: SupabaseAuthClient,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
    now: datetime | None = None,
) -> IssuedSession:
    """Admit a verified provider session only for an explicitly bound active profile.

    The caller commits before returning these credentials to a browser or CLI.
    """

    claims = client.verify_access_token(tokens.access_token)
    if claims.user_id != tokens.user_id:
        raise InvalidCredentials("Invalid credentials")
    user = db.scalar(
        select(User)
        .where(User.supabase_user_id == claims.user_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User)
    )
    if user is None or not _eligible_user(db, user, claims.user_id, now or utc_now()):
        raise InvalidCredentials("Invalid credentials")
    # The fresh provider read is serialized with admissions and binding changes.
    started_at = observation_started_at()
    provider_user = _live_provider_user(client, claims.user_id, now or utc_now())
    timestamp = now or utc_now()
    policy = load_platform_policy(db)
    if (
        provider_user is None
        or not provider_user.is_eligible(now=timestamp)
        or not _eligible_user(db, user, claims.user_id, timestamp)
        or claims.expires_at <= timestamp
        or (user.tokens_valid_after is not None and claims.issued_at < user.tokens_valid_after)
        or not _provider_session_exists(db, claims.user_id, claims.session_id)
    ):
        raise InvalidCredentials("Invalid credentials")
    assert user is not None and provider_user is not None
    from app.systems.access.identity.email_changes import synchronize_confirmed_email

    synchronize_confirmed_email(db, user, provider_user, timestamp)
    initialize_observation(db, user.id)
    memberships = eligible_memberships(db, user.id)
    # A sole membership is a default selection, not admission to organization data.
    # MFA/IP policy is rechecked on every organization entry by the dependency.
    selected = memberships[0] if len(memberships) == 1 else None
    csrf = token_urlsafe(32)
    handle = token_urlsafe(48)
    cipher = _fernet()
    session = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        active_org_id=selected.org_id if selected is not None else None,
        provider_user_id=claims.user_id,
        provider_session_id=claims.session_id,
        provider_access_token_encrypted=cipher.encrypt(tokens.access_token.encode()).decode(),
        provider_refresh_token_encrypted=cipher.encrypt(tokens.refresh_token.encode()).decode(),
        refresh_token_digest=_digest(handle),
        csrf_token_digest=_digest(csrf),
        created_at=timestamp,
        refreshed_at=timestamp,
        expires_at=timestamp,
        user_agent=(user_agent or "")[:500] or None,
        ip_address=ip_address,
    )
    session.expires_at = renewed_session_expiry(session, policy, timestamp)
    db.add(session)
    db.flush()
    org_policy = load_workspace_policy(db, org_id=selected.org_id) if selected else None
    if not requires_mfa(org_policy, selected, provider_user) or (
        claims.assurance_level == "aal2"
        and any(
            factor.factor_type == "totp" and factor.status == "verified"
            for factor in provider_user.factors
        )
    ):
        reconcile_session_cap(db, user.id, session.id, policy, now=timestamp)
    record_provider_observation(db, user.id, provider_user, started_at)
    record_activity(db, user.id, provider_user.id, timestamp, sign_in=True)
    return IssuedSession(tokens.access_token, handle, csrf, session.id, False)


def resolve_provider_session(
    db: Session,
    claims: ProviderAccessIdentity,
    client: SupabaseAuthClient,
    *,
    now: datetime | None = None,
    allow_aal1: bool = False,
    policy: PlatformSettings | None = None,
) -> tuple[User, IdentitySession] | None:
    """Ordinary authorization resolves authority without writing observations.

    A recently confirmed provider account may admit the request; a denial is
    always recomputed from a fresh provider read.
    """
    reuse = recent_provider_user(claims.user_id) is not None
    try:
        result = _resolved_provider_session(
            db,
            claims,
            client,
            now=now,
            allow_aal1=allow_aal1,
            policy=policy,
            reuse_recent_provider=reuse,
        )
    except MFARequired:
        if not reuse:
            raise
        result = None
    if result is None and reuse:
        forget_provider_user(claims.user_id)
        result = _resolved_provider_session(
            db, claims, client, now=now, allow_aal1=allow_aal1, policy=policy
        )
    return None if result is None else (result[0], result[1])


# Why the last provider-session resolution in this context refused, for refresh logs.
_resolution_refusal: ContextVar[str | None] = ContextVar("resolution_refusal", default=None)


def _refused(reason: str) -> tuple[User, IdentitySession, ProviderUser, datetime] | None:
    """Record the refusal and give the resolver's refusal value, which is always None."""
    _resolution_refusal.set(reason)
    return None


def _resolved_provider_session(
    db: Session,
    claims: ProviderAccessIdentity,
    client: SupabaseAuthClient,
    *,
    now: datetime | None = None,
    allow_aal1: bool = False,
    policy: PlatformSettings | None = None,
    reuse_recent_provider: bool = False,
) -> tuple[User, IdentitySession, ProviderUser, datetime] | None:
    """Recheck local access, provider account and provider session for every request.

    ``policy`` is the workspace policy the caller already read in this transaction.
    With ``reuse_recent_provider`` a recently confirmed provider account replaces the
    provider read; the caller must recompute any denial without it.
    """

    timestamp = now or utc_now()
    policy = policy or load_platform_policy(db)
    session = db.scalar(
        select(IdentitySession).where(
            IdentitySession.provider_user_id == claims.user_id,
            IdentitySession.provider_session_id == claims.session_id,
        )
    )
    if (
        session is None
        or session.provider_user_id != claims.user_id
        or session.provider_session_id != claims.session_id
    ):
        return _refused("session_missing")
    if session.revoked_at is not None:
        return _refused("session_revoked")
    if effective_session_expiry(session, policy) <= timestamp:
        return _refused("session_expired")
    user = db.scalar(select(User).where(User.id == session.user_id))
    if not _eligible_user(db, user, claims.user_id, timestamp):
        return _refused("account_ineligible")
    assert user is not None
    cutoff = user.tokens_valid_after
    if cutoff is not None:
        cutoff = cutoff if cutoff.tzinfo is not None else cutoff.replace(tzinfo=UTC)
        if claims.issued_at < cutoff:
            return _refused("token_before_cutoff")
    if not _provider_session_exists(db, claims.user_id, claims.session_id):
        return _refused("provider_session_missing")
    started_at = observation_started_at()
    provider_user = recent_provider_user(claims.user_id) if reuse_recent_provider else None
    if provider_user is None:
        provider_user = _live_provider_user(client, claims.user_id, timestamp)
        if provider_user is None:
            return _refused("provider_account_missing")
        remember_provider_user(provider_user)
        # Provider latency must not admit an expired or replaced local authority.
        try:
            db.refresh(user)
            db.refresh(session)
        except InvalidRequestError:
            return _refused("state_unreadable")
        timestamp = now or utc_now()
        policy = load_platform_policy(db)
    if not _eligible_user(db, user, claims.user_id, timestamp):
        return _refused("recheck_account_ineligible")
    if (
        session.user_id != user.id
        or session.provider_user_id != claims.user_id
        or session.provider_session_id != claims.session_id
    ):
        return _refused("recheck_session_changed")
    if session.revoked_at is not None:
        return _refused("recheck_session_revoked")
    if effective_session_expiry(session, policy) <= timestamp:
        return _refused("recheck_session_expired")
    if claims.expires_at <= timestamp:
        return _refused("recheck_token_expired")
    if not provider_user.is_eligible(now=timestamp):
        return _refused("recheck_provider_ineligible")
    if user.tokens_valid_after is not None and claims.issued_at < user.tokens_valid_after:
        return _refused("recheck_token_before_cutoff")
    if (
        not allow_aal1
        and requires_mfa(None, None, provider_user)
        and (
            claims.assurance_level != "aal2"
            or not any(
                factor.factor_type == "totp" and factor.status == "verified"
                for factor in provider_user.factors
            )
        )
    ):
        raise MFARequired("Multi-factor authentication is required")
    return user, session, provider_user, started_at


def refresh_provider_session(
    db: Session,
    refresh_handle: str,
    client: SupabaseAuthClient,
    *,
    csrf_token: str | None = None,
    now: datetime | None = None,
) -> IssuedSession:
    """Serialize provider rotation and persist it before returning a new access token.

    The application handle and CSRF token remain stable for the local session.
    The transaction ends here so a waiting process observes the newly stored pair.
    """

    timestamp = now or utc_now()
    policy = load_platform_policy(db)
    _resolution_refusal.set(None)
    if len(refresh_handle) < 32 or len(refresh_handle) > 256:
        raise InvalidCredentials(reason="handle_invalid")
    session = db.scalar(
        select(IdentitySession)
        .where(IdentitySession.refresh_token_digest == _digest(refresh_handle))
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if session is None or session.provider_user_id is None or session.provider_session_id is None:
        raise InvalidCredentials(reason="session_missing")
    if session.revoked_at is not None:
        raise InvalidCredentials(reason="session_revoked")
    if effective_session_expiry(session, policy) <= timestamp:
        raise InvalidCredentials(reason="session_expired")
    if csrf_token is not None and session.csrf_token_digest != _digest(csrf_token):
        raise InvalidCredentials(reason="csrf_mismatch")
    if not session.provider_access_token_encrypted or not session.provider_refresh_token_encrypted:
        _revoke_locked_session(db, session, timestamp)
        raise InvalidCredentials(reason="provider_tokens_missing")
    cipher = _fernet()
    try:
        current_access = cipher.decrypt(session.provider_access_token_encrypted.encode()).decode()
        current_refresh = cipher.decrypt(session.provider_refresh_token_encrypted.encode()).decode()
    except (InvalidToken, UnicodeDecodeError):
        _revoke_locked_session(db, session, timestamp)
        raise InvalidCredentials(reason="provider_tokens_unreadable") from None
    try:
        current_claims = client.verify_access_token(current_access)
    except InvalidProviderToken:
        current_claims = None
    if (
        current_claims is not None
        and current_claims.user_id == session.provider_user_id
        and current_claims.session_id == session.provider_session_id
        and current_claims.expires_at > timestamp + timedelta(seconds=30)
    ):
        resolved = _resolved_provider_session(db, current_claims, client, now=now, allow_aal1=True)
        if resolved is None:
            _revoke_locked_session(db, session, timestamp)
            raise InvalidCredentials(reason=f"current_{_resolution_refusal.get()}")
        timestamp = now or utc_now()
        session.expires_at = renewed_session_expiry(session, load_platform_policy(db), timestamp)
        session.refreshed_at = timestamp
        session_id = session.id
        try:
            record_provider_observation(db, resolved[0].id, resolved[2], resolved[3])
            record_activity(db, resolved[0].id, resolved[2].id, timestamp)
            db.commit()
        except SQLAlchemyError as error:
            db.rollback()
            raise SupabaseAuthUnavailable("Unable to verify provider session") from error
        return IssuedSession(current_access, refresh_handle, csrf_token or "", session_id, False)
    try:
        tokens = client.refresh(current_refresh)
        claims = client.verify_access_token(tokens.access_token)
    except (InvalidProviderCredentials, InvalidProviderToken) as error:
        _revoke_locked_session(db, session, timestamp)
        raise InvalidCredentials(reason="provider_refused") from error
    except SupabaseAuthUnavailable:
        _revoke_locked_session(db, session, timestamp)
        raise
    resolved = None
    if tokens.user_id == session.provider_user_id and claims.user_id == session.provider_user_id:
        resolved = _resolved_provider_session(db, claims, client, now=now, allow_aal1=True)
    if (
        tokens.user_id != session.provider_user_id
        or claims.user_id != session.provider_user_id
        or claims.session_id != session.provider_session_id
        or resolved is None
    ):
        _revoke_locked_session(db, session, timestamp)
        reason = "rotated_identity_mismatch" if resolved is not None else "rotated"
        raise InvalidCredentials(reason=f"{reason}_{_resolution_refusal.get()}")
    timestamp = now or utc_now()
    session.provider_access_token_encrypted = cipher.encrypt(tokens.access_token.encode()).decode()
    session.provider_refresh_token_encrypted = cipher.encrypt(
        tokens.refresh_token.encode()
    ).decode()
    session.refreshed_at = timestamp
    session.expires_at = renewed_session_expiry(session, load_platform_policy(db), timestamp)
    session_id = session.id
    assert resolved is not None
    try:
        record_provider_observation(db, resolved[0].id, resolved[2], resolved[3])
        record_activity(db, resolved[0].id, resolved[2].id, timestamp)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        # Provider may already have rotated the refresh credential. A second
        # transaction invalidates the local handle if the write failure clears.
        try:
            persisted = db.get(
                IdentitySession, session_id, with_for_update=True, populate_existing=True
            )
            if persisted is not None:
                persisted.revoked_at = timestamp
                db.commit()
        except SQLAlchemyError:
            db.rollback()
        # The provider session is invalidated independently of local recovery.
        try:
            client.sign_out(tokens.access_token)
        except (InvalidProviderCredentials, SupabaseAuthUnavailable):
            pass
        raise SupabaseAuthUnavailable("Unable to persist provider refresh") from error
    return IssuedSession(tokens.access_token, refresh_handle, csrf_token or "", session_id, False)


def revoke_provider_refresh_session(
    db: Session,
    refresh_handle: str,
    *,
    csrf_token: str,
) -> UUID | None:
    """Revoke a browser session even when its short-lived access JWT has expired."""

    if not 32 <= len(refresh_handle) <= 256 or not csrf_token:
        return None
    session = db.scalar(
        select(IdentitySession)
        .where(IdentitySession.refresh_token_digest == _digest(refresh_handle))
        .with_for_update()
    )
    if (
        session is None
        or session.provider_session_id is None
        or session.revoked_at is not None
        or session.csrf_token_digest != _digest(csrf_token)
    ):
        return None
    if not revoke_session(db, session.id, session.user_id):
        return None
    return session.id


def _revoke_locked_session(db: Session, session: IdentitySession, timestamp: datetime) -> None:
    session.revoked_at = timestamp
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise SupabaseAuthUnavailable("Unable to revoke provider session") from error
