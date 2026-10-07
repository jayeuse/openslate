from collections.abc import Iterable
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.access_notifications import (
    lock_access_recipients,
    notify_access_changes,
)
from app.systems.access.policy.models import AccessLevel, Group, GroupAccess, GroupMember
from app.systems.access.policy.schemas import (
    GroupAccessEntry,
    GroupAccessResponse,
    GroupCreate,
    GroupUpdate,
)
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module


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


def _require_patch(payload: GroupUpdate) -> None:
    if not payload.model_fields_set or any(
        getattr(payload, field) is None for field in payload.model_fields_set
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Fields cannot be null",
        )


def require_group_patch(payload: GroupUpdate) -> None:
    _require_patch(payload)


def group_etag(row: Group) -> str:
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


def get_group(db: Session, group_id: UUID) -> Group:
    try:
        row = db.get(Group, group_id)
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return row


def lock_group(db: Session, group_id: UUID) -> Group:
    try:
        row = db.scalar(
            select(Group)
            .where(Group.id == group_id)
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
                select(GroupMember.user_id)
                .where(GroupMember.group_id == group_id)
                .order_by(GroupMember.user_id)
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
            select(GroupMember.group_id, GroupMember.user_id)
            .where(GroupMember.group_id.in_(ids))
            .order_by(GroupMember.group_id, GroupMember.user_id)
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
            or_(User.expires_at.is_(None), User.expires_at > datetime.now(UTC)),
        )
        .order_by(User.id)
        .with_for_update()
    ).all()
    return {row.id for row in rows}


def _pending_users(db: Session, user_ids: set[UUID]) -> set[UUID]:
    if not user_ids:
        return set()
    rows = db.scalars(
        select(User)
        .where(
            User.id.in_(user_ids),
            User.is_deleted.is_(False),
            User.status == UserStatus.PENDING.value,
            or_(User.expires_at.is_(None), User.expires_at > datetime.now(UTC)),
        )
        .order_by(User.id)
        .with_for_update()
    ).all()
    return {row.id for row in rows}


def replace_group_members(
    db: Session,
    row: Group,
    member_ids: list[UUID],
    actor_id: UUID,
) -> bool:
    existing = list(
        db.scalars(
            select(GroupMember)
            .where(GroupMember.group_id == row.id)
            .order_by(GroupMember.user_id)
            .with_for_update()
        ).all()
    )
    desired = _unique_ids(member_ids)
    existing_ids = {item.user_id for item in existing}
    added_ids = set(desired) - existing_ids
    # Lock every desired user as before; only new members must be usable. A member
    # who became disabled or expired may stay so the rest of the list can be saved.
    inactive_ids = set(desired) - _active_users(db, desired)
    if (inactive_ids - _pending_users(db, inactive_ids)) & added_ids:
        raise conflict("New members must be active or pending, unexpired users")
    if added_ids and db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.id.in_(added_ids), User.role == UserRole.ADMIN.value)
    ):
        raise conflict("Administrators have access everywhere and are not group members")
    if existing_ids == set(desired):
        return False
    before = lock_access_recipients(db, existing_ids ^ set(desired))
    for item in existing:
        if item.user_id not in desired:
            db.delete(item)
    for user_id in desired:
        if user_id not in existing_ids:
            db.add(GroupMember(group_id=row.id, user_id=user_id, performed_by=actor_id))
    db.flush()
    notify_access_changes(db, before)
    return True


def create_group(db: Session, payload: GroupCreate, actor_id: UUID) -> Group:
    try:
        row = Group(name=payload.name, description=payload.description, performed_by=actor_id)
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
    payload: GroupUpdate,
    if_match: str | None,
    actor_id: UUID,
) -> Group:
    require_group_patch(payload)
    row = lock_group(db, group_id)
    if row.is_deleted:
        raise conflict("Group is deleted")
    require_match(if_match, group_etag(row))
    try:
        changed = False
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


