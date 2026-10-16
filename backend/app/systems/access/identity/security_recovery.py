"""Elevated-console recovery of workspace MFA and network policy."""

from dataclasses import dataclass
from typing import NoReturn
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import scope_session
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.admin_recovery import (
    LocalRecoveryError,
    OrganizationChoiceRequired,
    administered_membership,
)
from app.systems.access.identity.mfa_observations import (
    commit_bound_observation,
    observation_started_at,
    record_observation,
)
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.users.eligibility import established_user_clause, is_active_account
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
    append_security_event,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import mfa_role_required


class LocalSecurityRecoveryError(LocalRecoveryError):
    """A redacted refusal or truthful distributed partial recovery outcome."""

    def __init__(
        self,
        message: str,
        *,
        local_reset_committed: bool | None = False,
        provider_factors_cleared: bool | None = False,
    ) -> None:
        super().__init__(message)
        self.local_reset_committed = local_reset_committed
        self.provider_factors_cleared = provider_factors_cleared


@dataclass(frozen=True, slots=True)
class RecoveredWorkspaceSecurity:
    user_id: UUID


def recover_workspace_security(
    db: Session,
    user_id: UUID,
    *,
    local_invocation: bool,
    elevated: bool,
    organization: UUID | str | None = None,
) -> RecoveredWorkspaceSecurity:
    """Commit the local escape hatch before clearing bound provider factors.

    It resets the MFA and network policy of ``organization`` (an id or slug), or of the
    one organization the person administers when it is omitted.
    """

    if not local_invocation or not elevated:
        raise LocalSecurityRecoveryError("Local elevated workspace recovery is required")
    operation_id = uuid7()
    commit_started = False
    chosen: UUID | None = None
    try:
        user, org_id = _administrator(db, user_id, organization, lock=False)
        chosen = org_id
        provider_id, email = user.supabase_user_id, user.email
        assert provider_id is not None
        # Release the read transaction before provider I/O; recheck under lock below.
        db.rollback()
        provider = get_supabase_auth_client()
        provider_user = provider.get_admin_user(provider_id)
        if (
            provider_user.id != provider_id
            or provider_user.email != email
            or not provider_user.is_eligible(now=utc_now())
        ):
            raise LocalSecurityRecoveryError("Provider administrator does not match")
        # The organization chosen above stays the one checked and changed from here on.
        user, _ = _administrator(db, user_id, org_id, lock=True)
        _same_binding(user, provider_id, email)
        profile = _workspace(db, org_id)
        required = {role: mfa_role_required(profile, role) for role in ("admin", "member", "guest")}
        if any(required.values()) or profile.ip_allow_list:
            for affected in db.scalars(
                select(Membership)
                .where(
                    established_user_clause(),
                    Membership.role.in_([role for role, enabled in required.items() if enabled]),
                    Membership.org_id == profile.id,
                )
                .order_by(Membership.user_id)
                .execution_options(populate_existing=True)
                .with_for_update(of=Membership, nowait=True)
            ):
                affected.mfa_required_since = None
            profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = (
                False
            )
            profile.ip_allow_list = []
            profile.revision += 1
        revoke_user_sessions(db, user_id, except_session_id=None)
        append_security_event(
            db,
            _event(user_id, operation_id, SecurityEventOutcome.ATTEMPT, "local elevated recovery"),
            org_id=org_id,
        )
        record_observation(db, user_id, provider_id, None, observation_started_at())
        commit_started = True
        db.commit()
    except (LocalSecurityRecoveryError, OrganizationChoiceRequired):
        db.rollback()
        raise
    except (InvalidProviderCredentials, SupabaseAuthUnavailable, SQLAlchemyError):
        db.rollback()
        _failure(
            user_id,
            operation_id,
            "Local security reset could not be confirmed; rerun recovery",
            local_reset=None if commit_started else False,
            factors_cleared=False,
            org_id=chosen,
        )

    factors_cleared: bool | None = None
    try:
        for factor_id in provider.admin_list_factors(provider_id):
            provider.admin_delete_factor(provider_id, factor_id)
        started_at = observation_started_at()
        if provider.admin_list_factors(provider_id):
            factors_cleared = False
            raise LocalSecurityRecoveryError("Provider factors remain; rerun recovery")
        factors_cleared = True
        user, _ = _administrator(db, user_id, org_id, lock=True)
        _same_binding(user, provider_id, email)
        profile = _workspace(db, org_id)
        if (
            any(mfa_role_required(profile, role) for role in ("admin", "member", "guest"))
            or profile.ip_allow_list
        ):
            raise LocalSecurityRecoveryError("Workspace policy changed during recovery")
        # Commit mandatory cleanup before fallible projection/terminal persistence.
        revoke_user_sessions(db, user_id, except_session_id=None)
        db.commit()
        record_observation(db, user_id, provider_id, False, started_at)
        append_security_event(
            db,
            _event(
                user_id, operation_id, SecurityEventOutcome.SUCCESS, "security recovery complete"
            ),
            org_id=org_id,
        )
        db.commit()
    except (
        LocalSecurityRecoveryError,
        InvalidProviderCredentials,
        SupabaseAuthUnavailable,
        SQLAlchemyError,
    ):
        db.rollback()
        try:
            commit_bound_observation(db, user_id, provider_id, None, observation_started_at())
        except SupabaseAuthUnavailable:
            pass
        _failure(
            user_id,
            operation_id,
            "Local security reset committed; recovery is incomplete; rerun recovery",
            local_reset=True,
            factors_cleared=factors_cleared,
            org_id=org_id,
        )
    return RecoveredWorkspaceSecurity(user_id)


