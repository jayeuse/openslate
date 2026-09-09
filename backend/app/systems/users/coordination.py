"""Locked user and role coordination used by account and role routes."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload

from app.core.base_model import utc_now
from app.systems.users.eligibility import established_user_clause, is_established_user
from app.systems.users.models import Role, User, UserRole, UserStatus

BUILT_IN_ROLES = frozenset(role.value for role in UserRole)


@dataclass(frozen=True, slots=True)
class UserState:
    role_id: UUID
    status: str
    is_deleted: bool
    deleted_at: datetime | None
    username: str
    invitation_sent_at: datetime | None
    invitation_accepted_at: datetime | None
    tokens_valid_after: datetime | None


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def forbidden(message: str = "Forbidden") -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=message)


def not_found(resource: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource} not found")


def unavailable(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=message)


def commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict(message) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Database operation unavailable") from error


def get_user(db: Session, user_id: UUID) -> User:
    user = db.scalar(select(User).options(joinedload(User.role)).where(User.id == user_id))
    if user is None:
        raise not_found("User")
    return user


def lock_user(db: Session, user_id: UUID) -> User:
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
        raise unavailable("Unable to lock user") from error
    if user is None:
        db.rollback()
        raise not_found("User")
    if not isinstance(user, User):
        db.rollback()
        raise unavailable("Unable to lock user")
    return user


def get_role(db: Session, role_id: UUID) -> Role:
    role = db.get(Role, role_id)
    if role is None:
        raise not_found("Role")
    return role


def lock_active_role(db: Session, role_id: UUID) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to lock role") from error
    if role is None:
        db.rollback()
        raise conflict("Role is not active")
    if not isinstance(role, Role):
        db.rollback()
        raise unavailable("Unable to lock role")
    return role


def lock_role_any_state(db: Session, role_id: UUID) -> Role:
    try:
        role = db.scalar(
            select(Role)
            .where(Role.id == role_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to lock role") from error
    if role is None:
        db.rollback()
        raise not_found("Role")
    if not isinstance(role, Role):
        db.rollback()
        raise unavailable("Unable to lock role")
    return role


def is_built_in(role: Role) -> bool:
    return role.role in BUILT_IN_ROLES


def non_deleted_user_count(db: Session, role_id: UUID) -> int:
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
        raise unavailable("Unable to inspect role assignments") from error


def active_admin_count(db: Session) -> int:
    try:
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .join(Role, User.role_id == Role.id)
                .where(
                    User.is_deleted.is_(False),
                    User.status == UserStatus.ACTIVE.value,
                    established_user_clause(),
                    Role.is_deleted.is_(False),
                    Role.role == UserRole.ADMIN,
                )
            )
            or 0
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to evaluate administrator membership") from error


def is_active_admin(user: User, role: Role | None = None, status_value: str | None = None) -> bool:
    assigned_role = role or user.role
    return bool(
        not user.is_deleted
        and (status_value or user.status) == UserStatus.ACTIVE.value
        and is_established_user(user, status_value=status_value)
        and assigned_role is not None
        and not assigned_role.is_deleted
        and assigned_role.role == UserRole.ADMIN
    )


def advance_token_cutoff(user: User) -> None:
    now = utc_now()
    if user.tokens_valid_after is None or user.tokens_valid_after < now:
        user.tokens_valid_after = now


def user_state(user: User) -> UserState:
    return UserState(
        role_id=user.role_id,
        status=user.status,
        is_deleted=user.is_deleted,
        deleted_at=user.deleted_at,
        username=user.username,
        invitation_sent_at=user.invitation_sent_at,
        invitation_accepted_at=user.invitation_accepted_at,
        tokens_valid_after=user.tokens_valid_after,
    )


def ensure_projected_admin_remains(
    db: Session,
    user: User,
    *,
    destination_role: Role,
    destination_status: str,
    destination_deleted: bool = False,
) -> None:
    was_active_admin = is_active_admin(user)
    will_be_active_admin = bool(
        not destination_deleted
        and destination_status == UserStatus.ACTIVE.value
        and is_established_user(user, status_value=destination_status)
        and not destination_role.is_deleted
        and destination_role.role == UserRole.ADMIN
    )
    if not (was_active_admin or will_be_active_admin):
        return
    projected = active_admin_count(db) - int(was_active_admin) + int(will_be_active_admin)
    if projected < 1:
        raise conflict("Cannot remove the last active admin")