def ensure_group_deletable(db: Session, row: Group) -> None:
    try:
        has_members = db.scalar(
            select(func.count()).select_from(GroupMember).where(GroupMember.group_id == row.id)
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    if has_members:
        raise conflict("Group has members")


def delete_group(db: Session, group_id: UUID, if_match: str | None, actor_id: UUID) -> None:
    row = lock_group(db, group_id)
    if row.is_deleted:
        raise conflict("Group is already deleted")
    require_match(if_match, group_etag(row))
    ensure_group_deletable(db, row)
    for grant in locked_access(db, row.id):
        db.delete(grant)
    row.is_deleted = True
    row.deleted_at = utc_now()
    row.revision += 1
    row.performed_by = actor_id
    commit(db, "Unable to delete group")


def locked_access(db: Session, group_id: UUID) -> list[GroupAccess]:
    return list(
        db.scalars(
            select(GroupAccess)
            .where(GroupAccess.group_id == group_id, GroupAccess.is_deleted.is_(False))
            .order_by(GroupAccess.id)
            .with_for_update()
        ).all()
    )


def group_access_map(
    db: Session, group_ids: Iterable[UUID]
) -> dict[UUID, list[GroupAccessResponse]]:
    result: dict[UUID, list[GroupAccessResponse]] = {}
    ids = tuple(group_ids)
    if not ids:
        return result
    try:
        rows = (
            db.execute(
                select(GroupAccess, Department.department_name, Module.module_name)
                .join(Department, Department.id == GroupAccess.department_id)
                .outerjoin(Module, Module.id == GroupAccess.module_id)
                .where(GroupAccess.group_id.in_(ids), GroupAccess.is_deleted.is_(False))
                .order_by(GroupAccess.group_id, GroupAccess.department_id, GroupAccess.module_id)
            )
            .tuples()
            .all()
        )
    except SQLAlchemyError as error:
        raise unavailable(db) from error
    for row, department_name, module_name in rows:
        result.setdefault(row.group_id, []).append(
            GroupAccessResponse(
                department_id=row.department_id,
                department_name=department_name,
                module_id=row.module_id,
                module_name=module_name,
                level=AccessLevel(row.level),
            )
        )
    return result


def _validate_access_targets(db: Session, entries: list[GroupAccessEntry]) -> None:
    """Every department must exist, and every module must belong to its department."""

    keys = [(entry.department_id, entry.module_id) for entry in entries]
    if len(set(keys)) != len(keys):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Each department and module can appear only once",
        )
    department_ids = {entry.department_id for entry in entries}
    module_ids = {entry.module_id for entry in entries if entry.module_id is not None}
    found_departments = set(
        db.scalars(
            select(Department.id).where(Department.id.in_(department_ids)).with_for_update()
        ).all()
        if department_ids
        else ()
    )
    if found_departments != department_ids:
        raise conflict("Department does not exist")
    module_departments = {
        module_id: department_id
        for module_id, department_id in (
            db.execute(
                select(Module.id, Module.department_id)
                .where(Module.id.in_(module_ids))
                .with_for_update()
            ).tuples()
            if module_ids
            else ()
        )
    }
    for entry in entries:
        if entry.module_id is not None and (
            module_departments.get(entry.module_id) != entry.department_id
        ):
            raise conflict("Module does not belong to the department")


def replace_group_access(
    db: Session,
    group_id: UUID,
    entries: list[GroupAccessEntry],
    if_match: str | None,
    actor_id: UUID,
) -> Group:
    """Replace every access row of one group under its current version."""

    row = lock_group(db, group_id)
    try:
        if row.is_deleted:
            raise conflict("Group is deleted")
        require_match(if_match, group_etag(row))
        _validate_access_targets(db, entries)
        existing = {
            (item.department_id, item.module_id): item for item in locked_access(db, row.id)
        }
        desired = {(entry.department_id, entry.module_id): entry.level.value for entry in entries}
        before = lock_access_recipients(db, set(group_member_ids(db, row.id)))
        changed = False
        for key, item in existing.items():
            if key not in desired:
                db.delete(item)
                changed = True
            elif item.level != desired[key]:
                item.level = desired[key]
                item.performed_by = actor_id
                changed = True
        db.flush()
        for (department_id, module_id), level in desired.items():
            if (department_id, module_id) not in existing:
                db.add(
                    GroupAccess(
                        group_id=row.id,
                        department_id=department_id,
                        module_id=module_id,
                        level=level,
                        performed_by=actor_id,
                    )
                )
                changed = True
        if changed:
            row.revision += 1
            row.performed_by = actor_id
        notify_access_changes(db, before)
        commit(db, "Unable to change group access")
        db.refresh(row)
        return row
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        raise unavailable(db) from error
