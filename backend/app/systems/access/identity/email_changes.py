"""Self email requests and provider-confirmed admission, without pending local identity state."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.normalization import normalize_email
from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity import rate_limits
from app.systems.access.identity.contracts import (
    ActionTokenInvalid,
    IdentityRateLimited,
    InvalidCredentials,
    IssuedSession,
)
from app.systems.access.users.models import User
from app.systems.manage.audit import service as audit_service
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.security_failures import canonical_source
from app.systems.manage.workspace.security_policy import load_platform_policy


class EmailChangeConflict(Exception):
    """The requested target cannot be used; it has not been reserved."""


class EmailChangeIncomplete(Exception):
    """Provider accepted an effect, but application completion is not established."""

    def __init__(self, *, unavailable: bool = False) -> None:
        self.unavailable = unavailable
        super().__init__("Email change application completion is incomplete")


def _event(
    kind: str, person_id: UUID, operation_id: UUID, outcome: str, stage: str
) -> SecurityEventIngestRequest:
    return SecurityEventIngestRequest(
        event_type=f"identity.{kind}",
        outcome=SecurityEventOutcome(outcome),
        source="identity.email_change",
        operation_id=operation_id,
        actor_id=person_id,
        subject_id=person_id,
        metadata={"stage": stage},
    )


def synchronize_confirmed_email(
    db: Session, user: User, provider: ProviderUser, timestamp: datetime
) -> None:
    """Called only after admission's lock, fresh provider and authority rechecks."""
    try:
        email = normalize_email(provider.email)
    except ValueError as error:
        raise InvalidCredentials("Invalid credentials") from error
    if not isinstance(email, str) or provider.email_confirmed_at is None:
        raise InvalidCredentials("Invalid credentials")
    if email == user.email:
        return
    user.email = email
    audit_service.append_security_event(
        db,
        _event("email_change_confirmed", user.id, uuid7(), "success", "local_admission").model_copy(
            update={"occurred_at": timestamp}
        ),
    )


def request_email_change(
    db: Session,
    person_id: UUID,
    session_id: UUID,
    access_token: str,
    email: str,
    password: str,
    client: SupabaseAuthClient,
    *,
    source: str | None,
    enforce_rate_limit: bool = True,
) -> None:
    from app.systems.access.identity.provider_sessions import _resolved_provider_session

    user = db.scalar(
        select(User)
        .where(User.id == person_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User)
    )
    if user is None or user.supabase_user_id is None:
        raise InvalidCredentials("Invalid credentials")
    if email == user.email or db.scalar(select(User.id).where(User.email == email)) is not None:
        raise EmailChangeConflict("Email address is unavailable")
    policy = load_platform_policy(db)
    timestamp = utc_now()
    fingerprint, bucket = None, None
    if enforce_rate_limit:
        rate_limits.cleanup_expired_buckets(now_value=timestamp)
        fingerprint = rate_limits.login_fingerprint(user.email, None)
        bucket = rate_limits.lock_bucket(db, fingerprint)
        retry = rate_limits.login_retry_after(
            db, bucket, timestamp, policy, source=source, actor_id=person_id, identifier=user.email
        )
        if retry is not None:
            raise IdentityRateLimited("Too many attempts", retry_after=retry)
    temporary = None
    operation_id = uuid7()
    stage = "password_verification"
    effect_started = False
    try:
        temporary = client.password_grant(user.email, password)
        claims = client.verify_access_token(temporary.access_token)
        provider = client.get_user(temporary.access_token)
        if (
            temporary.user_id != user.supabase_user_id
            or claims.user_id != temporary.user_id
            or provider.id != user.supabase_user_id
            or provider.email != user.email
            or provider.email_confirmed_at is None
            or not provider.is_eligible()
        ):
            raise InvalidCredentials("Invalid credentials")
        current = _resolved_provider_session(db, client.verify_access_token(access_token), client)
        if current is None or current[0].id != person_id or current[1].id != session_id:
            raise InvalidCredentials("Invalid credentials")
        # Recheck account eligibility, cutoff, provider, session and account MFA after I/O.
        provider = current[2]
        if (
            provider.id != user.supabase_user_id
            or provider.email != user.email
            or not provider.is_eligible()
        ):
            raise InvalidCredentials("Invalid credentials")
        stage = "provider_request"
        audit_service.append_committed_security_event(
            _event("email_change_request", person_id, operation_id, "attempt", stage)
        )
        effect_started = True
        changed = client.request_email_change(access_token, email)
        if changed.id != user.supabase_user_id or changed.email != user.email:
            raise SupabaseAuthUnavailable("Provider email request could not be established")
        stage = "event_commit"
        if bucket is not None:
            db.delete(bucket)
        if enforce_rate_limit:
            rate_limits.clear_login_account_budget(db, user.email)
        audit_service.append_security_event(
            db,
            _event("email_change_request", person_id, operation_id, "success", "provider_accepted"),
        )
        db.commit()
    except (InvalidProviderCredentials, InvalidCredentials, InvalidProviderToken) as error:
        if effect_started:
            db.rollback()
            audit_service.append_committed_security_event(
                _event("email_change_request", person_id, operation_id, "failure", stage)
            )
        elif fingerprint is not None:
            rate_limits.record_attempt(
                db,
                fingerprint,
                bucket,
                timestamp,
                policy=policy,
                login=True,
                source=source,
                actor_id=person_id,
                identifier=user.email,
            )
            db.commit()
        raise InvalidCredentials("Invalid credentials") from error
    except (
        SupabaseAuthUnavailable,
        SQLAlchemyError,
        audit_service.SecurityEventPersistenceError,
    ) as error:
        db.rollback()
        if effect_started:
            audit_service.append_committed_security_event(
                _event("email_change_request", person_id, operation_id, "partial", stage)
            )
            raise EmailChangeIncomplete(unavailable=True) from error
        raise
    finally:
        if temporary is not None:
            _close_new_session(client, temporary.access_token)


def _close_new_session(client: SupabaseAuthClient, access_token: str) -> None:
    try:
        client.sign_out(access_token, scope="local")
    except (InvalidProviderCredentials, SupabaseAuthUnavailable):
        pass


def complete_email_change(
    db: Session,
    token_hash: str,
    client: SupabaseAuthClient,
    *,
    source: str | None,
    user_agent: str | None,
) -> IssuedSession | None:
    from app.systems.access.identity.provider_sessions import admit_provider_session

    try:
        confirmation = client.verify_email_change(token_hash)
    except InvalidProviderCredentials as error:
        raise ActionTokenInvalid("Email confirmation is invalid") from error
    tokens = confirmation.tokens
    if tokens is None:
        return None
    try:
        issued = admit_provider_session(
            db, tokens, client, ip_address=canonical_source(source), user_agent=user_agent
        )
        db.commit()
        return issued
    except (
        InvalidCredentials,
        InvalidProviderToken,
        InvalidProviderCredentials,
        SQLAlchemyError,
        SupabaseAuthUnavailable,
        audit_service.SecurityEventPersistenceError,
    ) as error:
        db.rollback()
        _close_new_session(client, tokens.access_token)
        unavailable = isinstance(
            error,
            (SQLAlchemyError, SupabaseAuthUnavailable, audit_service.SecurityEventPersistenceError),
        ) and not isinstance(error, IntegrityError)
        raise EmailChangeIncomplete(unavailable=unavailable) from error
