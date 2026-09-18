"""Auth-provider reconciliation for existing user account state."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.core.database import get_db
from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAdminError
from app.systems.access.users.account_operations import _record_outcome
from app.systems.access.users.coordination import (
    advance_token_cutoff,
    commit,
    conflict,
    lock_user,
    unavailable,
    user_state,
)
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.schemas import UserResponse
from app.systems.manage.audit.models import SecurityEventOutcome

router = APIRouter(prefix="/users", tags=["users"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


@router.post("/{user_id}/reconcile-auth", response_model=UserResponse)
def reconcile_auth(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    admin = require_fresh_exact_admin(db, admin.id)
    actor_id = admin.id
    user = lock_user(db, user_id)
    target_id = user.id
    desired_active = bool(
        user.status == UserStatus.ACTIVE.value and not user.is_deleted and is_established_user(user)
    )
    initial_state = user_state(user)
    operation_id = uuid7()
    _record_outcome(
        "user.authentication_reconciliation",
        SecurityEventOutcome.ATTEMPT,
        operation_id,
        actor_id,
        target_id,
    )
    db.rollback()
    try:
        client = SupabaseAdminClient()
        if desired_active:
            client.enable_user(target_id)
        else:
            client.disable_user(target_id)
    except SupabaseAdminError as error:
        _record_outcome(
            "user.authentication_reconciliation",
            SecurityEventOutcome.FAILURE,
            operation_id,
            actor_id,
            target_id,
            "unable to reconcile user authentication",
        )
        raise unavailable("Unable to reconcile user authentication") from error
    try:
        require_fresh_exact_admin(db, actor_id)
        revalidated = lock_user(db, target_id)
        if user_state(revalidated) != initial_state:
            if not desired_active and revalidated.status == UserStatus.ACTIVE.value:
                revalidated.status = UserStatus.DISABLED.value
                advance_token_cutoff(revalidated)
                commit(db, "Unable to persist fail-closed reconciliation state")
            raise conflict("User changed while authentication was reconciled")
        db.rollback()
    except HTTPException as error:
        if db.in_transaction():
            db.rollback()
        _record_outcome(
            "user.authentication_reconciliation",
            SecurityEventOutcome.PARTIAL,
            operation_id,
            actor_id,
            target_id,
            "local reconciliation state changed",
        )
        raise error
    _record_outcome(
        "user.authentication_reconciliation",
        SecurityEventOutcome.SUCCESS,
        operation_id,
        actor_id,
        target_id,
    )
    return revalidated
