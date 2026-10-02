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
from app.systems.access.identity.contracts import InvalidCredentials
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.session_revocation import revoke_session, revoke_user_sessions
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import load_workspace_policy, session_timeout


class MFARequired(RuntimeError):
    """A live application session still requires signed provider AAL2."""


class MFAFactorUnavailable(RuntimeError):
    """The current provider identity has no matching TOTP factor."""


def requires_mfa(profile: WorkspaceProfile, user: User, provider_user: ProviderUser) -> bool:
    return (
        any(
            factor.factor_type == "totp" and factor.status == "verified"
            for factor in provider_user.factors
        )
        or profile.mfa_policy == "everyone"
        or (profile.mfa_policy == "admins" and user.role == UserRole.ADMIN.value)
    )


def mfa_status(
    db: Session, user: User, access_token: str, client: SupabaseAuthClient
) -> dict[str, object]:
    claims = client.verify_access_token(access_token)
    if claims.user_id != user.supabase_user_id:
        raise InvalidCredentials("Invalid credentials")
    provider_user = _provider_actor(client, access_token, user)
    return {
        "user_id": user.id,
        "assurance_level": claims.assurance_level,
        "required": requires_mfa(load_workspace_policy(db), user, provider_user),
        "factors": [
            {"id": factor.id, "factor_type": factor.factor_type, "status": factor.status}
            for factor in provider_user.factors
        ],
    }


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
) -> str:
    user, session, current_access, _ = _locked_context(
        db, user_id, session_id, presented_access, client
    )
    _factor(_provider_actor(client, current_access, user), factor_id)
    tokens = SupabaseMfaClient(client).challenge_and_verify(current_access, factor_id, code)
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
    timestamp = utc_now()
    if session.expires_at <= timestamp:
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
        session.expires_at = timestamp + session_timeout(load_workspace_policy(db))
        _record(db, user_id, "verified")
        db.commit()
    except (SQLAlchemyError, SupabaseAuthUnavailable) as error:
        _invalidate_after_rotation(db, user_id, session_id, client, tokens.access_token)
        raise SupabaseAuthUnavailable("Unable to persist MFA verification") from error
    return tokens.access_token


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
    SupabaseMfaClient(client).unenroll(current_access, factor_id)
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
    if (
        user is None
        or session is None
        or user.status != UserStatus.ACTIVE.value
        or not is_identity_eligible(user, now=timestamp)
        or not is_established_user(user)
        or session.user_id != user_id
        or session.provider_user_id != user.supabase_user_id
        or session.revoked_at is not None
        or session.expires_at <= timestamp
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
