"""Provider email actions with application-owned admission and lifecycle checks."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.config.development import is_relaxed_development
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity import rate_limits
from app.systems.access.identity.contracts import (
    ActionTokenInvalid,
    IdentityRateLimited,
    InvalidCredentials,
)
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.users.acceptance import accept_verified_invitation
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit import service as audit_service
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.security_failures import canonical_source
from app.systems.manage.workspace.security_policy import load_workspace_policy, validate_password


def try_commit_login_denial(db: Session) -> bool:
    """Commit the denied attempt's budget/events; caller owns its HTTP failure mapping."""
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        return False
    return True


def anonymous_rate_limits_enabled() -> bool:
    settings = get_settings()
    return not (is_relaxed_development(settings) or settings.e2e_seeding_without_anonymous_limits)


def _verified_action(
    client: SupabaseAuthClient, token_hash: str, kind: str
) -> tuple[ProviderTokens, ProviderUser]:
    try:
        tokens = client.verify_email_action(token_hash, kind)
        user = client.get_user(tokens.access_token)
    except InvalidProviderCredentials as error:
        raise ActionTokenInvalid("Email action is invalid") from error
    if user.id != tokens.user_id or not user.is_eligible():
        raise ActionTokenInvalid("Email action is invalid")
    return tokens, user


def _sign_out_verified_action(
    client: SupabaseAuthClient, access_token: str, *, scope: str = "global"
) -> None:
    # No application session is ever admitted for an email action. Failure to
    # close this provider-only session does not grant application access.
    try:
        client.sign_out(access_token, scope=scope)
    except (InvalidProviderCredentials, SupabaseAuthUnavailable):
        pass


def _action_event(
    kind: str,
    outcome: SecurityEventOutcome,
    operation_id: UUID,
    person_id: UUID | None,
    stage: str,
    source: str | None,
) -> SecurityEventIngestRequest:
    return SecurityEventIngestRequest(
        event_type=f"identity.{kind}",
        outcome=outcome,
        source="identity.provider_action",
        operation_id=operation_id,
        actor_id=person_id,
        subject_id=person_id,
        reason="request_accepted"
        if kind == "recovery_request" and outcome == SecurityEventOutcome.SUCCESS
        else None,
        metadata={"stage": stage, "ip_address": canonical_source(source)},
    )


def request_recovery(
    db: Session,
    email: str,
    client: SupabaseAuthClient,
    *,
    source: str | None,
    enforce_rate_limit: bool,
) -> None:
    permitted = (
        rate_limits.recovery_request_permitted(db, email, source=source)
        if enforce_rate_limit
        else True
    )
    db.commit()
    if not permitted:
        return
    operation_id = uuid7()
    audit_service.append_committed_security_event(
        _action_event(
            "recovery_request",
            SecurityEventOutcome.ATTEMPT,
            operation_id,
            None,
            "provider_request",
            source,
        )
    )
    stage = "provider_request_unconfirmed"
    try:
        client.request_recovery(email)
        stage = "event_commit"
        audit_service.append_committed_security_event(
            _action_event(
                "recovery_request",
                SecurityEventOutcome.SUCCESS,
                operation_id,
                None,
                "provider_accepted",
                source,
            )
        )
    except (SupabaseAuthUnavailable, audit_service.SecurityEventPersistenceError):
        db.rollback()
        audit_service.append_committed_security_event(
            _action_event(
                "recovery_request",
                SecurityEventOutcome.PARTIAL,
                operation_id,
                None,
                stage,
                source,
            )
        )
        raise


def complete_recovery(
    db: Session,
    token_hash: str,
    password: str,
    client: SupabaseAuthClient,
    *,
    source: str | None = None,
) -> None:
    """Change a bound active user's provider password without issuing an app session."""

    validate_password(load_workspace_policy(db), password)
    tokens, provider_user = _verified_action(client, token_hash, "recovery")
    password_updated = False
    operation_id = None
    effect_started = False
    person_id = None
    stage = "provider_update"
    try:
        local = db.scalar(
            select(User).where(User.supabase_user_id == provider_user.id).with_for_update(of=User)
        )
        if (
            local is None
            or local.email != provider_user.email
            or local.status != UserStatus.ACTIVE.value
            or not is_identity_eligible(local)
            or not is_established_user(local)
        ):
            raise ActionTokenInvalid("Recovery token is invalid")
        person_id, operation_id = local.id, uuid7()
        audit_service.append_committed_security_event(
            _action_event(
                "recovery_complete",
                SecurityEventOutcome.ATTEMPT,
                operation_id,
                person_id,
                stage,
                source,
            )
        )
        effect_started = True
        updated = client.update_password(tokens.access_token, password)
        if updated.id != provider_user.id:
            raise ActionTokenInvalid("Recovery token is invalid")
        password_updated = True
        stage = "local_commit"
        revoke_user_sessions(db, local.id, except_session_id=None)
        audit_service.append_security_event(
            db,
            _action_event(
                "recovery_complete",
                SecurityEventOutcome.SUCCESS,
                operation_id,
                person_id,
                stage,
                source,
            ),
        )
        db.commit()
    except (
        InvalidProviderCredentials,
        ActionTokenInvalid,
        SupabaseAuthUnavailable,
        SQLAlchemyError,
        audit_service.SecurityEventPersistenceError,
    ) as error:
        db.rollback()
        if operation_id is not None and effect_started:
            outcome = (
                SecurityEventOutcome.FAILURE
                if isinstance(error, InvalidProviderCredentials)
                else SecurityEventOutcome.PARTIAL
            )
            audit_service.append_committed_security_event(
                _action_event(
                    "recovery_complete",
                    outcome,
                    operation_id,
                    person_id,
                    stage,
                    source,
                )
            )
        raise
    finally:
        _sign_out_verified_action(
            client, tokens.access_token, scope="global" if password_updated else "local"
        )


