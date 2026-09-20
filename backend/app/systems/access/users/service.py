"""Local user invitations coordinated with the Identity capability."""

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin
from app.core.base_model import utc_now
from app.core.security.passwords import PasswordPolicyError
from app.systems.access.identity.delivery import queue_action_delivery
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.identity.service import (
    create_credential,
    generated_temporary_password,
    issue_action_token,
    replace_password,
)
from app.systems.access.users.models import Role, User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
    append_security_event,
)
from app.systems.platform.notifications.outbox import smtp_delivery_enabled


class InvitationError(RuntimeError):
    """A safe invitation lifecycle error."""


class InvitationConflict(InvitationError):
    """An invitation conflicts with a local identity."""


@dataclass(frozen=True, slots=True)
class IssuedInvitation:
    user: User
    delivery: str
    temporary_password: str | None


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


def _record_invitation_failure(operation_id: UUID, actor_id: UUID | None) -> None:
    """Record a secondary failure event without replacing the primary safe error."""

    try:
        _security_event(
            event_type="user.invitation",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
        )
    except InvitationError:
        pass


def _lock_role(db: Session, role_id: UUID) -> Role:
    role = db.scalar(
        select(Role).where(Role.id == role_id, Role.is_deleted.is_(False)).with_for_update()
    )
    if not isinstance(role, Role):
        raise InvitationError("Role is not active")
    return role


def _lock_role_any_state(db: Session, role_id: UUID) -> Role | None:
    role = db.scalar(select(Role).where(Role.id == role_id).with_for_update())
    if role is not None and not isinstance(role, Role):
        raise InvitationError("Unable to lock invitation role")
    return role


def _member_role(db: Session) -> Role:
    role = db.scalar(
        select(Role)
        .where(Role.role == UserRole.MEMBER, Role.is_deleted.is_(False))
        .with_for_update()
    )
    if not isinstance(role, Role):
        raise InvitationError("Default member role is not configured")
    return role


def _lock_admin_role(db: Session) -> Role:
    role = db.scalar(
        select(Role)
        .where(Role.role == UserRole.ADMIN, Role.is_deleted.is_(False))
        .with_for_update()
    )
    if not isinstance(role, Role):
        raise InvitationError("Unable to lock administrator membership")
    return role


def _lock_profile(db: Session, user_id: UUID) -> User | None:
    profile = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == user_id)
        .with_for_update(of=User)
    )
    if profile is not None and not isinstance(profile, User):
        raise InvitationError("Unable to lock invitation profile")
    return profile


def _other_non_deleted_assignment_exists(
    db: Session, role_id: UUID, excluded_user_id: UUID
) -> bool:
    return bool(
        db.scalar(
            select(func.count())
            .select_from(User)
            .where(
                User.role_id == role_id,
                User.id != excluded_user_id,
                User.is_deleted.is_(False),
            )
        )
    )


def _profile_state(profile: User) -> tuple[UUID, str, str, UUID, str, bool, datetime | None]:
    return (
        profile.id,
        profile.email,
        profile.username,
        profile.role_id,
        profile.status,
        profile.is_deleted,
        profile.tokens_valid_after,
    )


def _role_state(role: Role) -> tuple[UUID, str, bool, datetime | None, dict[str, Any]]:
    return (role.id, role.role, role.is_deleted, role.deleted_at, dict(role.permissions))


def invite_user(
    db: Session,
    payload: InvitationCreate,
    *,
    actor_id: UUID | None = None,
    bootstrap: bool = False,
    temporary_password: str | None = None,
    delivery: str = "temporary_password",
) -> User:
    """Create a pending local user with a one-time credential and invite token."""

    if (actor_id is None) != bootstrap:
        raise InvitationError("Invitation actor is required outside bootstrap")
    operation_id = uuid7()
    if delivery == "email" and not smtp_delivery_enabled():
        raise InvitationError("Email delivery is unavailable")
    try:
        if actor_id is not None:
            require_fresh_exact_admin(db, actor_id)
        role = _member_role(db) if payload.role_id is None else _lock_role(db, payload.role_id)
        existing = db.scalar(
            select(User)
            .where(or_(User.email == payload.email, User.username == payload.username))
            .with_for_update(of=User)
        )
        if existing is not None:
            raise InvitationConflict("Email or username is already in use")
        if (
            bootstrap
            and role.role == UserRole.ADMIN
            and _other_non_deleted_assignment_exists(db, role.id, UUID(int=0))
        ):
            raise InvitationError("An administrator reservation already exists")
        user = User(
            email=payload.email,
            username=payload.username,
            role_id=role.id,
            role=role,
            status=UserStatus.PENDING.value,
            invitation_sent_at=utc_now(),
        )
        db.add(user)
        db.flush()
        initial_password = temporary_password or generated_temporary_password()
        create_credential(
            db,
            user.id,
            initial_password,
            temporary=True,
        )
        if delivery == "email":
            raw_token = issue_action_token(
                db, user.id, ActionTokenPurpose.INVITATION, created_by=actor_id
            )
            queue_action_delivery(db, user.id, ActionTokenPurpose.INVITATION, raw_token)
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=user.id,
            ),
        )
        db.commit()
    except (InvitationError, PasswordPolicyError) as error:
        db.rollback()
        _record_invitation_failure(operation_id, actor_id)
        if isinstance(error, PasswordPolicyError):
            raise InvitationError("Temporary password does not meet policy") from error
        raise
    except (IntegrityError, SQLAlchemyError) as error:
        db.rollback()
        _record_invitation_failure(operation_id, actor_id)
        raise InvitationConflict("Email or username is already in use") from error
    return user


