"""Locked user and role coordination used by account and role routes."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.core.base_model import utc_now
from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.service_identities.models import ServiceIdentity
from app.systems.access.users.eligibility import established_user_clause, is_established_user
from app.systems.access.users.models import (
    IdentityKind,
    Role,
    User,
    UserDepartment,
    UserRole,
    UserStatus,
)
from app.systems.sandbox.departments.models import Department

BUILT_IN_ROLES = frozenset(role.value for role in UserRole)


class InvitationError(RuntimeError):
    """A safe invitation lifecycle error."""


class InvitationConflict(InvitationError):
    """An invitation conflicts with a local identity."""


class InvitationNotFound(InvitationError):
    """The requested invitation profile does not exist."""


class ProfileValidationError(InvitationError):
    """An identity profile cannot be assigned safely."""


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
    user = db.scalar(
        select(User)
        .options(joinedload(User.role), selectinload(User.department_memberships))
        .where(User.id == user_id)
    )
    if user is None:
        raise not_found("User")
    return user


def lock_user(db: Session, user_id: UUID) -> User:
    try:
        user = db.scalar(
            select(User)
            .options(joinedload(User.role), selectinload(User.department_memberships))
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


def non_deleted_service_identity_count(
    db: Session, *, role_id: UUID | None = None, owner_id: UUID | None = None
) -> int:
    column = ServiceIdentity.role_id if role_id is not None else ServiceIdentity.owner_id
    value = role_id if role_id is not None else owner_id
    if value is None:
        raise ValueError("A service identity reference is required")
    try:
        return int(
            db.scalar(
                select(func.count())
                .select_from(ServiceIdentity)
                .where(column == value, ServiceIdentity.is_deleted.is_(False))
            )
            or 0
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise unavailable("Unable to inspect service identity references") from error


def active_admin_count(db: Session, *, durable: bool = False) -> int:
    try:
        expiry_condition = (
            User.expires_at.is_(None)
            if durable
            else or_(User.expires_at.is_(None), User.expires_at > utc_now())
        )
        return int(
            db.scalar(
                select(func.count())
                .select_from(User)
                .join(Role, User.role_id == Role.id)
                .where(
                    User.is_deleted.is_(False),
                    User.status == UserStatus.ACTIVE.value,
                    User.identity_kind == IdentityKind.INTERNAL.value,
                    established_user_clause(),
                    Role.is_deleted.is_(False),
                    Role.role == UserRole.ADMIN,
                    expiry_condition,
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
        and is_identity_eligible(user)
        and user.identity_kind == IdentityKind.INTERNAL.value
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
    destination_expires_at: datetime | None = None,
    expiry_requested: bool = False,
) -> None:
    now = utc_now()
    was_active_admin = is_active_admin(user)
    projected_expiry = destination_expires_at if expiry_requested else user.expires_at
    will_be_active_admin = bool(
        not destination_deleted
        and destination_status == UserStatus.ACTIVE.value
        and user.identity_kind == IdentityKind.INTERNAL.value
        and (projected_expiry is None or projected_expiry > now)
        and is_established_user(user, status_value=destination_status)
        and not destination_role.is_deleted
        and destination_role.role == UserRole.ADMIN
    )
    if not (was_active_admin or will_be_active_admin):
        return
    projected = active_admin_count(db) - int(was_active_admin) + int(will_be_active_admin)
    if projected < 1:
        raise conflict("Cannot remove the last active admin")
    was_durable_admin = was_active_admin and user.expires_at is None
    will_be_durable_admin = will_be_active_admin and projected_expiry is None
    if (was_durable_admin and not will_be_durable_admin) or (
        expiry_requested and will_be_active_admin and not will_be_durable_admin
    ):
        projected_durable = (
            active_admin_count(db, durable=True)
            - int(was_durable_admin)
            + int(will_be_durable_admin)
        )
        if projected_durable < 1:
            raise conflict("Cannot remove the last durable admin")


def validate_identity_profile(
    db: Session,
    *,
    identity_kind: IdentityKind | str | None,
    sponsor_user_id: UUID | None,
    expires_at: datetime | None,
    role: Role,
) -> None:
    """Validate the profile invariants that require current database state."""

    kind = IdentityKind(identity_kind or IdentityKind.INTERNAL.value)
    if kind is IdentityKind.INTERNAL:
        if sponsor_user_id is not None:
            raise ProfileValidationError("Internal identities cannot have a sponsor")
        return
    if sponsor_user_id is None:
        raise ProfileValidationError("Guest identities require an active internal sponsor")
    if expires_at is None or expires_at.tzinfo is None or expires_at <= utc_now():
        raise ProfileValidationError("Guest identities require a future expiration")
    if role.role == UserRole.ADMIN:
        raise ProfileValidationError("Guest identities cannot be administrators")
    sponsor = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == sponsor_user_id)
        .with_for_update(of=User)
    )
    if not isinstance(sponsor, User) or (
        sponsor.is_deleted
        or sponsor.status != UserStatus.ACTIVE.value
        or sponsor.identity_kind != IdentityKind.INTERNAL.value
        or not is_identity_eligible(sponsor, now=utc_now())
    ):
        raise ProfileValidationError("Guest sponsor is not an active internal identity")


def resolve_department_memberships(
    db: Session,
    department_ids: list[UUID],
    primary_department_id: UUID | None,
) -> tuple[UUID, ...]:
    """Deduplicate and validate active department assignments for one profile write."""

    unique_ids = tuple(dict.fromkeys(department_ids))
    if primary_department_id is not None and primary_department_id not in unique_ids:
        raise ProfileValidationError("Primary department must be a selected department")
    if not unique_ids:
        return unique_ids
    departments = db.scalars(
        select(Department)
        .where(Department.id.in_(unique_ids), Department.is_deleted.is_(False))
        .order_by(Department.id)
        .with_for_update()
    ).all()
    active_ids = {department.id for department in departments}
    if set(unique_ids) != active_ids:
        raise ProfileValidationError("Department is not active")
    return unique_ids


def replace_department_memberships(
    db: Session,
    user: User,
    *,
    department_ids: list[UUID] | None,
    primary_department_id: UUID | None,
    primary_requested: bool,
) -> None:
    """Replace locked department assignments while preserving an existing primary."""

    if department_ids is None and not primary_requested:
        return
    existing = db.scalars(
        select(UserDepartment)
        .where(UserDepartment.user_id == user.id)
        .order_by(UserDepartment.department_id)
        .with_for_update()
    ).all()
    existing_primary = next((item for item in existing if item.is_primary), None)
    supplied_ids = (
        department_ids if department_ids is not None else [item.department_id for item in existing]
    )
    desired_primary = primary_department_id if primary_requested else None
    if not primary_requested and existing_primary is not None:
        desired_primary = (
            existing_primary.department_id
            if existing_primary.department_id in supplied_ids
            else None
        )
    selected_ids = resolve_department_memberships(db, supplied_ids, desired_primary)
    existing_by_department = {membership.department_id: membership for membership in existing}
    selected_set = set(selected_ids)
    if existing_primary is not None and existing_primary.department_id != desired_primary:
        existing_primary.is_primary = False
        db.flush()
    for membership in existing:
        if membership.department_id not in selected_set:
            db.delete(membership)
    for department_id in selected_ids:
        existing_membership = existing_by_department.get(department_id)
        if existing_membership is None:
            db.add(
                UserDepartment(
                    user=user,
                    department_id=department_id,
                    is_primary=department_id == desired_primary,
                )
            )
        else:
            existing_membership.is_primary = department_id == desired_primary
