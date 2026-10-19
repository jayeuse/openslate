"""User account lifecycle routes backed by local identity."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.database import get_db
from app.core.database.organization_scope import session_organization
from app.systems.access.identity.session_revocation import revoke_user_sessions
from app.systems.access.policy.access_notifications import (
    AccessSnapshot,
    notify_access_changes,
    snapshot_access,
)
from app.systems.access.users.coordination import (
    ProfileValidationError,
    advance_token_cutoff,
    apply_profile_update,
    commit,
    conflict,
    ensure_projected_admin_remains,
    forbidden,
    leave_groups,
    lock_membership_groups,
    lock_user,
    not_found,
    organization_member,
    protect_owners,
    refuse_account_details,
    require_user_patch,
    shares_another_organization,
    unavailable,
)
from app.systems.access.users.directory import directory_membership, membership_view
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.membership import is_platform_operator
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.access.users.schemas import UserResponse, UserUpdate
from app.systems.comms.realtime.grants import lock_projection, revoke_stale
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
    org_id: UUID | None = None,
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
            ),
            org_id=org_id,
        )
    except SecurityEventPersistenceError as error:
        raise unavailable("Unable to record security event") from error


def _record_outcome(
    db: Session,
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
        org_id=session_organization(db),
    )


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: UUID,
    payload: UserUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    require_user_patch(payload)
    lock_projection(db)
    admin = require_fresh_exact_admin(db, admin.id, serialize_admin_changes=True)
    actor_id = admin.id
    membership_groups = (
        lock_membership_groups(db, user_id) if payload.role == UserRole.ADMIN else {}
    )
    user = lock_user(db, user_id)
    membership = organization_member(db, user)
    if payload.status == UserStatus.DISABLED or (
        payload.role is not None
        and payload.role != UserRole.ADMIN
        and membership.role == UserRole.ADMIN.value
    ):
        protect_owners(db, user)
    if shares_another_organization(db, user) and not is_platform_operator(db, actor_id):
        if payload.model_fields_set & {"username", "display_name", "job_title"}:
            refuse_account_details(db)
        if payload.status is not None:
            return _change_membership_status(db, user, membership, payload, actor_id)
    target_id = user.id
    if user.is_deleted:
        raise conflict("User is deleted")
    if payload.status == UserStatus.DISABLED and user.status == UserStatus.PENDING.value:
        raise conflict("Pending invitations cannot be disabled")
    role_change_requested = payload.role is not None and payload.role != membership.role
    destination_role = payload.role.value if payload.role is not None else membership.role
    if role_change_requested and membership.role == UserRole.GUEST.value:
        db.rollback()
        raise conflict("A guest keeps the guest role; invite a member instead")
    destination_status = payload.status.value if payload.status is not None else user.status
    if payload.status == UserStatus.ACTIVE and not is_established_user(membership):
        raise conflict("Unaccepted invitations require verified acceptance")
    if (
        payload.status is not None
        or role_change_requested
        or "expires_at" in payload.model_fields_set
    ):
        ensure_projected_admin_remains(
            db,
            user,
            membership,
            destination_role=destination_role,
            destination_status=destination_status,
            destination_expires_at=(
                payload.expires_at
                if "expires_at" in payload.model_fields_set
                else membership.expires_at
            ),
            expiry_requested="expires_at" in payload.model_fields_set,
        )
    before = snapshot_access(db, (user,)) if role_change_requested else None
    if role_change_requested:
        apply_role_mfa_episode(db, membership, destination_role)
    try:
        apply_profile_update(db, user, membership, payload, destination_role=destination_role)
    except ProfileValidationError as error:
        db.rollback()
        raise conflict(str(error)) from error
    user.performed_by = actor_id
    if role_change_requested and destination_role == UserRole.ADMIN.value:
        leave_groups(db, user, membership_groups, actor_id)
    if payload.status == UserStatus.ACTIVE:
        return _activate_user(
            db,
            user,
            membership,
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
            membership,
            actor_id=actor_id,
            target_id=target_id,
            payload=payload,
            destination_role=destination_role,
            before=before,
        )
    membership.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    notify_access_changes(db, before)
    revoke_stale(db)
    commit(db, "Username unavailable")
    return membership_view(user, membership)


def _change_membership_status(
    db: Session, user: User, membership: Membership, payload: UserUpdate, actor_id: UUID
) -> UserResponse:
    """Disable or re-enable the person in this organization only (shared accounts)."""
    if payload.status == UserStatus.ACTIVE and not is_established_user(membership):
        raise conflict("Unaccepted invitations require verified acceptance")
    if payload.status == UserStatus.DISABLED and membership.status == UserStatus.PENDING.value:
        raise conflict("Pending invitations cannot be disabled")
    destination_status = payload.status.value if payload.status is not None else membership.status
    ensure_projected_admin_remains(
        db,
        user,
        membership,
        destination_role=membership.role,
        destination_status=destination_status,
    )
    before = snapshot_access(db, (user,))
    membership.status = destination_status
    membership.performed_by = actor_id
    notify_access_changes(db, before)
    revoke_stale(db)
    commit(db, "Unable to update membership")
    return membership_view(user, membership)


def _remove_membership(db: Session, user: User, membership: Membership, actor_id: UUID) -> Response:
    """Remove the person from this organization only (shared accounts)."""

    if user.id == actor_id:
        raise forbidden("You cannot remove yourself")
    ensure_projected_admin_remains(
        db,
        user,
        membership,
        destination_role=membership.role,
        destination_status=membership.status,
        destination_deleted=True,
    )
    before = snapshot_access(db, (user,))
    membership.is_deleted = True
    membership.deleted_at = datetime.now(UTC)
    membership.performed_by = actor_id
    notify_access_changes(db, before)
    revoke_stale(db)
    commit(db, "Unable to remove membership")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _activate_user(
    db: Session,
    user: User,
    membership: Membership,
    *,
    actor_id: UUID,
    target_id: UUID,
    payload: UserUpdate,
    destination_role: str,
    before: AccessSnapshot | None,
) -> UserResponse:
    operation_id = uuid7()
    _record_outcome(
        db,
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
            membership,
            destination_role=destination_role,
            destination_status=UserStatus.ACTIVE.value,
        )
        membership.role = destination_role
        if payload.username is not None:
            user.username = payload.username
        user.status = UserStatus.ACTIVE.value
        notify_access_changes(db, before)
        revoke_stale(db)
        commit(db, "Username unavailable")
    except HTTPException as error:
        if db.in_transaction():
            db.rollback()
        _record_outcome(
            db,
            "user.authentication_activation",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "local activation finalization failed",
        )
        raise error
    _record_outcome(
        db,
        "user.authentication_activation",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return membership_view(user, membership)


def _disable_user(
    db: Session,
    user: User,
    membership: Membership,
    *,
    actor_id: UUID,
    target_id: UUID,
    payload: UserUpdate,
    destination_role: str,
    before: AccessSnapshot | None,
) -> UserResponse:
    operation_id = uuid7()
    _record_outcome(
        db,
        "user.authentication_disable",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    membership.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    user.status = UserStatus.DISABLED.value
    advance_token_cutoff(user)
    revoke_user_sessions(db, user.id, except_session_id=None)
    try:
        notify_access_changes(db, before)
        revoke_stale(db)
        commit(db, "Username unavailable")
    except HTTPException as error:
        _record_outcome(
            db,
            "user.authentication_disable",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "local disable finalization failed",
        )
        raise error
    _record_outcome(
        db,
        "user.authentication_disable",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return membership_view(user, membership)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    lock_projection(db)
    admin = require_fresh_exact_admin(db, admin.id, serialize_admin_changes=True)
    actor_id = admin.id
    user = lock_user(db, user_id)
    membership = organization_member(db, user)
    protect_owners(db, user)
    if shares_another_organization(db, user) and not is_platform_operator(db, actor_id):
        return _remove_membership(db, user, membership, actor_id)
    target_id = user.id
    if user.is_deleted:
        raise conflict("User is already deleted")
    if target_id == actor_id:
        raise forbidden("You cannot delete your own account")
    ensure_projected_admin_remains(
        db,
        user,
        membership,
        destination_role=membership.role,
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
        db,
        "user.authentication_disable",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    try:
        revoke_stale(db)
        commit(db, "Unable to delete user")
    except HTTPException as error:
        _record_outcome(
            db,
            "user.authentication_disable",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "local delete finalization failed",
        )
        raise error
    _record_outcome(
        db,
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
) -> UserResponse:
    lock_projection(db)
    admin = require_fresh_exact_admin(db, admin.id, serialize_admin_changes=True)
    actor_id = admin.id
    user = lock_user(db, user_id)
    membership = directory_membership(db, user.id)
    if membership is None:
        raise not_found("User")
    target_id = user.id
    if not user.is_deleted and not membership.is_deleted:
        raise conflict("User is not deleted")
    if not is_established_user(membership):
        raise conflict("Unaccepted invitations cannot be restored")
    if not user.is_deleted:
        before = snapshot_access(db, (user,))
        membership.is_deleted, membership.deleted_at = False, None
        membership.status, membership.performed_by = UserStatus.ACTIVE.value, actor_id
        notify_access_changes(db, before)
        commit(db, "Unable to restore membership")
        return membership_view(user, membership)
    if not is_platform_operator(db, actor_id):
        db.rollback()
        raise conflict("Only the installation owner can restore a deleted account")
    operation_id = uuid7()
    _record_outcome(
        db,
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
            membership,
            destination_role=membership.role,
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
            db,
            "user.authentication_restore",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "local restore finalization failed",
        )
        raise error
    _record_outcome(
        db,
        "user.authentication_restore",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return membership_view(user, membership)
