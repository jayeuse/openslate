from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin
from app.common.normalization import normalize_email
from app.core.base_model import utc_now
from app.core.integrations.supabase import (
    SupabaseAdminClient,
    SupabaseAdminError,
)
from app.systems.audit.models import SecurityEventOutcome
from app.systems.audit.schemas import SecurityEventIngestRequest
from app.systems.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus


class InvitationError(RuntimeError):
    """A safe invitation lifecycle error."""


class InvitationConflict(InvitationError):
    """An invitation conflicts with an existing local identity."""


def _security_event(
    *,
    event_type: str,
    outcome: SecurityEventOutcome,
    operation_id: UUID,
    actor_id: UUID | None = None,
    subject_id: UUID | None = None,
    reason: str | None = None,
) -> None:
    try:
        append_committed_security_event(
            SecurityEventIngestRequest(
                event_type=event_type,
                outcome=outcome,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=subject_id,
                reason=reason,
            )
        )
    except SecurityEventPersistenceError as error:
        raise InvitationError("Unable to record security event") from error


def _member_role(db: Session) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.role == UserRole.MEMBER, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to lock default member role") from error
    if role is None:
        db.rollback()
        raise InvitationError("Default member role is not configured")
    if not isinstance(role, Role):
        db.rollback()
        raise InvitationError("Unable to lock default member role")
    return role


def _lock_role(db: Session, role_id: UUID) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to lock invitation role") from error
    if role is None:
        db.rollback()
        raise InvitationError("Role is not active")
    if not isinstance(role, Role):
        db.rollback()
        raise InvitationError("Unable to lock invitation role")
    return role


def _lock_role_any_state(db: Session, role_id: UUID) -> Role | None:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to lock invitation role") from error
    if role is not None and not isinstance(role, Role):
        db.rollback()
        raise InvitationError("Unable to lock invitation role")
    return role


def _lock_admin_role(db: Session) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.role == UserRole.ADMIN, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to lock administrator membership") from error
    if not isinstance(role, Role):
        db.rollback()
        raise InvitationError("Unable to lock administrator membership")
    return role


def _other_non_deleted_assignment_exists(
    db: Session,
    role_id: UUID,
    excluded_user_id: UUID,
) -> bool:
    try:
        count = db.scalar(
            select(func.count())
            .select_from(User)
            .where(
                User.role_id == role_id,
                User.id != excluded_user_id,
                User.is_deleted.is_(False),
            )
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to inspect administrator membership") from error
    return bool(count)


def _lock_profile(db: Session, user_id: UUID) -> User | None:
    try:
        profile = db.scalar(
            select(User)
            .options(joinedload(User.role))
            .where(User.id == user_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to lock invitation profile") from error
    if profile is not None and not isinstance(profile, User):
        db.rollback()
        raise InvitationError("Unable to lock invitation profile")
    return profile


def _profile_state(
    profile: User,
) -> tuple[
    UUID,
    str,
    str,
    UUID,
    str,
    bool,
    datetime | None,
    datetime | None,
    datetime | None,
    datetime | None,
]:
    return (
        profile.id,
        profile.email,
        profile.username,
        profile.role_id,
        profile.status,
        profile.is_deleted,
        profile.deleted_at,
        profile.invitation_sent_at,
        profile.invitation_accepted_at,
        profile.tokens_valid_after,
    )


def _role_state(role: Role) -> tuple[UUID, str, bool, datetime | None, dict[str, Any]]:
    return (role.id, role.role, role.is_deleted, role.deleted_at, dict(role.permissions))


def invite_user(
    db: Session,
    payload: InvitationCreate,
    *,
    client: SupabaseAdminClient | None = None,
    actor_id: UUID | None = None,
    bootstrap: bool = False,
) -> User:
    """Invite an Auth user, then finalize its trigger-created local profile.

    Only the explicit bootstrap call may omit an application actor.  All
    request-facing callers must provide the freshly authorized administrator.
    """

    if (actor_id is None) != bootstrap:
        raise InvitationError("Invitation actor is required outside bootstrap")
    operation_id = uuid7()
    if actor_id is not None:
        require_fresh_exact_admin(db, actor_id)
    if payload.role_id is None:
        member_role = _member_role(db)
        role = member_role
    else:
        role = _lock_role(db, payload.role_id)
        member_role = role if role.role == UserRole.MEMBER else _member_role(db)
    expected_member_role_state = _role_state(member_role)
    expected_role_state = _role_state(role)
    try:
        existing_profile = db.scalar(
            select(User)
            .where(or_(User.email == payload.email, User.username == payload.username))
            .execution_options(populate_existing=True)
            .with_for_update(of=User)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise InvitationError("Unable to inspect invitation profile") from error
    if existing_profile is not None and not isinstance(existing_profile, User):
        db.rollback()
        raise InvitationError("Unable to inspect invitation profile")
    existing_profile_id = existing_profile.id if existing_profile is not None else None

    # No request transaction or row lock may survive into Auth HTTP.
    db.rollback()
    _security_event(
        event_type="user.invitation",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=existing_profile_id,
    )
    if existing_profile is not None:
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=existing_profile_id,
            reason="email or username is already in use",
        )
        raise InvitationConflict("Email or username is already in use")

    try:
        auth_client = client or SupabaseAdminClient()
        auth_user = auth_client.invite_user(payload.email, payload.username)
    except SupabaseAdminError as error:
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            reason="unable to send invitation",
        )
        if error.status_code in {409, 422}:
            raise InvitationConflict("Email is already in use") from error
        raise InvitationError("Unable to send invitation") from error

    try:
        if actor_id is not None:
            require_fresh_exact_admin(db, actor_id)
        current_member_role = _member_role(db)
        if _role_state(current_member_role) != expected_member_role_state:
            raise InvitationError("Default member role changed before invitation finalization")
        if role.id == current_member_role.id:
            current_role = current_member_role
        elif bootstrap and role.role == UserRole.ADMIN:
            current_role = _lock_admin_role(db)
        else:
            current_role = _lock_role(db, role.id)
        if _role_state(current_role) != expected_role_state:
            raise InvitationError("Invitation role changed before finalization")
        if bootstrap and current_role.role == UserRole.ADMIN:
            if _other_non_deleted_assignment_exists(db, current_role.id, auth_user.id):
                raise InvitationError("An administrator reservation already exists")
        profile = _lock_profile(db, auth_user.id)
        if profile is None:
            raise InvitationError("Unable to finalize invitation")
        expected_profile_state = (
            auth_user.id,
            normalize_email(auth_user.email),
            f"auth_{auth_user.id.hex}",
            member_role.id,
            UserStatus.PENDING.value,
            False,
            None,
            None,
            None,
            None,
        )
        if _profile_state(profile) != expected_profile_state:
            raise InvitationError("Invitation profile changed before finalization")
        profile.email = payload.email
        profile.username = payload.username
        profile.role_id = current_role.id
        profile.role = current_role
        profile.status = UserStatus.PENDING.value
        profile.invitation_sent_at = utc_now()
        profile.invitation_accepted_at = None
        profile.is_deleted = False
        profile.deleted_at = None
        db.commit()
    except HTTPException:
        db.rollback()
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=auth_user.id,
            reason="invitation local finalization failed",
        )
        raise
    except IntegrityError as error:
        db.rollback()
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=auth_user.id,
            reason="invitation local finalization failed",
        )
        raise InvitationConflict("Email or username is already in use") from error
    except SQLAlchemyError as error:
        db.rollback()
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=auth_user.id,
            reason="invitation local finalization failed",
        )
        raise InvitationError("Unable to finalize invitation") from error
    except InvitationError as error:
        db.rollback()
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=auth_user.id,
            reason="invitation local finalization failed",
        )
        raise error
    _security_event(
        event_type="user.invitation",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=auth_user.id,
    )
    return profile


