"""User account lifecycle routes and Supabase Auth coordination."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.core.database import get_db
from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAdminError
from app.systems.audit.models import SecurityEventOutcome
from app.systems.audit.schemas import SecurityEventIngestRequest
from app.systems.audit.service import SecurityEventPersistenceError, append_committed_security_event
from app.systems.users.coordination import (
    active_admin_count,
    advance_token_cutoff,
    commit,
    conflict,
    ensure_projected_admin_remains,
    forbidden,
    is_active_admin,
    lock_active_role,
    lock_user,
    unavailable,
    user_state,
)
from app.systems.users.eligibility import is_established_user
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.schemas import UserResponse, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


def _require_patch(payload: UserUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


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


def _enable_auth_user(user_id: UUID) -> None:
    try:
        SupabaseAdminClient().enable_user(user_id)
    except SupabaseAdminError as error:
        raise unavailable("Unable to restore user authentication") from error


def _disable_auth_user(user_id: UUID) -> None:
    try:
        SupabaseAdminClient().disable_user(user_id)
    except SupabaseAdminError as error:
        raise unavailable("Unable to disable user authentication") from error


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


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: UUID,
    payload: UserUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    _require_patch(payload)
    admin = require_fresh_exact_admin(db, admin.id)
    actor_id = admin.id
    user = lock_user(db, user_id)
    target_id = user.id
    if user.is_deleted:
        raise conflict("User is deleted")
    if payload.status == UserStatus.DISABLED and user.status == UserStatus.PENDING.value:
        raise conflict("Pending invitations cannot be disabled")
    role_change_requested = payload.role_id is not None and payload.role_id != user.role_id
    requested_role_id = payload.role_id
    destination_role = user.role
    if role_change_requested and requested_role_id is not None:
        destination_role = lock_active_role(db, requested_role_id)
    if destination_role is None:
        raise conflict("User role is not active")
    destination_status = payload.status.value if payload.status is not None else user.status
    if payload.status == UserStatus.ACTIVE and not is_established_user(user):
        raise conflict("Unaccepted invitations require verified acceptance")
    if payload.status is not None or role_change_requested:
        ensure_projected_admin_remains(
            db,
            user,
            destination_role=destination_role,
            destination_status=destination_status,
        )
    if payload.status == UserStatus.ACTIVE:
        return _activate_user(
            db,
            user,
            actor_id=actor_id,
            target_id=target_id,
            payload=payload,
            role_change_requested=role_change_requested,
            requested_role_id=requested_role_id,
        )
    if payload.status == UserStatus.DISABLED:
        return _disable_user(
            db,
            user,
            actor_id=actor_id,
            target_id=target_id,
            payload=payload,
            role_change_requested=role_change_requested,
            destination_role=destination_role,
        )
    if role_change_requested:
        user.role_id = destination_role.id
        user.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    commit(db, "Username unavailable")
    return user


def _activate_user(
    db: Session,
    user: User,
    *,
    actor_id: UUID,
    target_id: UUID,
    payload: UserUpdate,
    role_change_requested: bool,
    requested_role_id: UUID | None,
) -> User:
    operation_id = uuid7()
    initial_state = user_state(user)
    _record_outcome(
        "user.authentication_activation",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    db.rollback()
    try:
        _enable_auth_user(target_id)
    except HTTPException:
        _record_outcome(
            "user.authentication_activation",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "unable to enable user authentication",
        )
        raise
    try:
        require_fresh_exact_admin(db, actor_id)
        finalized_user = lock_user(db, target_id)
        if user_state(finalized_user) != initial_state:
            raise conflict("User changed while authentication was enabled")
        finalized_role = (
            lock_active_role(db, requested_role_id)
            if role_change_requested and requested_role_id is not None
            else finalized_user.role
        )
        if finalized_role is None or finalized_role.is_deleted:
            raise conflict("User role is not active")
        ensure_projected_admin_remains(
            db,
            finalized_user,
            destination_role=finalized_role,
            destination_status=UserStatus.ACTIVE.value,
        )
        if role_change_requested:
            finalized_user.role_id = finalized_role.id
            finalized_user.role = finalized_role
        if payload.username is not None:
            finalized_user.username = payload.username
        finalized_user.status = UserStatus.ACTIVE.value
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
    return finalized_user


def _disable_user(
    db: Session,
    user: User,
    *,
    actor_id: UUID,
    target_id: UUID,
    payload: UserUpdate,
    role_change_requested: bool,
    destination_role: Role,
) -> User:
    operation_id = uuid7()
    _record_outcome(
        "user.authentication_disable",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    if role_change_requested:
        user.role_id = destination_role.id
        user.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    user.status = UserStatus.DISABLED.value
    advance_token_cutoff(user)
    try:
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
    try:
        _disable_auth_user(target_id)
    except HTTPException:
        _record_outcome(
            "user.authentication_disable",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "unable to disable user authentication",
        )
        raise
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
    admin = require_fresh_exact_admin(db, admin.id)
    actor_id = admin.id
    user = lock_user(db, user_id)
    target_id = user.id
    if user.is_deleted:
        raise conflict("User is already deleted")
    if target_id == actor_id:
        raise forbidden("You cannot delete your own account")
    if is_active_admin(user) and active_admin_count(db) <= 1:
        raise conflict("Cannot delete the last active admin")
    operation_id = uuid7()
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    if user.status != UserStatus.PENDING.value:
        user.status = UserStatus.DISABLED.value
    advance_token_cutoff(user)
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
    try:
        _disable_auth_user(target_id)
    except HTTPException:
        _record_outcome(
            "user.authentication_disable",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "unable to disable user authentication",
        )
        raise
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
    restored_role = lock_active_role(db, user.role_id)
    initial_state = user_state(user)
    operation_id = uuid7()
    _record_outcome(
        "user.authentication_restore",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    db.rollback()
    try:
        _enable_auth_user(target_id)
    except HTTPException:
        _record_outcome(
            "user.authentication_restore",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "unable to enable user authentication",
        )
        raise
    try:
        require_fresh_exact_admin(db, actor_id)
        revalidated = lock_user(db, target_id)
        if not revalidated.is_deleted or user_state(revalidated) != initial_state:
            raise conflict("User changed while authentication was enabled")
        restored_role = lock_active_role(db, revalidated.role_id)
        ensure_projected_admin_remains(
            db,
            revalidated,
            destination_role=restored_role,
            destination_status=UserStatus.ACTIVE.value,
        )
        revalidated.role = restored_role
        revalidated.role_id = restored_role.id
        revalidated.is_deleted = False
        revalidated.deleted_at = None
        revalidated.status = UserStatus.ACTIVE.value
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
    return revalidated
