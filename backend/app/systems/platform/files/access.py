"""File authorization and canonical parent-before-file lock ordering."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.systems.access.policy.authorization import authorize_workspace_capabilities
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def error(code: str, message: str, status: int = 409) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def authorize(db: Session, user: User, purpose: str, *, write: bool = False) -> User:
    """Authorize a file action before acquiring parent or inventory locks."""

    if purpose not in {"record_attachment", "library_document", "workspace_logo"}:
        raise error("forbidden", "Forbidden", 403)
    if purpose == "record_attachment":
        capability = Capability.RECORDS_WRITE if write else Capability.RECORDS_READ
        return authorize_workspace_capabilities(
            db,
            actor_id=user.id,
            expected_role_id=user.role_id,
            capabilities=(capability,),
        )
    if (
        user.is_deleted
        or user.status != "active"
        or not is_established_user(user)
        or user.role is None
        or user.role.is_deleted
    ):
        raise error("forbidden", "Forbidden", 403)
    if user.role.role != "admin":
        raise error("forbidden", "Forbidden", 403)
    return user


def fresh_user(db: Session, actor_id: UUID) -> User:
    user = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == actor_id)
        .execution_options(populate_existing=True)
    )
    if (
        user is None
        or user.is_deleted
        or user.status != "active"
        or not is_established_user(user)
        or user.role is None
        or user.role.is_deleted
    ):
        raise error("forbidden", "Forbidden", 403)
    return user


def parent(
    db: Session,
    record_id: UUID | None,
    *,
    active: bool,
    lock: bool = False,
    shared_lock: bool = False,
) -> None:
    if record_id is None:
        return
    record = db.get(Record, record_id)
    if record is None:
        raise error("file_not_found", "File parent not found", 404)
    module = db.get(Module, record.module_id)
    if module is None:
        raise error("file_not_found", "File parent not found", 404)
    department = db.get(Department, module.department_id)
    if lock:
        # Lifecycle orders ancestors before descendants. NOWAIT makes contention bounded.
        for item in (department, module, record):
            if item is not None:
                db.refresh(item, with_for_update={"nowait": True, "read": shared_lock})
    if (
        department is None
        or active
        and any(item.is_deleted for item in (department, module, record))
    ):
        raise error("file_parent_closed", "File parent is not active")


def load(
    db: Session,
    file_id: UUID,
    *,
    active_parent: bool = False,
    lock: bool = False,
    shared_lock: bool = False,
) -> File:
    file = db.get(File, file_id)
    if file is None:
        raise error("file_not_found", "File not found", 404)
    parent(db, file.record_id, active=active_parent, lock=lock, shared_lock=shared_lock)
    if lock:
        db.refresh(file, with_for_update={"nowait": True, "read": shared_lock})
    return file
