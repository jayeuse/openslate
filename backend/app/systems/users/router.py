from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database import get_db
from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAdminError
from app.systems.audit.models import SecurityEventOutcome
from app.systems.audit.schemas import SecurityEventIngestRequest
from app.systems.audit.service import (
    SecurityEventPersistenceError,
    append_committed_security_event,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.schemas import (
    RoleCreate,
    RoleResponse,
    RoleUpdate,
    UserCreate,
    UserResponse,
    UserUpdate,
)
from app.systems.users.service import (
    InvitationConflict,
    InvitationError,
    invite_user,
)

router = APIRouter(prefix="/users", tags=["users"])
roles_router = APIRouter(prefix="/roles", tags=["roles"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]

BUILT_IN_ROLES = frozenset(role.value for role in UserRole)


class RoleSortField(StrEnum):
    ROLE = "role"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class UserSortField(StrEnum):
    EMAIL = "email"
    USERNAME = "username"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class RoleListResponse(StandardListResponse[RoleResponse]):
    pass


class UserListResponse(StandardListResponse[UserResponse]):
    pass


class UserListRequest(StandardListRequest[UserSortField]):
    role_id: UUID | None = None


ROLE_LIST_SPEC = ListQuerySpec(
    sort_fields={
        RoleSortField.ROLE: cast(ColumnElement[Any], Role.role),
        RoleSortField.CREATED_AT: cast(ColumnElement[Any], Role.created_at),
        RoleSortField.UPDATED_AT: cast(ColumnElement[Any], Role.updated_at),
    },
    default_sort=RoleSortField.ROLE,
    tie_breaker=cast(ColumnElement[Any], Role.id),
    search_fields=(cast(ColumnElement[str], Role.role),),
    deleted_field=cast(ColumnElement[bool], Role.is_deleted),
)
USER_LIST_SPEC = ListQuerySpec(
    sort_fields={
        UserSortField.EMAIL: cast(ColumnElement[Any], User.email),
        UserSortField.USERNAME: cast(ColumnElement[Any], User.username),
        UserSortField.CREATED_AT: cast(ColumnElement[Any], User.created_at),
        UserSortField.UPDATED_AT: cast(ColumnElement[Any], User.updated_at),
    },
    default_sort=UserSortField.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(
        cast(ColumnElement[str], User.email),
        cast(ColumnElement[str], User.username),
    ),
    deleted_field=cast(ColumnElement[bool], User.is_deleted),
)


def _not_found(resource: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource} not found")


def _conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _forbidden(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=message)


def _require_patch(fields: set[str], payload: object) -> None:
    if not fields or any(getattr(payload, field) is None for field in fields):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="At least one non-null field is required",
        )


def _active_role(db: Session, role_id: UUID) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable("Unable to lock role") from error
    if role is None:
        db.rollback()
        raise _conflict("Role is not active")
    if not isinstance(role, Role):
        db.rollback()
        raise _unavailable("Unable to lock role")
    return role


def _role(db: Session, role_id: UUID) -> Role:
    role = db.get(Role, role_id)
    if role is None:
        raise _not_found("Role")
    return role


def _user(db: Session, user_id: UUID) -> User:
    user = db.scalar(
        select(User).options(joinedload(User.role)).where(User.id == user_id)
    )
    if user is None:
        raise _not_found("User")
    return user


def _lock_user(db: Session, user_id: UUID) -> User:
    try:
        user = db.scalar(
            select(User)
            .options(joinedload(User.role))
            .where(User.id == user_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable("Unable to lock user") from error
    if user is None:
        db.rollback()
        raise _not_found("User")
    if not isinstance(user, User):
        db.rollback()
        raise _unavailable("Unable to lock user")
    return user


def _is_built_in(role: Role) -> bool:
    return role.role in BUILT_IN_ROLES


def _non_deleted_user_count(db: Session, role_id: UUID) -> int:
    try:
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .where(User.role_id == role_id, User.is_deleted.is_(False))
            )
            or 0
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable("Unable to inspect role assignments") from error


def _active_admin_count(db: Session) -> int:
    try:
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .join(Role, User.role_id == Role.id)
                .where(
                    User.is_deleted.is_(False),
                    User.status == UserStatus.ACTIVE.value,
                    Role.is_deleted.is_(False),
                    Role.role == UserRole.ADMIN,
                )
            )
            or 0
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable("Unable to evaluate administrator membership") from error


def _unavailable(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=message)


def _security_event(
    db: Session,
    *,
    event_type: str,
    outcome: SecurityEventOutcome,
    operation_id: UUID,
    actor_id: UUID | None = None,
    subject_id: UUID | None = None,
    reason: str | None = None,
) -> None:
    del db
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
        raise _unavailable("Unable to record security event") from error


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
        raise _unavailable("Unable to lock role") from error
    if role is None:
        db.rollback()
        raise _conflict("Role is not active")
    if not isinstance(role, Role):
        db.rollback()
        raise _unavailable("Unable to lock role")
    return role


def _lock_role_any_state(db: Session, role_id: UUID) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable("Unable to lock role") from error
    if role is None:
        db.rollback()
        raise _not_found("Role")
    if not isinstance(role, Role):
        db.rollback()
        raise _unavailable("Unable to lock role")
    return role


def _is_active_admin(user: User, role: Role | None = None, status_value: str | None = None) -> bool:
    assigned_role = role or user.role
    return bool(
        not user.is_deleted
        and (status_value or user.status) == UserStatus.ACTIVE.value
        and assigned_role is not None
        and not assigned_role.is_deleted
        and assigned_role.role == UserRole.ADMIN
    )


def _advance_token_cutoff(user: User) -> None:
    now = utc_now()
    if user.tokens_valid_after is None or user.tokens_valid_after < now:
        user.tokens_valid_after = now


def _user_state(user: User) -> tuple[UUID, str, bool, datetime | None, str]:
    return (user.role_id, user.status, user.is_deleted, user.deleted_at, user.username)


def _ensure_projected_admin_remains(
    db: Session,
    user: User,
    *,
    destination_role: Role,
    destination_status: str,
    destination_deleted: bool = False,
) -> None:
    was_active_admin = _is_active_admin(user)
    will_be_active_admin = bool(
        not destination_deleted
        and destination_status == UserStatus.ACTIVE.value
        and not destination_role.is_deleted
        and destination_role.role == UserRole.ADMIN
    )
    if not (was_active_admin or will_be_active_admin):
        return
    projected = _active_admin_count(db) - int(was_active_admin) + int(will_be_active_admin)
    if projected < 1:
        raise _conflict("Cannot remove the last active admin")


def _commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(message) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable("Database operation unavailable") from error


def _disable_auth_user(user_id: UUID) -> None:
    try:
        SupabaseAdminClient().disable_user(user_id)
    except SupabaseAdminError as error:
        raise _unavailable("Unable to disable user authentication") from error


def _enable_auth_user(user_id: UUID) -> None:
    try:
        SupabaseAdminClient().enable_user(user_id)
    except SupabaseAdminError as error:
        raise _unavailable("Unable to restore user authentication") from error


@roles_router.get("", response_model=RoleListResponse)
def list_roles(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[StandardListRequest[RoleSortField], Query()],
) -> RoleListResponse:
    result = execute_standard_list(db, select(Role), params, ROLE_LIST_SPEC)
    return RoleListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@roles_router.get("/{role_id}", response_model=RoleResponse)
def get_role(
    role_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    return _role(db, role_id)


@roles_router.post("", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
def create_role(
    payload: RoleCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    require_fresh_exact_admin(db, admin.id)
    if payload.role in BUILT_IN_ROLES:
        raise _conflict("Built-in roles are protected")
    role = Role(role=payload.role, permissions=payload.permissions)
    db.add(role)
    _commit(db, "Role name unavailable")
    db.refresh(role)
    return role


@roles_router.patch("/{role_id}", response_model=RoleResponse)
def update_role(
    role_id: UUID,
    payload: RoleUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    _require_patch(payload.model_fields_set, payload)
    require_fresh_exact_admin(db, admin.id)
    role = _lock_role(db, role_id)
    if _is_built_in(role) and payload.role is not None:
        raise _forbidden("Built-in roles are protected")
    if payload.role in BUILT_IN_ROLES:
        raise _conflict("Built-in roles are protected")
    if payload.role is not None:
        role.role = payload.role
    if payload.permissions is not None:
        role.permissions = payload.permissions
    _commit(db, "Role name unavailable")
    db.refresh(role)
    return role


@roles_router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(
    role_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    require_fresh_exact_admin(db, admin.id)
    role = _lock_role(db, role_id)
    if _is_built_in(role):
        raise _forbidden("Built-in roles are protected")
    if role.is_deleted:
        raise _conflict("Role is already deleted")
    if _non_deleted_user_count(db, role.id):
        raise _conflict("Role has assigned users")
    role.is_deleted = True
    role.deleted_at = datetime.now(UTC)
    _commit(db, "Unable to delete role")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@roles_router.post("/{role_id}/restore", response_model=RoleResponse)
def restore_role(
    role_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Role:
    require_fresh_exact_admin(db, admin.id)
    role = _lock_role_any_state(db, role_id)
    if _is_built_in(role):
        raise _forbidden("Built-in roles are protected")
    if not role.is_deleted:
        raise _conflict("Role is not deleted")
    role.is_deleted = False
    role.deleted_at = None
    _commit(db, "Unable to restore role")
    return role


@router.get("", response_model=UserListResponse)
def list_users(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[UserListRequest, Query()],
) -> UserListResponse:
    statement = select(User)
    role_id = getattr(params, "role_id", None)
    if role_id is not None:
        statement = statement.where(User.role_id == role_id)
    result = execute_standard_list(
        db,
        statement,
        params,
        USER_LIST_SPEC,
    )
    return UserListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return _user(db, user_id)


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    try:
        return invite_user(
            db,
            InvitationCreate(
                email=payload.email,
                username=payload.username,
                role_id=payload.role_id,
            ),
            actor_id=admin.id,
        )
    except InvitationConflict as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username is already in use",
        ) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to send invitation",
        ) from error


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(
    user_id: UUID,
    payload: UserUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    _require_patch(payload.model_fields_set, payload)
    admin = require_fresh_exact_admin(db, admin.id)
    user = _lock_user(db, user_id)
    if user.is_deleted:
        raise _conflict("User is deleted")

    role_change_requested = payload.role_id is not None and payload.role_id != user.role_id
    destination_role = user.role
    requested_role_id = payload.role_id
    if role_change_requested and requested_role_id is not None:
        destination_role = _active_role(db, requested_role_id)
    if destination_role is None:
        raise _conflict("User role is not active")

    destination_status = payload.status.value if payload.status is not None else user.status
    if payload.status == UserStatus.ACTIVE and user.status == UserStatus.PENDING.value:
        raise _conflict("Pending invitations require verified acceptance")
    if payload.status is not None or role_change_requested:
        _ensure_projected_admin_remains(
            db,
            user,
            destination_role=destination_role,
            destination_status=destination_status,
        )

    if payload.status == UserStatus.ACTIVE:
        operation_id = uuid7()
        initial_state = _user_state(user)
        _security_event(
            db,
            event_type="user.authentication_activation",
            outcome=SecurityEventOutcome.ATTEMPT,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
        )
        db.rollback()
        try:
            _enable_auth_user(user.id)
        except HTTPException:
            _security_event(
                db,
                event_type="user.authentication_activation",
                outcome=SecurityEventOutcome.FAILURE,
                operation_id=operation_id,
                actor_id=admin.id,
                subject_id=user.id,
                reason="unable to enable user authentication",
            )
            raise
        try:
            require_fresh_exact_admin(db, admin.id)
            finalized_user = _lock_user(db, user.id)
            if _user_state(finalized_user) != initial_state:
                raise _conflict("User changed while authentication was enabled")
            if role_change_requested and requested_role_id is not None:
                finalized_role = _active_role(db, requested_role_id)
            else:
                finalized_role = finalized_user.role
            if finalized_role is None or finalized_role.is_deleted:
                raise _conflict("User role is not active")
            _ensure_projected_admin_remains(
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
            _commit(db, "Username unavailable")
        except HTTPException as local_error:
            if db.in_transaction():
                db.rollback()
            _security_event(
                db,
                event_type="user.authentication_activation",
                outcome=SecurityEventOutcome.PARTIAL,
                operation_id=operation_id,
                actor_id=admin.id,
                subject_id=user.id,
                reason="local activation finalization failed",
            )
            raise local_error
        _security_event(
            db,
            event_type="user.authentication_activation",
            outcome=SecurityEventOutcome.SUCCESS,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
        )
        return finalized_user

    if payload.status == UserStatus.DISABLED:
        operation_id = uuid7()
        _security_event(
            db,
            event_type="user.authentication_disable",
            outcome=SecurityEventOutcome.ATTEMPT,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
        )
        if role_change_requested:
            user.role_id = destination_role.id
            user.role = destination_role
        if payload.username is not None:
            user.username = payload.username
        user.status = UserStatus.DISABLED.value
        _advance_token_cutoff(user)
        try:
            _commit(db, "Username unavailable")
        except HTTPException as local_error:
            _security_event(
                db,
                event_type="user.authentication_disable",
                outcome=SecurityEventOutcome.FAILURE,
                operation_id=operation_id,
                actor_id=admin.id,
                subject_id=user.id,
                reason="local disable finalization failed",
            )
            raise local_error
        try:
            _disable_auth_user(user.id)
        except HTTPException:
            _security_event(
                db,
                event_type="user.authentication_disable",
                outcome=SecurityEventOutcome.PARTIAL,
                operation_id=operation_id,
                actor_id=admin.id,
                subject_id=user.id,
                reason="unable to disable user authentication",
            )
            raise
        _security_event(
            db,
            event_type="user.authentication_disable",
            outcome=SecurityEventOutcome.SUCCESS,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
        )
        return user

    if role_change_requested:
        user.role_id = destination_role.id
        user.role = destination_role
    if payload.username is not None:
        user.username = payload.username
    _commit(db, "Username unavailable")
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    admin = require_fresh_exact_admin(db, admin.id)
    user = _lock_user(db, user_id)
    if user.is_deleted:
        raise _conflict("User is already deleted")
    if user.id == admin.id:
        raise _forbidden("You cannot delete your own account")
    if _is_active_admin(user) and _active_admin_count(db) <= 1:
        raise _conflict("Cannot delete the last active admin")
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    user.status = UserStatus.DISABLED.value
    _advance_token_cutoff(user)
    operation_id = uuid7()
    _security_event(
        db,
        event_type="user.authentication_disable",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=admin.id,
        subject_id=user.id,
    )
    try:
        _commit(db, "Unable to delete user")
    except HTTPException as local_error:
        _security_event(
            db,
            event_type="user.authentication_disable",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
            reason="local delete finalization failed",
        )
        raise local_error
    try:
        _disable_auth_user(user.id)
    except HTTPException:
        _security_event(
            db,
            event_type="user.authentication_disable",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
            reason="unable to disable user authentication",
        )
        raise
    _security_event(
        db,
        event_type="user.authentication_disable",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=admin.id,
        subject_id=user.id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{user_id}/restore", response_model=UserResponse)
def restore_user(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    admin = require_fresh_exact_admin(db, admin.id)
    user = _lock_user(db, user_id)
    if not user.is_deleted:
        raise _conflict("User is not deleted")
    _active_role(db, user.role_id)
    initial_state = _user_state(user)

    db.rollback()
    operation_id = uuid7()
    _security_event(
        db,
        event_type="user.authentication_restore",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=admin.id,
        subject_id=user.id,
    )
    try:
        _enable_auth_user(user.id)
    except HTTPException:
        _security_event(
            db,
            event_type="user.authentication_restore",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
            reason="unable to enable user authentication",
        )
        raise

    try:
        require_fresh_exact_admin(db, admin.id)
        revalidated = _lock_user(db, user.id)
        if not revalidated.is_deleted:
            raise _conflict("User is not deleted")
        if _user_state(revalidated) != initial_state:
            raise _conflict("User changed while authentication was enabled")
        restored_role = _active_role(db, revalidated.role_id)
        if restored_role.is_deleted:
            raise _conflict("Role is not active")
        _ensure_projected_admin_remains(
            db,
            revalidated,
            destination_role=restored_role,
            destination_status=UserStatus.ACTIVE.value,
            destination_deleted=False,
        )
        revalidated.role = restored_role
        revalidated.role_id = restored_role.id
        revalidated.is_deleted = False
        revalidated.deleted_at = None
        revalidated.status = UserStatus.ACTIVE.value
        _commit(db, "Unable to restore user")
    except HTTPException as local_error:
        if db.in_transaction():
            db.rollback()
        _security_event(
            db,
            event_type="user.authentication_restore",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
            reason="local restore finalization failed",
        )
        raise local_error
    _security_event(
        db,
        event_type="user.authentication_restore",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=admin.id,
        subject_id=user.id,
    )
    return revalidated


@router.post("/{user_id}/reconcile-auth", response_model=UserResponse)
def reconcile_auth(
    user_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> User:
    admin = require_fresh_exact_admin(db, admin.id)
    user = _lock_user(db, user_id)
    desired_active = user.status == UserStatus.ACTIVE.value and not user.is_deleted
    initial_state = _user_state(user)
    operation_id = uuid7()
    _security_event(
        db,
        event_type="user.authentication_reconciliation",
        outcome=SecurityEventOutcome.ATTEMPT,
        operation_id=operation_id,
        actor_id=admin.id,
        subject_id=user.id,
    )
    db.rollback()
    try:
        client = SupabaseAdminClient()
        if desired_active:
            client.enable_user(user.id)
        else:
            client.disable_user(user.id)
    except SupabaseAdminError as error:
        _security_event(
            db,
            event_type="user.authentication_reconciliation",
            outcome=SecurityEventOutcome.FAILURE,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
            reason="unable to reconcile user authentication",
        )
        raise _unavailable("Unable to reconcile user authentication") from error
    try:
        require_fresh_exact_admin(db, admin.id)
        revalidated = _lock_user(db, user.id)
        if _user_state(revalidated) != initial_state:
            if not desired_active and revalidated.status == UserStatus.ACTIVE.value:
                # Remote disable succeeded.  Keep FastAPI fail-closed by disabling
                # the locally active profile without making an opposite Auth call.
                revalidated.status = UserStatus.DISABLED.value
                _advance_token_cutoff(revalidated)
                _commit(db, "Unable to persist fail-closed reconciliation state")
            raise _conflict("User changed while authentication was reconciled")
        db.rollback()
    except HTTPException as local_error:
        if db.in_transaction():
            db.rollback()
        _security_event(
            db,
            event_type="user.authentication_reconciliation",
            outcome=SecurityEventOutcome.PARTIAL,
            operation_id=operation_id,
            actor_id=admin.id,
            subject_id=user.id,
            reason="local reconciliation state changed",
        )
        raise local_error
    _security_event(
        db,
        event_type="user.authentication_reconciliation",
        outcome=SecurityEventOutcome.SUCCESS,
        operation_id=operation_id,
        actor_id=admin.id,
        subject_id=user.id,
    )
    return revalidated
