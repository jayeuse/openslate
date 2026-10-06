"""User account lifecycle routes backed by local identity."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.database import get_db
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.policy.access_notifications import (
    AccessSnapshot,
    notify_access_changes,
    snapshot_access,
)
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.coordination import (
    ProfileValidationError,
    advance_token_cutoff,
    commit,
    conflict,
    ensure_projected_admin_remains,
    forbidden,
    lock_user,
    unavailable,
    validate_identity_profile,
)
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.schemas import UserResponse, UserUpdate
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
)
from app.systems.manage.workspace.security_policy import apply_role_mfa_episode

router = APIRouter(prefix="/users", tags=["users"])
AdminUser = Annotated[User, Depends(require_admin)]


def _record_security_event(
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
                source="users.router",
                operation_id=operation_id,
                actor_id=actor_id,
                subject_id=subject_id,
                reason=reason,
            )
        )
    except SecurityEventPersistenceError as error:
        raise unavailable("Unable to record security event") from error


def _record_outcome(
    event_type: str,
    outcome: SecurityEventOutcome,
    operation_id: UUID,
    actor_id: UUID,
    target_id: UUID,
    reason: str | None = None,
) -> None:
    _record_security_event(
        event_type=event_type,
        outcome=outcome,
        operation_id=operation_id,
        actor_id=actor_id,
        subject_id=target_id,
        reason=reason,
    )


def _lock_groups(db: Session, group_ids: set[UUID]) -> dict[UUID, Group]:
    if not group_ids:
        return {}
    rows = db.scalars(
        select(Group)
        .where(Group.id.in_(group_ids))
        .order_by(Group.id)
        .execution_options(populate_existing=True)
        .with_for_update()
    ).all()
    return {row.id: row for row in rows}


def _lock_membership_groups(db: Session, user_id: UUID) -> dict[UUID, Group]:
    """Lock the groups a user belongs to before the user row.

    Every membership writer locks a group row before member and user rows
    (see ``policy/delegation.py``), so a promotion takes the same order.
    """

    try:
        group_ids = set(
            db.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user_id)).all()
        )
        return _lock_groups(db, group_ids)
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to lock group memberships") from error


def _leave_groups(db: Session, user: User, groups: dict[UUID, Group], actor_id: UUID) -> None:
    """Remove every membership of a new administrator; administrators are not group members.

    A membership saved before the user row was locked may name a group that
    is not locked yet; it is locked now. No membership can be added while
    the user row is locked, because adding one locks that row too.
    """

    try:
        memberships = list(
            db.scalars(
                select(GroupMember)
                .where(GroupMember.user_id == user.id)
                .order_by(GroupMember.group_id)
                .with_for_update()
            ).all()
        )
        groups = {
            **groups,
            **_lock_groups(db, {item.group_id for item in memberships} - set(groups)),
        }
        for item in memberships:
            db.delete(item)
            group = groups[item.group_id]
            group.revision += 1
            group.performed_by = actor_id
        db.flush()
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to remove group memberships") from error


def _require_user_patch(payload: UserUpdate) -> None:
    if not payload.model_fields_set:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )
    nullable_profile_fields = {"display_name", "job_title", "expires_at"}
    if any(
        getattr(payload, field) is None
        for field in payload.model_fields_set
        if field not in nullable_profile_fields
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


def _apply_profile_update(
    db: Session,
    user: User,
    payload: UserUpdate,
    *,
    destination_role: str,
) -> None:
    fields = payload.model_fields_set
    if user.role != UserRole.GUEST.value and "sponsor_user_id" in fields:
        raise ProfileValidationError("Only guests can have a sponsor")
    sponsor_user_id = (
        payload.sponsor_user_id if "sponsor_user_id" in fields else user.sponsor_user_id
    )
    expires_at = payload.expires_at if "expires_at" in fields else user.expires_at
    if fields & {"role", "sponsor_user_id", "expires_at"}:
        validate_identity_profile(
            db,
            role=destination_role,
            sponsor_user_id=sponsor_user_id,
            expires_at=expires_at,
        )
    if "display_name" in fields:
        user.display_name = payload.display_name
    if "job_title" in fields:
        user.job_title = payload.job_title
    if "sponsor_user_id" in fields:
        user.sponsor_user_id = sponsor_user_id
    if "expires_at" in fields:
        user.expires_at = expires_at


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: UUID,
    payload: UserUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    _require_user_patch(payload)
    admin = require_fresh_exact_admin(db, admin.id, serialize_admin_changes=True)
    actor_id = admin.id
    membership_groups = (
        _lock_membership_groups(db, user_id) if payload.role == UserRole.ADMIN else {}
    )
    user = lock_user(db, user_id)
    target_id = user.id
    if user.is_deleted:
        raise conflict("User is deleted")
    if payload.status == UserStatus.DISABLED and user.status == UserStatus.PENDING.value:
        raise conflict("Pending invitations cannot be disabled")
    role_change_requested = payload.role is not None and payload.role != user.role
    destination_role = payload.role.value if payload.role is not None else user.role
    if role_change_requested and user.role == UserRole.GUEST.value:
        db.rollback()
        raise conflict("A guest keeps the guest role; invite a member instead")
    destination_status = payload.status.value if payload.status is not None else user.status
    if payload.status == UserStatus.ACTIVE and not is_established_user(user):
        raise conflict("Unaccepted invitations require verified acceptance")
    if (
        payload.status is not None
        or role_change_requested
        or "expires_at" in payload.model_fields_set
    ):
        ensure_projected_admin_remains(
            db,
            user,
            destination_role=destination_role,
            destination_status=destination_status,
            destination_expires_at=(
                payload.expires_at if "expires_at" in payload.model_fields_set else user.expires_at
            ),
            expiry_requested="expires_at" in payload.model_fields_set,
        )
    before = snapshot_access(db, (user,)) if role_change_requested else None
    if role_change_requested:
        apply_role_mfa_episode(db, user, destination_role)
    try:
        _apply_profile_update(db, user, payload, destination_role=destination_role)
    except ProfileValidationError as error:
        db.rollback()
        raise conflict(str(error)) from error
    if role_change_requested and destination_role == UserRole.ADMIN.value:
        _leave_groups(db, user, membership_groups, actor_id)
    if payload.status == UserStatus.ACTIVE:
        return _activate_user(
            db,
            user,
            actor_id=actor_id,
            target_id=target_id,
            payload=payload,
            destination_role=destination_role,
            before=before,
        )
    if payload.status == UserStatus.DISABLED:
        return _disable_user(
            db,
            user,
            actor_id=actor_id,
            target_id=target_id,
            payload=payload,
            destination_role=destination_role,
            before=before,
        )
    user.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    notify_access_changes(db, before)
    commit(db, "Username unavailable")
    return user


def _activate_user(
    db: Session,
    user: User,
    *,
    actor_id: UUID,
    target_id: UUID,
    payload: UserUpdate,
    destination_role: str,
    before: AccessSnapshot | None,
) -> User:
    operation_id = uuid7()
    _record_outcome(
        "user.authentication_activation",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    try:
        ensure_projected_admin_remains(
            db,
            user,
            destination_role=destination_role,
            destination_status=UserStatus.ACTIVE.value,
        )
        user.role = destination_role
        if payload.username is not None:
            user.username = payload.username
        user.status = UserStatus.ACTIVE.value
        notify_access_changes(db, before)
        commit(db, "Username unavailable")
    except HTTPException as error:
        if db.in_transaction():
            db.rollback()
        _record_outcome(
            "user.authentication_activation",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "local activation finalization failed",
        )
        raise error
    _record_outcome(
        "user.authentication_activation",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return user


def _disable_user(
    db: Session,
    user: User,
    *,
    actor_id: UUID,
    target_id: UUID,
    payload: UserUpdate,
    destination_role: str,
    before: AccessSnapshot | None,
) -> User:
    operation_id = uuid7()
    _record_outcome(
        "user.authentication_disable",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    user.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    user.status = UserStatus.DISABLED.value
    advance_token_cutoff(user)
    revoke_user_sessions(db, user.id, except_session_id=None)
    try:
        notify_access_changes(db, before)
        commit(db, "Username unavailable")
    except HTTPException as error:
        _record_outcome(
            "user.authentication_disable",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "local disable finalization failed",
        )
        raise error
    _record_outcome(
        "user.authentication_disable",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    admin = require_fresh_exact_admin(db, admin.id, serialize_admin_changes=True)
    actor_id = admin.id
    user = lock_user(db, user_id)
    target_id = user.id
    if user.is_deleted:
        raise conflict("User is already deleted")
    if target_id == actor_id:
        raise forbidden("You cannot delete your own account")
    ensure_projected_admin_remains(
        db,
        user,
        destination_role=user.role,
        destination_status=user.status,
        destination_deleted=True,
    )
    operation_id = uuid7()
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    if user.status != UserStatus.PENDING.value:
        user.status = UserStatus.DISABLED.value
    advance_token_cutoff(user)
    revoke_user_sessions(db, user.id, except_session_id=None)
    _record_outcome(
        "user.authentication_disable",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    try:
        commit(db, "Unable to delete user")
    except HTTPException as error:
        _record_outcome(
            "user.authentication_disable",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "local delete finalization failed",
        )
        raise error
    _record_outcome(
        "user.authentication_disable",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{user_id}/restore", response_model=UserResponse)
def restore_user(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    admin = require_fresh_exact_admin(db, admin.id)
    actor_id = admin.id
    user = lock_user(db, user_id)
    target_id = user.id
    if not user.is_deleted:
        raise conflict("User is not deleted")
    if not is_established_user(user):
        raise conflict("Unaccepted invitations cannot be restored")
    operation_id = uuid7()
    _record_outcome(
        "user.authentication_restore",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    try:
        ensure_projected_admin_remains(
            db,
            user,
            destination_role=user.role,
            destination_status=UserStatus.ACTIVE.value,
        )
        user.is_deleted = False
        user.deleted_at = None
        user.status = UserStatus.ACTIVE.value
        commit(db, "Unable to restore user")
    except HTTPException as error:
        if db.in_transaction():
            db.rollback()
        _record_outcome(
            "user.authentication_restore",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "local restore finalization failed",
        )
        raise error
    _record_outcome(
        "user.authentication_restore",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return user
