"""File authorization and canonical parent-before-file lock ordering."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.policy.checks import module_level
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import includes
from app.systems.access.users.eligibility import is_active_account, is_established_user
from app.systems.access.users.models import User, UserRole
from app.systems.boards.access import can_access_board
from app.systems.boards.attachment_models import (
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.boards.models import Board, BoardGrant, BoardPermission, BoardStatus
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def error(code: str, message: str, status: int = 409) -> HTTPException:
    return HTTPException(
        status, detail={"code": code, "message": message},
        headers={"Cache-Control": "no-store"},
    )


def authorize(
    db: Session,
    user: User,
    purpose: str,
    *,
    write: bool = False,
    record_id: UUID | None = None,
) -> User:
    """Authorize a file action before acquiring parent or inventory locks.

    A record attachment follows its record's module: read to see it, write to
    change it. A record the user cannot read is reported as missing. Other file
    purposes are administrator-only.
    """

    if purpose not in {"record_attachment", "library_document", "workspace_logo"}:
        raise error("forbidden", "Forbidden", 403)
    if not is_active_account(user):
        raise error("forbidden", "Forbidden", 403)
    if purpose == "record_attachment":
        # A guest reads at most, so it never changes an attachment.
        if write and user.role == UserRole.GUEST.value:
            raise error("forbidden", "Forbidden", 403)
        if record_id is None:
            return user
        record = db.get(Record, record_id)
        granted = None if record is None else module_level(db, user, record.module_id)
        if granted is None:
            raise error("file_not_found", "File parent not found", 404)
        if write and not includes(granted, AccessLevel.WRITE):
            raise error("forbidden", "Forbidden", 403)
        return user
    if user.role != UserRole.ADMIN.value:
        raise error("forbidden", "Forbidden", 403)
    return user


def fresh_user(db: Session, actor_id: UUID) -> User:
    user = db.scalar(
        select(User)
        .where(User.id == actor_id)
        .execution_options(populate_existing=True)
    )
    if (
        user is None
        or user.is_deleted
        or not is_identity_eligible(user)
        or user.status != "active"
        or not is_established_user(user)
    ):
        raise error("forbidden", "Forbidden", 403)
    return user


def board_parent(
    db: Session, board_id: UUID | None, *, active: bool, lock: bool = False,
    shared_lock: bool = False,
) -> Board:
    if board_id is None:
        raise error("file_not_found", "File parent not found", 404)
    statement = select(Board).where(Board.id == board_id)
    if lock:
        statement = statement.with_for_update(nowait=True, read=shared_lock)
    board = db.scalar(statement.execution_options(populate_existing=True))
    if board is None:
        raise error("file_not_found", "File parent not found", 404)
    if board.is_deleted or board.deleted_at is not None:
        raise error("file_parent_closed", "File parent is not active")
    if active and board.status != BoardStatus.ACTIVE:
        raise error("file_parent_closed", "File parent is not active")
    return board


def authorize_board_file(
    db: Session, user: User, board_id: UUID, *, write: bool,
    lock: bool = False,
) -> Board:
    """A Board-scoped grant, never the generic file-purpose capability."""
    if not is_established_user(user):
        raise error("file_not_found", "File not found", 404)
    board = board_parent(db, board_id, active=write, lock=lock)
    grants = db.scalars(
        select(BoardGrant).where(
            BoardGrant.board_id == board_id,
            BoardGrant.is_deleted.is_(False),
            BoardGrant.deleted_at.is_(None),
        )
    ).all()
    action = BoardPermission.EDIT if write else BoardPermission.VIEW
    if not can_access_board(board, user, action, grants):
        raise error("file_not_found", "File not found", 404)
    return board


def authorize_contextual_file(
    db: Session, user: User, file: File, *, board_id: UUID | None, write: bool,
) -> None:
    if file.purpose == "board_attachment":
        if board_id is None or file.board_id != board_id:
            raise error("file_not_found", "File not found", 404)
        authorize_board_file(db, user, board_id, write=write)
    elif board_id is not None:
        raise error("file_not_found", "File not found", 404)
    else:
        authorize(db, user, file.purpose, write=write, record_id=file.record_id)


def require_unlinked(db: Session, file_id: UUID) -> None:
    active_link = db.scalar(
        select(BoardContentAttachment.id).where(
            BoardContentAttachment.file_id == file_id,
            BoardContentAttachment.is_linked.is_(True),
        ).limit(1)
    )
    published_link = db.scalar(
        select(BoardAnnouncementRevisionAttachment.id).where(
            BoardAnnouncementRevisionAttachment.file_id == file_id
        ).limit(1)
    )
    if active_link is not None or published_link is not None:
        raise error("file_linked", "Detach the file from content before purging")


def parent(
    db: Session,
    record_id: UUID | None,
    *,
    active: bool,
    lock: bool = False,
    shared_lock: bool = False,
    board_id: UUID | None = None,
) -> None:
    if board_id is not None:
        board_parent(db, board_id, active=active, lock=lock, shared_lock=shared_lock)
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
    parent(
        db, file.record_id, active=active_parent, lock=lock, shared_lock=shared_lock,
        board_id=file.board_id,
    )
    if lock:
        db.refresh(file, with_for_update={"nowait": True, "read": shared_lock})
    return file