def create_invitation(
    db: Session,
    payload: InvitationCreate,
    *,
    actor_id: UUID,
) -> IssuedInvitation:
    """Create an invitation and return plaintext only when it was generated for display."""

    generated = (
        generated_temporary_password()
        if payload.delivery == "temporary_password" and payload.temporary_password is None
        else None
    )
    user = invite_user(
        db,
        payload,
        actor_id=actor_id,
        temporary_password=payload.temporary_password or generated,
        delivery=payload.delivery,
    )
    return IssuedInvitation(user, payload.delivery, generated)


def resend_invitation(db: Session, user_id: UUID, *, actor_id: UUID) -> User:
    """Invalidate a prior setup link and issue a local replacement."""

    operation_id = uuid7()
    try:
        require_fresh_exact_admin(db, actor_id)
        profile = _lock_profile(db, user_id)
        if profile is None or profile.is_deleted or profile.status != UserStatus.PENDING.value:
            raise InvitationError("Invitation is not pending")
        profile.invitation_sent_at = utc_now()
        issue_action_token(db, profile.id, ActionTokenPurpose.INVITATION, created_by=actor_id)
        db.commit()
    except (InvitationError, HTTPException, SQLAlchemyError) as error:
        db.rollback()
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
        )
        if isinstance(error, InvitationError):
            raise
        raise InvitationError("Unable to resend invitation") from error
    _security_event(
        event_type="user.invitation_resend",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=user_id,
    )
    return profile


def resend_invitation_delivery(
    db: Session,
    user_id: UUID,
    *,
    actor_id: UUID,
    delivery: str,
    temporary_password: str | None,
) -> IssuedInvitation:
    """Rotate either the local setup secret or the single-use email action token."""

    operation_id = uuid7()
    _security_event(
        event_type="user.invitation_resend",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=user_id,
    )
    try:
        if delivery == "email" and not smtp_delivery_enabled():
            raise InvitationError("Email delivery is unavailable")
        require_fresh_exact_admin(db, actor_id)
        profile = _lock_profile(db, user_id)
        if profile is None or profile.is_deleted or profile.status != UserStatus.PENDING.value:
            raise InvitationError("Invitation is not pending")
        generated = (
            generated_temporary_password()
            if delivery == "temporary_password" and temporary_password is None
            else None
        )
        replacement = (
            generated_temporary_password()
            if delivery == "email"
            else temporary_password or generated
        )
        replace_password(db, profile, replacement or "", temporary=True)
        if delivery == "email":
            raw_token = issue_action_token(
                db, profile.id, ActionTokenPurpose.INVITATION, created_by=actor_id
            )
            queue_action_delivery(db, profile.id, ActionTokenPurpose.INVITATION, raw_token)
        profile.invitation_sent_at = utc_now()
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation_resend",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=profile.id,
            ),
        )
        db.commit()
    except PasswordPolicyError as error:
        db.rollback()
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
            reason="local invitation resend failed",
        )
        raise InvitationError("Temporary password does not meet policy") from error
    except HTTPException:
        db.rollback()
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
            reason="fresh invitation authorization failed",
        )
        raise
    except (InvitationError, SQLAlchemyError) as error:
        db.rollback()
        _security_event(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=actor_id,
            subject_id=user_id,
            reason="local invitation resend failed",
        )
        raise InvitationError("Unable to resend invitation") from error
    return IssuedInvitation(profile, delivery, generated)