def resend_invitation(
    db: Session,
    user_id: UUID,
    *,
    actor_id: UUID,
    client: SupabaseAdminClient | None = None,
) -> User:
    """Resend a pending invitation without deleting its Auth identity."""

    operation_id = uuid7()
    require_fresh_exact_admin(db, actor_id)
    profile = _lock_profile(db, user_id)
    if (
        profile is None
        or profile.is_deleted
        or profile.status != UserStatus.PENDING.value
        or profile.invitation_sent_at is None
        or profile.role is None
        or profile.role.is_deleted
    ):
        db.rollback()
        raise InvitationError("Invitation is not pending")
    initial_role = _lock_role(db, profile.role_id)
    initial_state = (_profile_state(profile), _role_state(initial_role))
    email = profile.email
    db.rollback()
    _security_event(
        event_type="user.invitation_resend",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=user_id,
    )
    try:
        auth_client = client or SupabaseAdminClient()
        auth_client.resend_invitation(email)
    except SupabaseAdminError as error:
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
            reason="unable to resend invitation",
        )
        raise InvitationError("Unable to resend invitation") from error

    try:
        require_fresh_exact_admin(db, actor_id)
        finalized = _lock_profile(db, user_id)
        if finalized is None:
            raise InvitationError("Invitation changed while it was resent")
        finalized_role = _lock_role(db, finalized.role_id)
        finalized_state = (_profile_state(finalized), _role_state(finalized_role))
        if finalized_state != initial_state:
            raise InvitationError("Invitation changed while it was resent")
        finalized.role = finalized_role
        finalized.invitation_sent_at = utc_now()
        db.commit()
    except HTTPException:
        db.rollback()
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
            reason="invitation resend local finalization failed",
        )
        raise
    except (InvitationError, IntegrityError, SQLAlchemyError) as error:
        db.rollback()
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
            reason="invitation resend local finalization failed",
        )
        if isinstance(error, InvitationError):
            raise error
        raise InvitationError("Unable to finalize invitation resend") from error
    _security_event(
        event_type="user.invitation_resend",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=user_id,
    )
    return finalized