def _administrator(
    db: Session, user_id: UUID, organization: UUID | str | None, *, lock: bool
) -> tuple[User, UUID]:
    """The bound administrator and the organization recovery acts in, scoped to it."""
    query = select(User).where(User.id == user_id).execution_options(populate_existing=True)
    if lock:
        query = query.with_for_update(of=User)
    user = db.scalar(query)
    membership = None if user is None else administered_membership(db, user.id, organization)
    if (
        user is None
        or not is_active_account(db, user, now=utc_now())
        or user.status != UserStatus.ACTIVE.value
        or membership is None
        or user.supabase_user_id is None
    ):
        raise LocalSecurityRecoveryError("Target is not an active bound administrator")
    # Recovery writes in that organization, so bind the transaction to it.
    scope_session(db, membership.org_id)
    return user, membership.org_id


def _same_binding(user: User, provider_id: UUID, email: str) -> None:
    if user.supabase_user_id != provider_id or user.email != email:
        raise LocalSecurityRecoveryError("Administrator binding changed during recovery")


def _workspace(db: Session, org_id: UUID) -> WorkspaceProfile:
    profile = db.scalar(
        select(WorkspaceProfile)
        .where(WorkspaceProfile.id == org_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=WorkspaceProfile)
    )
    if profile is None:
        raise LocalSecurityRecoveryError("Workspace profile is unavailable")
    return profile


def _event(
    user_id: UUID, operation_id: UUID, outcome: SecurityEventOutcome, reason: str
) -> SecurityEventIngestRequest:
    return SecurityEventIngestRequest(
        event_type="identity.local_security_recovery",
        outcome=outcome,
        source="identity.security_recovery",
        operation_id=operation_id,
        subject_id=user_id,
        reason=reason,
    )


def _failure(
    user_id: UUID,
    operation_id: UUID,
    message: str,
    *,
    local_reset: bool | None,
    factors_cleared: bool | None,
    org_id: UUID | None,
) -> NoReturn:
    outcome = SecurityEventOutcome.PARTIAL if local_reset is True else SecurityEventOutcome.FAILURE
    try:
        append_committed_security_event(
            _event(user_id, operation_id, outcome, message), org_id=org_id
        )
    except SecurityEventPersistenceError:
        message += "; security event persistence also failed"
    raise LocalSecurityRecoveryError(
        message,
        local_reset_committed=local_reset,
        provider_factors_cleared=factors_cleared,
    ) from None
