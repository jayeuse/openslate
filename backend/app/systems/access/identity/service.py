"""Local identity use cases and token/session coordination."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import token_urlsafe
from typing import Final
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.security.passwords import hash_password, verify_password
from app.core.security.tokens import TokenType, create_token, decode_token
from app.systems.access.identity import rate_limits
from app.systems.access.identity.contracts import (
    ActionTokenInvalid as ActionTokenInvalid,
)
from app.systems.access.identity.contracts import (
    IdentityError,
    IssuedSession,
)
from app.systems.access.identity.contracts import (
    IdentityRateLimited as IdentityRateLimited,
)
from app.systems.access.identity.contracts import (
    InvalidCredentials as InvalidCredentials,
)
from app.systems.access.identity.contracts import (
    RefreshReplayDetected as RefreshReplayDetected,
)
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.identity.models import (
    ActionTokenPurpose,
    IdentityActionToken,
    IdentityCredential,
    IdentitySession,
)
from app.systems.access.identity.session_revocation import (
    invalidate_action_tokens as invalidate_action_tokens,
)
from app.systems.access.identity.session_revocation import revoke_session as revoke_session
from app.systems.access.identity.session_revocation import (
    revoke_user_sessions as revoke_user_sessions,
)
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserStatus

_INVITATION_LIFETIME: Final = timedelta(hours=24)
_RECOVERY_LIFETIME: Final = timedelta(minutes=30)
_TEMPORARY_PASSWORD_LIFETIME: Final = timedelta(hours=24)
_SETUP_SESSION_LIFETIME: Final = timedelta(minutes=10)
_DUMMY_PASSWORD = "unknown identity password verification filler"
_DUMMY_PASSWORD_DIGEST: str | None = None

_cleanup_expired_rate_limit_buckets = rate_limits.cleanup_expired_buckets
_lock_rate_limit_bucket = rate_limits.lock_bucket
_login_fingerprint = rate_limits.login_fingerprint
_normalize_identifier = rate_limits.normalize_identifier
_record_failed_login = rate_limits.record_attempt
_recovery_request_permitted = rate_limits.recovery_request_permitted


def _now(now: datetime | None = None) -> datetime:
    timestamp = now or utc_now()
    return timestamp if timestamp.tzinfo is not None else timestamp.replace(tzinfo=UTC)


def _digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def _dummy_password_digest() -> str:
    global _DUMMY_PASSWORD_DIGEST
    if _DUMMY_PASSWORD_DIGEST is None:
        _DUMMY_PASSWORD_DIGEST = hash_password(_DUMMY_PASSWORD)
    return _DUMMY_PASSWORD_DIGEST


def cleanup_expired_rate_limit_buckets(db: Session, *, now: datetime | None = None) -> int:
    """Bound durable identity rate-limit state during ordinary auth traffic."""

    return _cleanup_expired_rate_limit_buckets(db, now_value=now)


def recovery_request_permitted(
    db: Session,
    identifier: str,
    *,
    source: str | None,
    now: datetime | None = None,
    enforce_rate_limit: bool = True,
) -> bool:
    """Consume recipient and source recovery budgets without leaking identity state."""

    if not enforce_rate_limit:
        return True
    return _recovery_request_permitted(db, identifier, source=source, now_value=now)


def generated_temporary_password() -> str:
    """Return a one-time password that meets the passphrase policy."""

    return token_urlsafe(24)


def create_credential(
    db: Session,
    user_id: UUID,
    password: str,
    *,
    temporary: bool = False,
    now: datetime | None = None,
) -> IdentityCredential:
    timestamp = _now(now)
    credential = IdentityCredential(
        user_id=user_id,
        password_digest=hash_password(password),
        must_change_password=temporary,
        temporary_password_expires_at=(
            timestamp + _TEMPORARY_PASSWORD_LIFETIME if temporary else None
        ),
        password_changed_at=timestamp,
    )
    db.add(credential)
    return credential


def replace_password(
    db: Session,
    user: User,
    password: str,
    *,
    temporary: bool = False,
    now: datetime | None = None,
) -> None:
    credential = db.get(IdentityCredential, user.id, with_for_update=True)
    if credential is None:
        raise IdentityError("Identity credential is unavailable")
    timestamp = _now(now).replace(microsecond=0)
    was_temporary = credential.must_change_password
    credential.password_digest = hash_password(password)
    credential.must_change_password = temporary
    credential.temporary_password_expires_at = (
        timestamp + _TEMPORARY_PASSWORD_LIFETIME if temporary else None
    )
    credential.password_changed_at = timestamp
    user.tokens_valid_after = timestamp
    invalidate_action_tokens(db, user.id, now=timestamp)
    if user.status == UserStatus.PENDING.value and was_temporary and not temporary:
        user.status = UserStatus.ACTIVE.value
        user.invitation_accepted_at = timestamp
    revoke_user_sessions(db, user.id, except_session_id=None, now=timestamp)


def authenticate_password(
    db: Session,
    identifier: str,
    password: str,
    *,
    source: str | None = None,
    now: datetime | None = None,
    enforce_rate_limit: bool = True,
) -> User:
    timestamp = _now(now)
    normalized = _normalize_identifier(identifier)
    fingerprint: str | None = None
    bucket = None
    if enforce_rate_limit:
        cleanup_expired_rate_limit_buckets(db, now=timestamp)
        fingerprint = _login_fingerprint(normalized, source)
        bucket = _lock_rate_limit_bucket(db, fingerprint)
        if (
            bucket is not None
            and bucket.blocked_until is not None
            and bucket.blocked_until > timestamp
        ):
            raise IdentityRateLimited("Too many attempts")
    user = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(or_(User.email == normalized, User.username == normalized))
        .with_for_update(of=User)
    )
    credential = (
        db.get(IdentityCredential, user.id, with_for_update=True) if user is not None else None
    )
    password_valid = verify_password(
        password, credential.password_digest if credential is not None else _dummy_password_digest()
    )
    valid = (
        user is not None
        and credential is not None
        and is_identity_eligible(user, now=timestamp)
        and user.status in {UserStatus.PENDING.value, UserStatus.ACTIVE.value}
        and password_valid
    )
    if not valid:
        if enforce_rate_limit:
            assert fingerprint is not None
            _record_failed_login(db, fingerprint, bucket, timestamp)
        raise InvalidCredentials("Invalid credentials")
    if user is None or credential is None:  # narrow type after the compound predicate
        raise InvalidCredentials("Invalid credentials")
    if credential.must_change_password and (
        credential.temporary_password_expires_at is None
        or credential.temporary_password_expires_at <= timestamp
    ):
        if enforce_rate_limit:
            assert fingerprint is not None
            _record_failed_login(db, fingerprint, bucket, timestamp)
        raise InvalidCredentials("Invalid credentials")
    if enforce_rate_limit and bucket is not None:
        db.delete(bucket)
    return user


def issue_session(
    db: Session,
    user: User,
    *,
    user_agent: str | None = None,
    now: datetime | None = None,
) -> IssuedSession:
    timestamp = _now(now)
    if not is_identity_eligible(user, now=timestamp):
        raise InvalidCredentials("Invalid credentials")
    credential = db.get(IdentityCredential, user.id)
    if credential is None:
        raise IdentityError("Identity credential is unavailable")
    setup_only = credential.must_change_password or user.status != UserStatus.ACTIVE.value
    session = IdentitySession(
        user_id=user.id,
        refresh_token_digest="pending",
        csrf_token_digest="pending",
        refreshed_at=timestamp,
        expires_at=(
            timestamp + _SETUP_SESSION_LIFETIME
            if setup_only
            else timestamp + timedelta(days=get_settings().auth_refresh_token_days)
        ),
        user_agent=(user_agent or "")[:500] or None,
    )
    db.add(session)
    db.flush()
    return _rotate_session_tokens(session, user.id, setup_only=setup_only, now=timestamp)


def refresh_session(
    db: Session,
    refresh_token: str,
    *,
    csrf_token: str | None = None,
    now: datetime | None = None,
) -> IssuedSession:
    timestamp = _now(now)
    claims = decode_token(refresh_token, TokenType.REFRESH, now=timestamp)
    if claims is None:
        raise InvalidCredentials("Invalid credentials")
    session_id = UUID(str(claims["sid"]))
    user_id = UUID(str(claims["sub"]))
    session = db.get(IdentitySession, session_id, with_for_update=True, populate_existing=True)
    if csrf_token is not None and (session is None or not validate_csrf(session, csrf_token)):
        raise InvalidCredentials("Invalid credentials")
    token_digest = _digest(str(claims["jti"]))
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or session.expires_at <= timestamp
        or session.refresh_token_digest != token_digest
    ):
        if (
            session is not None
            and session.revoked_at is None
            and session.expires_at > timestamp
            and session.refresh_token_digest != token_digest
        ):
            session.revoked_at = timestamp
            raise RefreshReplayDetected("Refresh token replay detected")
        raise InvalidCredentials("Invalid credentials")
    user = db.scalar(select(User).options(joinedload(User.role)).where(User.id == user_id))
    if (
        user is None
        or not is_identity_eligible(user, now=timestamp)
        or user.status == UserStatus.DISABLED.value
    ):
        session.revoked_at = timestamp
        raise InvalidCredentials("Invalid credentials")
    credential = db.get(IdentityCredential, user.id)
    if credential is None:
        session.revoked_at = timestamp
        raise InvalidCredentials("Invalid credentials")
    issued_at = claims.get("iat")
    if user.tokens_valid_after is not None and isinstance(issued_at, (int, float)):
        cutoff = user.tokens_valid_after
        cutoff = cutoff if cutoff.tzinfo is not None else cutoff.replace(tzinfo=UTC)
        if datetime.fromtimestamp(issued_at, UTC) < cutoff:
            session.revoked_at = timestamp
            raise InvalidCredentials("Invalid credentials")
    return _rotate_session_tokens(
        session,
        user.id,
        setup_only=credential.must_change_password or user.status != UserStatus.ACTIVE.value,
        now=timestamp,
    )


def _rotate_session_tokens(
    session: IdentitySession, user_id: UUID, *, setup_only: bool, now: datetime
) -> IssuedSession:
    csrf_token = token_urlsafe(32)
    access_token = create_token(
        user_id, session.id, TokenType.ACCESS, now=now, setup_only=setup_only
    )
    if setup_only:
        session.refresh_token_digest = _digest(f"setup:{session.id}")
        session.csrf_token_digest = _digest(csrf_token)
        session.refreshed_at = now
        return IssuedSession(access_token, None, csrf_token, session.id, True)
    refresh_id = token_urlsafe(32)
    refresh_token = create_token(
        user_id, session.id, TokenType.REFRESH, now=now, token_id=refresh_id, setup_only=setup_only
    )
    session.refresh_token_digest = _digest(refresh_id)
    session.csrf_token_digest = _digest(csrf_token)
    session.refreshed_at = now
    return IssuedSession(access_token, refresh_token, csrf_token, session.id, setup_only)


def validate_access_session(
    db: Session,
    claims: dict[str, object],
    *,
    allow_setup: bool = False,
    now: datetime | None = None,
) -> User | None:
    timestamp = _now(now)
    if claims.get("setup") is True and not allow_setup:
        return None
    user_id = UUID(str(claims["sub"]))
    session_id = UUID(str(claims["sid"]))
    session = db.get(IdentitySession, session_id)
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or session.expires_at <= timestamp
    ):
        return None
    user = db.scalar(
        select(User)
        .options(joinedload(User.role), selectinload(User.department_memberships))
        .where(User.id == user_id)
    )
    active_user = (
        user is not None
        and is_identity_eligible(user, now=timestamp)
        and user.status == UserStatus.ACTIVE.value
        and is_established_user(user)
        and user.role is not None
        and not user.role.is_deleted
    )
    setup_user = (
        allow_setup
        and user is not None
        and is_identity_eligible(user, now=timestamp)
        and user.status == UserStatus.PENDING.value
        and user.role is not None
        and not user.role.is_deleted
    )
    if user is None or not (active_user or setup_user):
        return None
    issued_at = claims.get("iat")
    if user.tokens_valid_after is not None and isinstance(issued_at, (int, float)):
        cutoff = user.tokens_valid_after
        cutoff = cutoff if cutoff.tzinfo is not None else cutoff.replace(tzinfo=UTC)
        if datetime.fromtimestamp(issued_at, UTC) < cutoff:
            return None
    return user


def validate_csrf(session: IdentitySession, csrf_token: str) -> bool:
    return bool(csrf_token) and session.csrf_token_digest == _digest(csrf_token)


def revoke_refresh_session(
    db: Session,
    refresh_token: str,
    *,
    csrf_token: str | None = None,
    now: datetime | None = None,
) -> bool:
    """Revoke a valid refresh session without issuing replacement credentials."""

    timestamp = _now(now)
    claims = decode_token(refresh_token, TokenType.REFRESH, now=timestamp)
    if claims is None:
        return False
    session = db.get(IdentitySession, UUID(str(claims["sid"])), with_for_update=True)
    if csrf_token is not None and (session is None or not validate_csrf(session, csrf_token)):
        return False
    if (
        session is None
        or session.user_id != UUID(str(claims["sub"]))
        or session.revoked_at is not None
        or session.expires_at <= timestamp
        or session.refresh_token_digest != _digest(str(claims["jti"]))
    ):
        return False
    session.revoked_at = timestamp
    return True


def issue_action_token(
    db: Session,
    user_id: UUID,
    purpose: ActionTokenPurpose,
    *,
    created_by: UUID | None = None,
    now: datetime | None = None,
    invitation_lifetime: timedelta | None = None,
) -> str:
    timestamp = _now(now)
    user = db.get(User, user_id, with_for_update=True)
    if user is None or not is_identity_eligible(user, now=timestamp):
        raise ActionTokenInvalid("Token recipient is unavailable")
    for item in db.scalars(
        select(IdentityActionToken)
        .where(
            IdentityActionToken.user_id == user_id,
            IdentityActionToken.purpose == purpose,
            IdentityActionToken.consumed_at.is_(None),
        )
        .with_for_update()
    ):
        item.consumed_at = timestamp
    raw_token = token_urlsafe(32)
    if invitation_lifetime is not None and (
        purpose is not ActionTokenPurpose.INVITATION or invitation_lifetime <= timedelta()
    ):
        raise ValueError("Invitation lifetime is invalid")
    lifetime = (
        invitation_lifetime or _INVITATION_LIFETIME
        if purpose is ActionTokenPurpose.INVITATION
        else _RECOVERY_LIFETIME
    )
    db.add(
        IdentityActionToken(
            user_id=user_id,
            purpose=purpose,
            token_digest=_digest(raw_token),
            expires_at=timestamp + lifetime,
            created_by=created_by,
        )
    )
    return raw_token


def consume_action_token(
    db: Session, raw_token: str, purpose: ActionTokenPurpose, *, now: datetime | None = None
) -> IdentityActionToken:
    timestamp = _now(now)
    candidate = db.scalar(
        select(IdentityActionToken).where(IdentityActionToken.token_digest == _digest(raw_token))
    )
    if candidate is None:
        raise ActionTokenInvalid("Token is invalid")
    user = db.get(User, candidate.user_id, with_for_update=True)
    if user is None or not is_identity_eligible(user, now=timestamp):
        raise ActionTokenInvalid("Token is invalid")
    action = db.scalar(
        select(IdentityActionToken)
        .where(IdentityActionToken.token_digest == _digest(raw_token))
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if (
        action is None
        or action.purpose != purpose
        or action.consumed_at is not None
        or action.expires_at <= timestamp
    ):
        raise ActionTokenInvalid("Token is invalid")
    if (purpose is ActionTokenPurpose.RECOVERY and user.status != UserStatus.ACTIVE.value) or (
        purpose is ActionTokenPurpose.INVITATION
        and (
            user.status != UserStatus.PENDING.value
            or user.invitation_sent_at is None
        )
    ):
        raise ActionTokenInvalid("Token is invalid")
    action.consumed_at = timestamp
    return action
