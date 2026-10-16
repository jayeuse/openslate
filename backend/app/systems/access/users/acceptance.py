"""Verified invitation acceptance coordination."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.normalization import normalize_email
from app.core.base_model import utc_now
from app.core.database.organization_scope import scope_session
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.access.users.service import (
    _lock_administrator_changes,
    _lock_profile,
    _security_event,
)
from app.systems.manage.audit.models import SecurityEvent, SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.security_policy import accepted_mfa_episode
from app.systems.platform.scheduling.notification_creation import notify_invitation_accepted


def begin_invitation_acceptance(user_id: UUID | None) -> UUID:
    """Record an invitation-acceptance attempt before its request transaction."""

    operation_id = uuid7()
    _security_event(
        event_type="user.invitation_acceptance",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=user_id,
        subject_id=user_id,
    )
    return operation_id


def record_invitation_acceptance_failure(
    operation_id: UUID, user_id: UUID | None, reason: str
) -> None:
    """Record a safe outcome after the request transaction has rolled back."""

    _security_event(
        event_type="user.invitation_acceptance",
        outcome=SecurityEventOutcome.FAILURE,
        operation_id=operation_id,
        actor_id=user_id,
        subject_id=user_id,
        reason=reason,
    )


def append_invitation_acceptance_success(
    db: Session, operation_id: UUID, user_id: UUID | None
) -> None:
    """Append success to the activation transaction so it cannot be lost separately."""

    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type="user.invitation_acceptance",
            outcome=SecurityEventOutcome.SUCCESS,
            source="users.service",
            operation_id=operation_id,
            actor_id=user_id,
            subject_id=user_id,
        ),
    )


def accept_verified_invitation(
    db: Session,
    user_id: UUID,
    *,
    verified_email: str,
    verified_identity: UUID,
) -> User:
    """Finalize a pending invitation after local identity verification."""

    operation_id = begin_invitation_acceptance(user_id)
    if verified_identity != user_id:
        db.rollback()
        record_invitation_acceptance_failure(
            operation_id, user_id, "verified identity does not match profile"
        )
        raise InvitationError("Verified identity does not match invitation")
    try:
        email = normalize_email(verified_email)
    except ValueError as error:
        db.rollback()
        record_invitation_acceptance_failure(operation_id, user_id, "verified email is invalid")
        raise InvitationError("Verified email does not match invitation") from error
    try:
        _lock_administrator_changes(db)
        profile = _lock_profile(db, user_id)
    except InvitationError as error:
        db.rollback()
        record_invitation_acceptance_failure(
            operation_id, user_id, "unable to lock invitation profile"
        )
        raise error
    if profile is None or profile.email != email or profile.is_deleted:
        db.rollback()
        record_invitation_acceptance_failure(
            operation_id, user_id, "verified email does not match invitation"
        )
        raise InvitationError("Verified email does not match invitation")
    memberships = db.scalars(select(Membership).where(
        Membership.user_id == user_id, Membership.status == "pending",
        Membership.is_deleted.is_(False),
    ).with_for_update()).all() if profile.status == "pending" else [
        sole_active_membership(db, user_id)
    ]
    if len(memberships) != 1:
        db.rollback()
        raise InvitationError("Invitation is not pending")
    membership = memberships[0]
    # Acceptance is anonymous; the invited membership names the organization it writes in.
    scope_session(db, membership.org_id)
    if profile.status == UserStatus.ACTIVE.value and membership.invitation_accepted_at is not None:
        db.rollback()
        _security_event(
            event_type="user.invitation_acceptance",
            outcome=SecurityEventOutcome.SUCCESS,
            operation_id=operation_id,
            actor_id=user_id,
            subject_id=user_id,
        )
        return profile
    if profile.status != UserStatus.PENDING.value or membership.invitation_sent_at is None:
        db.rollback()
        record_invitation_acceptance_failure(operation_id, user_id, "invitation is not pending")
        raise InvitationError("Invitation is not pending")
    profile.status = UserStatus.ACTIVE.value
    membership.status = UserStatus.ACTIVE.value
    membership.invitation_accepted_at = utc_now()
    accepted_mfa_episode(db, membership, membership.invitation_accepted_at)
    try:
        inviter_id = (
            db.scalar(
                select(SecurityEvent.actor_id)
                .where(
                    SecurityEvent.event_type == "user.invitation",
                    SecurityEvent.outcome == SecurityEventOutcome.SUCCESS,
                    SecurityEvent.source == "users.service",
                    SecurityEvent.subject_id == profile.id,
                    SecurityEvent.operation_id == membership.provider_invitation_operation_id,
                )
                .order_by(SecurityEvent.occurred_at, SecurityEvent.id)
                .limit(1)
            )
            if membership.provider_invitation_operation_id is not None
            else None
        )
        notify_invitation_accepted(db, profile, inviter_id)
        append_invitation_acceptance_success(db, operation_id, user_id)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        record_invitation_acceptance_failure(
            operation_id, user_id, "unable to finalize invitation acceptance"
        )
        raise
    return profile
