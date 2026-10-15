"""Provider-backed MFA completion and application assurance requirements."""

from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    ProviderAccessIdentity,
    ProviderFactor,
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
)
from app.core.integrations.supabase_mfa import SupabaseMfaClient, TotpEnrollment
from app.systems.access.identity import rate_limits
from app.systems.access.identity.contracts import IdentityRateLimited, InvalidCredentials
from app.systems.access.identity.mfa_observations import (
    commit_bound_observation,
    observation_started_at,
    record_activity,
    record_provider_observation,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_user_cache import forget_provider_user
from app.systems.access.identity.session_revocation import (
    reconcile_session_cap,
    revoke_session,
    revoke_user_sessions,
)
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.membership import eligible_memberships
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import (
    effective_session_expiry,
    load_platform_policy,
    load_workspace_policy,
    mfa_enrollment_deadline,
    mfa_role_required,
    renewed_session_expiry,
)


class MFARequired(RuntimeError):
    """A live application session still requires signed provider AAL2."""


class MFAFactorUnavailable(RuntimeError):
    """The current provider identity has no matching TOTP factor."""


def requires_mfa(
    profile: WorkspaceProfile | None, user: Membership | None, provider_user: ProviderUser
) -> bool:
    if any(
        factor.factor_type == "totp" and factor.status == "verified"
        for factor in provider_user.factors
    ):
        return True
    if profile is None or user is None or not mfa_role_required(profile, user.role):
        return False
    deadline = mfa_enrollment_deadline(profile, user.mfa_required_since)
    return deadline is None or deadline <= utc_now()


def mfa_status(
    db: Session, user: User, access_token: str, client: SupabaseAuthClient
) -> dict[str, object]:
    claims = client.verify_access_token(access_token)
    if claims.user_id != user.supabase_user_id:
        raise InvalidCredentials("Invalid credentials")
    started_at = observation_started_at()
    provider_user = _provider_actor(client, access_token, user)
    db.refresh(user)
    session = db.scalar(
        select(IdentitySession)
        .where(
            IdentitySession.provider_session_id == claims.session_id,
            IdentitySession.user_id == user.id,
        )
        .execution_options(populate_existing=True)
    )
    timestamp = utc_now()
    if (
        user.supabase_user_id != claims.user_id
        or user.status != UserStatus.ACTIVE.value
        or not is_active_account(db, user, now=timestamp)
        or session is None
        or not _same_session(claims, session)
        or session.revoked_at is not None
        or effective_session_expiry(session, load_platform_policy(db)) <= timestamp
        or claims.expires_at <= timestamp
        or (user.tokens_valid_after is not None and claims.issued_at < user.tokens_valid_after)
    ):
        raise InvalidCredentials("Invalid credentials")
    policy, membership = _session_requirement(db, session) if session else (None, None)
    policy_required = bool(policy and membership and mfa_role_required(policy, membership.role))
    since = membership.mfa_required_since if policy_required and membership else None
    result = {
        "user_id": user.id,
        "assurance_level": claims.assurance_level,
        "required": requires_mfa(policy, membership, provider_user),
        "policy_required": policy_required,
        "required_since": since,
        "enrollment_deadline": mfa_enrollment_deadline(policy, since) if policy else None,
        "factors": [
            {"id": factor.id, "factor_type": factor.factor_type, "status": factor.status}
            for factor in provider_user.factors
        ],
    }
    try:
        record_provider_observation(db, user.id, provider_user, started_at)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise SupabaseAuthUnavailable("Unable to persist MFA observation") from error
    return result


def enroll_factor(
    db: Session,
    user_id: UUID,
    session_id: UUID,
    presented_access: str,
    client: SupabaseAuthClient,
    *,
    friendly_name: str | None = None,
) -> TotpEnrollment:
    user, _, current_access, presented = _locked_context(
        db, user_id, session_id, presented_access, client
    )
    started_at = observation_started_at()
    provider_user = _provider_actor(client, current_access, user)
    if (
        any(factor.status == "verified" for factor in provider_user.factors)
        and presented.assurance_level != "aal2"
    ):
        raise MFARequired("Multi-factor authentication is required")
    mfa = SupabaseMfaClient(client)
    enrollment = mfa.enroll_totp(current_access, friendly_name=friendly_name)
    try:
        _record(db, user_id, "enrolled")
        record_provider_observation(db, user_id, provider_user, started_at)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        # The secret has not left this process, so this new factor is still unverified.
        try:
            mfa.unenroll(current_access, enrollment.id)
        except (InvalidProviderCredentials, SupabaseAuthUnavailable):
            pass
        raise SupabaseAuthUnavailable("Unable to finish MFA enrollment") from error
    return enrollment


def verify_factor(
    db: Session,
    user_id: UUID,
    session_id: UUID,
    factor_id: UUID,
    code: str,
    presented_access: str,
    client: SupabaseAuthClient,
    *,
    source: str | None = None,
) -> str:
    user, session, current_access, _ = _locked_context(
        db, user_id, session_id, presented_access, client
    )
    before_provider = _provider_actor(client, current_access, user)
    _factor(before_provider, factor_id)
    retry_after = rate_limits.mfa_verification_retry_after(user_id, source=source)
    if retry_after is not None:
        raise IdentityRateLimited("Too many attempts", retry_after=retry_after)
    before_policy, membership = _session_requirement(db, session)
    current_claims = client.verify_access_token(current_access)
    was_blocked = current_claims.assurance_level == "aal1" and requires_mfa(
        before_policy, membership, before_provider
    )
    try:
        tokens = SupabaseMfaClient(client).challenge_and_verify(current_access, factor_id, code)
    except InvalidProviderCredentials:
        rate_limits.record_mfa_failure(user_id, source=source)
        raise
    # A factor verified through OpenSlate requires AAL2 from every session at once.
    forget_provider_user(tokens.user_id)
    try:
        claims = client.verify_access_token(tokens.access_token)
        if (
            tokens.user_id != session.provider_user_id
            or not _same_session(claims, session)
            or claims.assurance_level != "aal2"
        ):
            raise InvalidProviderToken("Invalid MFA result")
    except InvalidProviderToken as error:
        _invalidate_after_rotation(db, user_id, session_id, client, current_access)
        raise SupabaseAuthUnavailable("Unable to confirm MFA verification") from error
    started_at = observation_started_at()
    try:
        after_provider = _provider_actor(client, tokens.access_token, user)
        if not any(
            factor.factor_type == "totp" and factor.status == "verified"
            for factor in after_provider.factors
        ):
            raise SupabaseAuthUnavailable("Unable to confirm MFA verification")
    except (InvalidCredentials, SupabaseAuthUnavailable) as error:
        _invalidate_after_rotation(db, user_id, session_id, client, tokens.access_token)
        raise SupabaseAuthUnavailable("Unable to confirm MFA verification") from error
    timestamp = utc_now()
    try:
        policy = load_platform_policy(db)
    except SupabaseAuthUnavailable:
        _invalidate_after_rotation(db, user_id, session_id, client, tokens.access_token)
        raise
    if effective_session_expiry(session, policy) <= timestamp:
        _invalidate_after_rotation(db, user_id, session_id, client, tokens.access_token)
        raise InvalidCredentials("Invalid credentials")
    try:
        cipher = _cipher()
        session.provider_access_token_encrypted = cipher.encrypt(
            tokens.access_token.encode()
        ).decode()
        session.provider_refresh_token_encrypted = cipher.encrypt(
            tokens.refresh_token.encode()
        ).decode()
        session.refreshed_at = timestamp
        session.expires_at = renewed_session_expiry(session, policy, timestamp)
        if was_blocked:
            reconcile_session_cap(db, user.id, session.id, policy, now=timestamp)
        bucket = rate_limits.lock_bucket(
            db, rate_limits.rate_limit_fingerprint("mfa-account", str(user_id), None)
        )
        if bucket is not None:
            db.delete(bucket)
        _record(db, user_id, "verified")
        record_provider_observation(db, user_id, after_provider, started_at)
        record_activity(db, user_id, after_provider.id, timestamp)
        db.commit()
    except (SQLAlchemyError, SupabaseAuthUnavailable) as error:
        _invalidate_after_rotation(db, user_id, session_id, client, tokens.access_token)
        raise SupabaseAuthUnavailable("Unable to persist MFA verification") from error
    return tokens.access_token


def _session_requirement(
    db: Session, session: IdentitySession,
) -> tuple[WorkspaceProfile | None, Membership | None]:
    membership = next((row for row in eligible_memberships(db, session.user_id)
                       if row.org_id == session.active_org_id), None)
    policy = load_workspace_policy(db, org_id=membership.org_id) if membership else None
    return policy, membership


def unenroll_factor(
    db: Session,
    user_id: UUID,
    session_id: UUID,
    factor_id: UUID,
    presented_access: str,
    client: SupabaseAuthClient,
    *,
    unverified_only: bool = False,
) -> bool:
    user, _, current_access, presented = _locked_context(
        db, user_id, session_id, presented_access, client
    )
    factor = _factor(_provider_actor(client, current_access, user), factor_id)
    verified = factor.status == "verified"
    if unverified_only and verified:
        return False
    if verified and presented.assurance_level != "aal2":
        raise MFARequired("Multi-factor authentication is required")
    provider_id = user.supabase_user_id
    assert provider_id is not None
    SupabaseMfaClient(client).unenroll(current_access, factor_id)
    forget_provider_user(provider_id)
    started_at = observation_started_at()
    if verified:
        revoke_user_sessions(db, user_id, except_session_id=None)
    try:
        _record(db, user_id, "removed" if verified else "cancelled")
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        if verified:
            try:
                revoke_user_sessions(db, user_id, except_session_id=None)
                _record(db, user_id, "removal_incomplete", SecurityEventOutcome.PARTIAL)
                db.commit()
            except SQLAlchemyError:
                db.rollback()
            try:
                client.sign_out(current_access, scope="global")
            except (InvalidProviderCredentials, SupabaseAuthUnavailable):
                pass
        raise SupabaseAuthUnavailable("Unable to persist MFA removal") from error
    commit_bound_observation(db, user_id, provider_id, None, started_at)
    return verified


def _locked_context(
    db: Session, user_id: UUID, session_id: UUID, presented_access: str, client: SupabaseAuthClient
) -> tuple[User, IdentitySession, str, ProviderAccessIdentity]:
    # The user lock orders factor verification/removal across different local sessions.
    # The session lock also orders token rotation against the existing refresh path.
    user = db.scalar(
        select(User)
        .where(User.id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User)
    )
    session = db.get(IdentitySession, session_id, with_for_update=True, populate_existing=True)
    timestamp = utc_now()
    policy = load_platform_policy(db)
    if (
        user is None
        or session is None
        or user.status != UserStatus.ACTIVE.value
        or not is_active_account(db, user, now=timestamp)
        or session.user_id != user_id
        or session.provider_user_id != user.supabase_user_id
        or session.revoked_at is not None
        or effective_session_expiry(session, policy) <= timestamp
        or session.provider_session_id is None
        or not session.provider_access_token_encrypted
    ):
        raise InvalidCredentials("Invalid credentials")
    presented = client.verify_access_token(presented_access)
    if not _same_session(presented, session):
        raise InvalidCredentials("Invalid credentials")
    cutoff = user.tokens_valid_after
    if cutoff is not None and presented.issued_at < cutoff:
        raise InvalidCredentials("Invalid credentials")
    try:
        access = _cipher().decrypt(session.provider_access_token_encrypted.encode()).decode()
    except (InvalidToken, UnicodeDecodeError) as error:
        raise InvalidCredentials("Invalid credentials") from error
    current = client.verify_access_token(access)
    if not _same_session(current, session):
        raise InvalidCredentials("Invalid credentials")
    return user, session, access, presented


def _same_session(claims: ProviderAccessIdentity, session: IdentitySession) -> bool:
    return (
        claims.user_id == session.provider_user_id
        and claims.session_id == session.provider_session_id
    )


def _provider_actor(client: SupabaseAuthClient, access: str, user: User) -> ProviderUser:
    try:
        provider_user = client.get_user(access)
    except InvalidProviderCredentials as error:
        raise InvalidCredentials("Invalid credentials") from error
    if provider_user.id != user.supabase_user_id or not provider_user.is_eligible():
        raise InvalidCredentials("Invalid credentials")
    return provider_user


def _factor(provider_user: ProviderUser, factor_id: UUID) -> ProviderFactor:
    for factor in provider_user.factors:
        if factor.id == factor_id and factor.factor_type == "totp":
            return factor
    raise MFAFactorUnavailable("MFA factor is unavailable")


def _cipher() -> Fernet:
    return Fernet(get_settings().supabase_session_encryption_key.get_secret_value().encode("ascii"))


def _record(
    db: Session,
    user_id: UUID,
    action: str,
    outcome: SecurityEventOutcome = SecurityEventOutcome.SUCCESS,
) -> None:
    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type=f"identity.mfa.{action}",
            outcome=outcome,
            source="identity.mfa",
            operation_id=uuid7(),
            actor_id=user_id,
            subject_id=user_id,
            reason=f"TOTP factor {action}",
        ),
    )


def _invalidate_after_rotation(
    db: Session, user_id: UUID, session_id: UUID, client: SupabaseAuthClient, access: str
) -> None:
    db.rollback()
    try:
        revoke_session(db, session_id, user_id)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
    # Provider invalidation is independent if the local database remains unavailable.
    try:
        client.sign_out(access)
    except (InvalidProviderCredentials, SupabaseAuthUnavailable):
        pass