def complete_invitation(
    db: Session, token_hash: str, password: str, client: SupabaseAuthClient
) -> None:
    """Activate only the local pending profile explicitly bound to this invite."""

    validate_password(load_workspace_policy(db), password)
    try:
        tokens, provider_user = _verified_action(client, token_hash, "invite")
    except ActionTokenInvalid as error:
        raise InvitationError("Invitation token is invalid") from error
    try:
        local = db.scalar(
            select(User).where(User.supabase_user_id == provider_user.id).with_for_update(of=User)
        )
        if (
            local is None
            or local.email != provider_user.email
            or local.status != UserStatus.PENDING.value
            or local.invitation_sent_at is None
            or local.provider_invitation_operation_id is None
            or not is_identity_eligible(local)
            or provider_user.app_metadata.get("openslate_user_id") != str(local.id)
            or provider_user.app_metadata.get("openslate_invitation_operation_id")
            != str(local.provider_invitation_operation_id)
        ):
            raise InvitationError("Invitation token is invalid")
        updated = client.update_password(tokens.access_token, password)
        if updated.id != provider_user.id:
            raise InvitationError("Invitation token is invalid")
        accept_verified_invitation(
            db,
            local.id,
            verified_email=provider_user.email,
            verified_identity=local.id,
        )
    finally:
        _sign_out_verified_action(client, tokens.access_token)


def change_password(
    db: Session,
    user: User,
    current_session_id: UUID,
    current_access_token: str,
    old_password: str,
    new_password: str,
    client: SupabaseAuthClient,
    *,
    enforce_rate_limit: bool = True,
    source: str | None = None,
) -> None:
    """Verify the current provider password and retain only this app session."""

    policy = load_workspace_policy(db)
    validate_password(policy, new_password)
    timestamp = utc_now()
    person_id = user.id
    operation_id = None
    effect_started = False
    stage = "provider_update"
    fingerprint = None
    bucket = None
    if enforce_rate_limit:
        rate_limits.cleanup_expired_buckets(now_value=timestamp)
        fingerprint = rate_limits.login_fingerprint(user.email, None)
        bucket = rate_limits.lock_bucket(db, fingerprint)
        retry_after = rate_limits.login_retry_after(
            db, bucket, timestamp, policy, source=source, actor_id=person_id, identifier=user.email
        )
        if retry_after is not None:
            raise IdentityRateLimited("Too many attempts", retry_after=retry_after)
    try:
        temporary = client.password_grant(user.email, old_password)
    except InvalidProviderCredentials as error:
        if fingerprint is not None:
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
    try:
        if temporary.user_id != user.supabase_user_id:
            if fingerprint is not None:
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
            raise InvalidCredentials("Invalid credentials")
        provider_user = client.get_user(temporary.access_token)
        if (
            provider_user.id != user.supabase_user_id
            or provider_user.email != user.email
            or not provider_user.is_eligible()
        ):
            if fingerprint is not None:
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
            raise InvalidCredentials("Invalid credentials")
        locked = db.get(User, user.id, with_for_update=True, populate_existing=True)
        if (
            locked is None
            or locked.supabase_user_id != temporary.user_id
            or locked.status != UserStatus.ACTIVE.value
            or not is_identity_eligible(locked)
        ):
            if fingerprint is not None:
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
            raise InvalidCredentials("Invalid credentials")
        operation_id = uuid7()
        audit_service.append_committed_security_event(
            _action_event(
                "password_change",
                SecurityEventOutcome.ATTEMPT,
                operation_id,
                person_id,
                stage,
                source,
            )
        )
        effect_started = True
        changed = client.update_password(current_access_token, new_password)
        if changed.id != temporary.user_id:
            raise InvalidCredentials("Invalid credentials")
        stage = "local_commit"
        revoke_user_sessions(db, user.id, except_session_id=current_session_id)
        if bucket is not None:
            db.delete(bucket)
        if enforce_rate_limit:
            rate_limits.clear_login_account_budget(db, user.email)
        audit_service.append_security_event(
            db,
            _action_event(
                "password_change",
                SecurityEventOutcome.SUCCESS,
                operation_id,
                person_id,
                stage,
                source,
            ),
        )
        db.commit()
    except (
        InvalidProviderCredentials,
        InvalidCredentials,
        SupabaseAuthUnavailable,
        SQLAlchemyError,
        audit_service.SecurityEventPersistenceError,
    ) as error:
        db.rollback()
        if operation_id is not None and effect_started:
            outcome = (
                SecurityEventOutcome.FAILURE
                if isinstance(error, InvalidProviderCredentials)
                else SecurityEventOutcome.PARTIAL
            )
            audit_service.append_committed_security_event(
                _action_event(
                    "password_change",
                    outcome,
                    operation_id,
                    person_id,
                    stage,
                    source,
                )
            )
        raise
    finally:
        try:
            client.sign_out(temporary.access_token, scope="local")
        except (InvalidProviderCredentials, SupabaseAuthUnavailable):
            pass
