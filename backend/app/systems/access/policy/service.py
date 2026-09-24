from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.models import (
    AccessDefaultDepartment,
    AccessDefaultGroup,
    AccessGroup,
    AccessGroupMember,
    AccessPolicyDefaults,
    AccessRule,
)
from app.systems.access.policy.schemas import (
    AccessDefaultsUpdate,
    AccessGroupCreate,
    AccessGroupUpdate,
)
from app.systems.access.users.models import IdentityKind, Role, User, UserRole, UserStatus
from app.systems.sandbox.departments.models import Department


@dataclass(frozen=True, slots=True)
class CreationDefaults:
    role: Role
    group_ids: tuple[UUID, ...]
    department_ids: tuple[UUID, ...]
    invitation_expiry_days: int
    guest_duration_days: int


def conflict(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def unavailable(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Database unavailable",
    )


def commit(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict(message) from error
    except SQLAlchemyError as error:
        raise unavailable(db) from error


def _require_patch(payload: AccessGroupUpdate | AccessDefaultsUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Fields cannot be null",
        )


def require_group_patch(payload: AccessGroupUpdate) -> None:
    _require_patch(payload)


def require_defaults_patch(payload: AccessDefaultsUpdate) -> None:
    _require_patch(payload)


def group_etag(row: AccessGroup) -> str:
    return f'"{row.id}:{row.revision}"'


def defaults_etag(row: AccessPolicyDefaults) -> str:
    return f'"{row.id}:{row.revision}"'


def require_match(value: str | None, expected: str) -> None:
    if value is None:
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED,
            detail="If-Match is required",
        )
    if value != expected:
        raise HTTPException(
            status_code=status.HTTP_412_PRECONDITION_FAILED,
            detail="Resource changed",
        )


def _unique_ids(ids: Iterable[UUID]) -> tuple[UUID, ...]:
    return tuple(dict.fromkeys(ids))


def get_group(db: Session, group_id: UUID) -> AccessGroup:
    try:
        row = db.get(AccessGroup, group_id)
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return row


def lock_group(db: Session, group_id: UUID) -> AccessGroup:
    try:
        row = db.scalar(
            select(AccessGroup)
            .where(AccessGroup.id == group_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if row is None:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return row


def group_member_ids(db: Session, group_id: UUID) -> list[UUID]:
    try:
        return list(
            db.scalars(
                select(AccessGroupMember.user_id)
                .where(AccessGroupMember.group_id == group_id)
                .order_by(AccessGroupMember.user_id)
            ).all()
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error


def group_member_map(db: Session, group_ids: Iterable[UUID]) -> dict[UUID, list[UUID]]:
    result: dict[UUID, list[UUID]] = {}
    ids = tuple(group_ids)
    if not ids:
        return result
    try:
        rows = db.execute(
            select(AccessGroupMember.group_id, AccessGroupMember.user_id)
            .where(AccessGroupMember.group_id.in_(ids))
            .order_by(AccessGroupMember.group_id, AccessGroupMember.user_id)
        ).tuples()
        for group_id, user_id in rows:
            result.setdefault(group_id, []).append(user_id)
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    return result


def _active_users(db: Session, user_ids: tuple[UUID, ...]) -> set[UUID]:
    if not user_ids:
        return set()
    rows = db.scalars(
        select(User)
        .where(
            User.id.in_(user_ids),
            User.is_deleted.is_(False),
            User.status == UserStatus.ACTIVE.value,
            User.identity_kind.in_((IdentityKind.INTERNAL.value, IdentityKind.GUEST.value)),
            or_(User.expires_at.is_(None), User.expires_at > datetime.now(UTC)),
        )
        .order_by(User.id)
        .with_for_update()
    ).all()
    return {row.id for row in rows}


def _existing_pending_users(db: Session, user_ids: set[UUID]) -> set[UUID]:
    if not user_ids:
        return set()
    rows = db.scalars(
        select(User)
        .where(
            User.id.in_(user_ids),
            User.is_deleted.is_(False),
            User.status == UserStatus.PENDING.value,
            User.identity_kind.in_((IdentityKind.INTERNAL.value, IdentityKind.GUEST.value)),
            or_(User.expires_at.is_(None), User.expires_at > datetime.now(UTC)),
        )
        .order_by(User.id)
        .with_for_update()
    ).all()
    return {row.id for row in rows}


def replace_group_members(
    db: Session,
    row: AccessGroup,
    member_ids: list[UUID],
    actor_id: UUID,
) -> bool:
    existing = list(
        db.scalars(
            select(AccessGroupMember)
            .where(AccessGroupMember.group_id == row.id)
            .order_by(AccessGroupMember.user_id)
            .with_for_update()
        ).all()
    )
    desired = _unique_ids(member_ids)
    existing_ids = {item.user_id for item in existing}
    inactive_ids = set(desired) - _active_users(db, desired)
    if inactive_ids != _existing_pending_users(db, inactive_ids & existing_ids):
        raise conflict("Members must be active, unexpired users")
    if existing_ids == set(desired):
        return False
    for item in existing:
        if item.user_id not in desired:
            db.delete(item)
    for user_id in desired:
        if user_id not in existing_ids:
            db.add(AccessGroupMember(group_id=row.id, user_id=user_id, performed_by=actor_id))
    db.flush()
    return True


def create_group(db: Session, payload: AccessGroupCreate, actor_id: UUID) -> AccessGroup:
    try:
        row = AccessGroup(name=payload.name, description=payload.description, performed_by=actor_id)
        db.add(row)
        db.flush()
        replace_group_members(db, row, payload.member_ids, actor_id)
        commit(db, "Group name unavailable")
        db.refresh(row)
        return row
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise conflict("Group name unavailable") from error
    except SQLAlchemyError as error:
        raise unavailable(db) from error


def update_group(
    db: Session,
    group_id: UUID,
    payload: AccessGroupUpdate,
    if_match: str | None,
    actor_id: UUID,
) -> AccessGroup:
    require_group_patch(payload)
    row = lock_group(db, group_id)
    if row.is_deleted:
        raise conflict("Group is deleted")
    require_match(if_match, group_etag(row))
    try:
        changed = False
        if "member_ids" in payload.model_fields_set:
            changed = replace_group_members(db, row, payload.member_ids or [], actor_id)
        if "name" in payload.model_fields_set and payload.name != row.name:
            assert payload.name is not None
            row.name = payload.name
            changed = True
        if "description" in payload.model_fields_set and payload.description != row.description:
            assert payload.description is not None
            row.description = payload.description
            changed = True
        if changed:
            row.revision += 1
            row.performed_by = actor_id
        commit(db, "Group name unavailable")
        db.refresh(row)
        return row
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        raise unavailable(db) from error


def ensure_group_deletable(db: Session, row: AccessGroup) -> None:
    try:
        has_members = db.scalar(
            select(func.count())
            .select_from(AccessGroupMember)
            .where(AccessGroupMember.group_id == row.id)
        )
        if has_members:
            raise conflict("Group has members")
        is_default = db.scalar(
            select(func.count())
            .select_from(AccessDefaultGroup)
            .where(AccessDefaultGroup.group_id == row.id)
        )
        if is_default:
            raise conflict("Group is used by defaults")
        has_rules = db.scalar(
            select(func.count())
            .select_from(AccessRule)
            .where(
                AccessRule.subject_kind == "group",
                AccessRule.subject_id == row.id,
                AccessRule.is_deleted.is_(False),
            )
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if has_rules:
        raise conflict("Group has access rules. Remove or retarget them in Detailed rules first")


def delete_group(db: Session, group_id: UUID, if_match: str | None, actor_id: UUID) -> None:
    row = lock_group(db, group_id)
    if row.is_deleted:
        raise conflict("Group is already deleted")
    require_match(if_match, group_etag(row))
    ensure_group_deletable(db, row)
    row.is_deleted = True
    row.deleted_at = utc_now()
    row.revision += 1
    row.performed_by = actor_id
    commit(db, "Unable to delete group")


def get_defaults(db: Session, *, lock: bool = False) -> AccessPolicyDefaults:
    try:
        statement = select(AccessPolicyDefaults).where(
            AccessPolicyDefaults.singleton_key == "workspace"
        )
        if lock:
            statement = statement.execution_options(populate_existing=True).with_for_update()
        row = db.scalar(statement)
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Access defaults not found",
        )
    return row


def default_link_ids(db: Session, defaults_id: UUID) -> tuple[list[UUID], list[UUID]]:
    try:
        group_query = (
            select(AccessDefaultGroup.group_id)
            .where(AccessDefaultGroup.policy_defaults_id == defaults_id)
            .order_by(AccessDefaultGroup.group_id)
        )
        department_query = (
            select(AccessDefaultDepartment.department_id)
            .where(AccessDefaultDepartment.policy_defaults_id == defaults_id)
            .order_by(AccessDefaultDepartment.department_id)
        )
        groups = list(db.scalars(group_query).all())
        departments = list(db.scalars(department_query).all())
        return groups, departments
    except SQLAlchemyError as error:
        raise unavailable(db) from error


def _active_ids(
    db: Session,
    model: type[AccessGroup] | type[Department],
    ids: tuple[UUID, ...],
) -> set[UUID]:
    if not ids:
        return set()
    return set(
        db.scalars(
            select(model.id)
            .where(model.id.in_(ids), model.is_deleted.is_(False))
            .order_by(model.id)
            .with_for_update()
        ).all()
    )


def load_creation_defaults(db: Session) -> CreationDefaults:
    try:
        defaults = get_defaults(db, lock=True)
        if defaults.is_deleted:
            raise ValueError("Access defaults are unavailable")
        role = db.scalar(
            select(Role)
            .where(
                Role.id == defaults.default_role_id,
                Role.is_deleted.is_(False),
                Role.role != UserRole.ADMIN.value,
            )
            .with_for_update()
        )
        group_ids, department_ids = default_link_ids(db, defaults.id)
        if not isinstance(role, Role):
            raise ValueError("Default role is unavailable")
        if _active_ids(db, AccessGroup, tuple(group_ids)) != set(group_ids):
            raise ValueError("Default group is unavailable")
        if _active_ids(db, Department, tuple(department_ids)) != set(department_ids):
            raise ValueError("Default department is unavailable")
        if not all(
            type(value) is int and 1 <= value <= 365
            for value in (defaults.invitation_expiry_days, defaults.guest_duration_days)
        ):
            raise ValueError("Default duration is invalid")
    except SQLAlchemyError as error:
        raise ValueError("Access defaults are unavailable") from error
    return CreationDefaults(
        role=role,
        group_ids=tuple(group_ids),
        department_ids=tuple(department_ids),
        invitation_expiry_days=defaults.invitation_expiry_days,
        guest_duration_days=defaults.guest_duration_days,
    )


def load_invitation_expiry_days(db: Session) -> int:
    """Lock and return the configured lifetime for a newly issued invitation token."""
    defaults = get_defaults(db, lock=True)
    value = defaults.invitation_expiry_days
    if defaults.is_deleted or type(value) is not int or not 1 <= value <= 365:
        raise ValueError("Invitation expiry default is unavailable")
    return value


def _replace_default_links(
    db: Session,
    defaults_id: UUID,
    desired_ids: list[UUID],
    link_model: type[AccessDefaultGroup] | type[AccessDefaultDepartment],
    target_model: type[AccessGroup] | type[Department],
    target_field: str,
    actor_id: UUID,
) -> bool:
    existing = list(
        db.scalars(
            select(link_model).where(link_model.policy_defaults_id == defaults_id).with_for_update()
        ).all()
    )
    desired = _unique_ids(desired_ids)
    existing_ids = {getattr(item, target_field) for item in existing}
    if _active_ids(db, target_model, desired) != set(desired):
        raise conflict("Default references must be active")
    if existing_ids == set(desired):
        return False
    for item in existing:
        if getattr(item, target_field) not in desired:
            db.delete(item)
    for item_id in desired:
        if item_id not in existing_ids:
            db.add(
                link_model(
                    policy_defaults_id=defaults_id, **{target_field: item_id}, performed_by=actor_id
                )
            )
    db.flush()
    return True


def _active_member_role(db: Session, role_id: UUID) -> None:
    role = db.scalar(
        select(Role)
        .where(Role.id == role_id, Role.is_deleted.is_(False), Role.role != UserRole.ADMIN.value)
        .with_for_update()
    )
    if role is None:
        raise conflict("Default role must be active and cannot be Administrator")


def update_defaults(
    db: Session, payload: AccessDefaultsUpdate, if_match: str | None, actor_id: UUID
) -> AccessPolicyDefaults:
    require_defaults_patch(payload)
    row = get_defaults(db, lock=True)
    require_match(if_match, defaults_etag(row))
    fields = payload.model_fields_set
    try:
        changed = False
        if "default_role_id" in fields:
            assert payload.default_role_id is not None
            _active_member_role(db, payload.default_role_id)
            if payload.default_role_id != row.default_role_id:
                row.default_role_id = payload.default_role_id
                changed = True
        if "group_ids" in fields:
            links_changed = _replace_default_links(
                db,
                row.id,
                payload.group_ids or [],
                AccessDefaultGroup,
                AccessGroup,
                "group_id",
                actor_id,
            )
            changed = links_changed or changed
        if "department_ids" in fields:
            links_changed = _replace_default_links(
                db,
                row.id,
                payload.department_ids or [],
                AccessDefaultDepartment,
                Department,
                "department_id",
                actor_id,
            )
            changed = links_changed or changed
        protected_and_duration_fields = {
            "invitation_expiry_days",
            "guest_duration_days",
            "service_duration_days",
            "default_deny",
            "require_guest_sponsor",
            "require_service_owner",
        }
        for field in protected_and_duration_fields & fields:
            value = getattr(payload, field)
            if value != getattr(row, field):
                setattr(row, field, value)
                changed = True
        if changed:
            row.revision += 1
            row.performed_by = actor_id
        commit(db, "Unable to update access defaults")
        db.refresh(row)
        return row
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        raise unavailable(db) from error
