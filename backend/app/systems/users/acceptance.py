"""Verified invitation acceptance coordination."""

from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.normalization import normalize_email
from app.core.base_model import utc_now
from app.systems.audit.models import SecurityEventOutcome
from app.systems.users.models import User, UserStatus
from app.systems.users.service import (
    InvitationError,
    _lock_admin_role,
    _lock_profile,
    _lock_role_any_state,
    _security_event,
)


def accept_verified_invitation(
    db: Session,
    user_id: UUID,
    *,
    verified_email: str,
    verified_identity: UUID,
) -> User:
    """Finalize a pending invitation after Supabase verifies its identity."""

    operation_id = uuid7()
    _security_event(
        event_type="user.invitation_acceptance",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=user_id,
        subject_id=user_id,
    )
    if verified_identity != user_id:
        db.rollback()
        _failure(db, operation_id, user_id, "verified identity does not match profile")
        raise InvitationError("Verified identity does not match invitation")
    try:
        email = normalize_email(verified_email)
    except ValueError as error:
        db.rollback()
        _failure(db, operation_id, user_id, "verified email is invalid")
        raise InvitationError("Verified email does not match invitation") from error
    try:
        _lock_admin_role(db)
        profile = _lock_profile(db, user_id)
    except InvitationError as error:
        db.rollback()
        _failure(db, operation_id, user_id, "unable to lock invitation profile")
        raise error
    if profile is None or profile.email != email or profile.is_deleted:
        db.rollback()
        _failure(db, operation_id, user_id, "verified email does not match invitation")
        raise InvitationError("Verified email does not match invitation")
    try:
        assigned_role = _lock_role_any_state(db, profile.role_id)
    except InvitationError as error:
        db.rollback()
        _failure(db, operation_id, user_id, "unable to lock invitation role")
        raise error
    if assigned_role is None or assigned_role.is_deleted:
        db.rollback()
        _failure(db, operation_id, user_id, "invitation role is not active")
        raise InvitationError("Invitation role is not active")
    profile.role = assigned_role
    if profile.status == UserStatus.ACTIVE.value and profile.invitation_accepted_at is not None:
        db.rollback()
        _success(operation_id, user_id)
        return profile
    if (
        profile.status != UserStatus.PENDING.value
        or profile.invitation_sent_at is None
        or profile.role is None
        or profile.role.is_deleted
    ):
        db.rollback()
        _failure(db, operation_id, user_id, "invitation is not pending")
        raise InvitationError("Invitation is not pending")
    profile.status = UserStatus.ACTIVE.value
    profile.invitation_accepted_at = utc_now()
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        _failure(db, operation_id, user_id, "unable to finalize invitation acceptance")
        raise InvitationError("Unable to finalize invitation acceptance") from error
    _success(operation_id, user_id)
    return profile


def _failure(db: Session, operation_id: UUID, user_id: UUID, reason: str) -> None:
    del db
    _security_event(
        event_type="user.invitation_acceptance",
        outcome=SecurityEventOutcome.FAILURE,
        operation_id=operation_id,
        actor_id=user_id,
        subject_id=user_id,
        reason=reason,
    )


def _success(operation_id: UUID, user_id: UUID) -> None:
    _security_event(
        event_type="user.invitation_acceptance",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=user_id,
        subject_id=user_id,
    )
