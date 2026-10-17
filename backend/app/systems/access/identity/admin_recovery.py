"""Guarded provider recovery for an active OpenSlate administrator."""

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import ColumnElement, or_, select
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
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
    append_security_event,
)
from app.systems.manage.workspace.models import WorkspaceProfile


class LocalRecoveryError(RuntimeError):
    """A safe failure for local administrator recovery."""


class OrganizationChoiceRequired(LocalRecoveryError):
    """The person administers several organizations and the console named none."""

    def __init__(self, slugs: Sequence[str]) -> None:
        super().__init__("Choose the organization with --organization")
        self.slugs = tuple(slugs)


def administered_membership(
    db: Session, user_id: UUID, organization: UUID | str | None = None
) -> Membership | None:
    """The person's active administrator membership that local recovery acts in.

    ``organization`` is an organization id or slug. Without it, the one organization the
    person administers is used; several raise ``OrganizationChoiceRequired``. ``None``
    means the person is not an active administrator there.
    """
    now = utc_now()
    query = (
        select(Membership)
        .join(WorkspaceProfile, WorkspaceProfile.id == Membership.org_id)
        .where(
            Membership.user_id == user_id, Membership.role == UserRole.ADMIN.value,
            Membership.status == UserStatus.ACTIVE.value, Membership.is_deleted.is_(False),
            or_(Membership.expires_at.is_(None), Membership.expires_at > now),
        )
        .order_by(WorkspaceProfile.slug)
    )
    if organization is not None:
        query = query.where(_organization_named(organization))
    memberships = db.scalars(query).all()
    if len(memberships) > 1:
        raise OrganizationChoiceRequired(
            db.scalars(
                select(WorkspaceProfile.slug)
                .where(WorkspaceProfile.id.in_([row.org_id for row in memberships]))
                .order_by(WorkspaceProfile.slug)
            ).all()
        )
    if not memberships:
        return None
    membership = memberships[0]
    if membership.role != UserRole.ADMIN.value or (
        membership.expires_at is not None and membership.expires_at <= now
    ):
        return None
    return membership


def _organization_named(organization: UUID | str) -> ColumnElement[bool]:
    if isinstance(organization, UUID):
        return WorkspaceProfile.id == organization
    try:
        return WorkspaceProfile.id == UUID(organization)
    except ValueError:
        return WorkspaceProfile.slug == organization


@dataclass(frozen=True, slots=True)
class RecoveredAdmin:
    user_id: UUID


def recover_local_admin(
    db: Session,
    user_id: UUID,
    *,
    local_invocation: bool,
    elevated: bool,
    organization: UUID | str | None = None,
) -> RecoveredAdmin:
    """Revoke app sessions, then email recovery through the bound provider account.

    The person must be an active administrator of ``organization`` (an id or slug), or
    of the one organization they administer when it is omitted.
    """

    if not local_invocation or not elevated:
        raise LocalRecoveryError("Local elevated administrator recovery is required")
    timestamp = utc_now()
    user = db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update(of=User)
    )
    try:
        membership = (
            None if user is None else administered_membership(db, user.id, organization)
        )
    except OrganizationChoiceRequired:
        db.rollback()
        raise
    if (
        user is None
        or not is_active_account(db, user, now=timestamp)
        or user.status != UserStatus.ACTIVE.value
        or membership is None
        or user.supabase_user_id is None
    ):
        db.rollback()
        raise LocalRecoveryError("Target is not an active administrator")
    org_id = membership.org_id
    # Recovery writes in that organization, so bind the transaction to it.
    scope_session(db, org_id)
    provider = get_supabase_auth_client()
    try:
        provider_user = provider.get_admin_user(user.supabase_user_id)
        if (
            provider_user.id != user.supabase_user_id
            or provider_user.email != user.email
            or not provider_user.is_eligible(now=timestamp)
        ):
            raise LocalRecoveryError("Provider administrator does not match")
        revoke_user_sessions(db, user.id, except_session_id=None, now=timestamp)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="identity.local_admin_recovery",
                outcome=SecurityEventOutcome.ATTEMPT,
                source="identity.admin_recovery",
                operation_id=uuid7(),
                subject_id=user.id,
                reason="local elevated recovery",
            ),
            org_id=org_id,
        )
        db.commit()
    except (InvalidProviderCredentials, SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise LocalRecoveryError("Administrator recovery failed") from error
    except LocalRecoveryError:
        db.rollback()
        raise
    try:
        provider.request_recovery(user.email)
        append_committed_security_event(
            SecurityEventIngestRequest(
                event_type="identity.local_admin_recovery",
                outcome=SecurityEventOutcome.SUCCESS,
                source="identity.admin_recovery",
                operation_id=uuid7(),
                subject_id=user.id,
                reason="provider recovery email requested",
            ),
            org_id=org_id,
        )
    except (SupabaseAuthUnavailable, SecurityEventPersistenceError) as error:
        raise LocalRecoveryError("Administrator recovery failed") from error
    return RecoveredAdmin(user.id)
