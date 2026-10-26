"""Owned Board rows included in a Department purge plan."""

from collections.abc import Callable
from typing import Any
from uuid import UUID

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.platform.files.models import File
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)

_DIRECT_CHILDREN: tuple[tuple[str, type[Any]], ...] = (
    ("board_groups", BoardGroup),
    ("board_events", BoardEvent),
    ("board_event_reminders", BoardEventReminder),
    ("board_posts", BoardPost),
    ("board_attachments", BoardAttachment),
    ("board_record_links", BoardRecordLink),
    ("files", File),
)

_EMPTY_IDS = {
    key: ()
    for key in (
        "boards",
        "board_groups",
        "board_events",
        "board_event_reminders",
        "board_posts",
        "board_attachments",
        "board_record_links",
        "board_files",
        "scheduled_work",
        "in_app_notifications",
        "board_post_revisions",
        "board_post_revision_attachments",
        "board_post_revision_record_links",
    )
}


def _state(
    entity_type: str,
    row: Any,
    fingerprint: Callable[[object], str],
) -> LifecycleRowState:
    state = LifecycleRowState(
        entity_type=entity_type,
        entity_id=row.id,
        is_deleted=getattr(row, "is_deleted", False),
        deleted_at=getattr(row, "deleted_at", None),
        updated_at=row.updated_at,
        state_fingerprint=fingerprint(
            {column.name: getattr(row, column.name) for column in row.__table__.columns}
        ),
    )
    if isinstance(row, File):
        state.byte_count = row.actual_size or row.expected_size
    return state


def _by_board(db: Session, model: type[Any], board_ids: tuple[UUID, ...]) -> list[Any]:
    if not board_ids:
        return []
    return list(
        db.scalars(select(model).where(model.board_id.in_(board_ids)).order_by(model.id)).all()
    )


def load_department_board_purge_dependencies(
    db: Session,
    department_ids: list[UUID],
    departments_by_id: dict[UUID, Department],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]]]:
    """Inventory each Department Board's retained graph without touching File bytes."""

    boards = (
        list(
            db.scalars(
                select(Board).where(Board.department_id.in_(department_ids)).order_by(Board.id)
            ).all()
        )
        if department_ids
        else []
    )
    if not boards:
        return [], [], dict(_EMPTY_IDS)

    board_ids = tuple(board.id for board in boards)
    rows = [_state("boards", board, fingerprint) for board in boards]
    children: dict[str, list[Any]] = {}
    for entity_type, model in _DIRECT_CHILDREN:
        children[entity_type] = _by_board(db, model, board_ids)
        rows.extend(_state(entity_type, row, fingerprint) for row in children[entity_type])

    post_ids = tuple(row.id for row in children["board_posts"])
    reminder_ids = tuple(row.id for row in children["board_event_reminders"])
    work_filters = []
    if post_ids:
        work_filters.append(
            and_(ScheduledWork.kind == WorkKind.POST_PUBLISH, ScheduledWork.post_id.in_(post_ids))
        )
    if reminder_ids:
        work_filters.append(
            and_(
                ScheduledWork.kind == WorkKind.EVENT_REMINDER,
                ScheduledWork.reminder_id.in_(reminder_ids),
            )
        )
    work = (
        list(
            db.scalars(
                select(ScheduledWork).where(or_(*work_filters)).order_by(ScheduledWork.id)
            ).all()
        )
        if work_filters
        else []
    )
    rows.extend(_state("scheduled_work", row, fingerprint) for row in work)
    work_ids = tuple(row.id for row in work)
    notifications = (
        list(
            db.scalars(
                select(InAppNotification)
                .where(InAppNotification.work_id.in_(work_ids))
                .order_by(InAppNotification.id)
            ).all()
        )
        if work_ids
        else []
    )
    rows.extend(_state("in_app_notifications", row, fingerprint) for row in notifications)

    revisions = (
        list(
            db.scalars(
                select(BoardPostRevision)
                .where(BoardPostRevision.post_id.in_(post_ids))
                .order_by(BoardPostRevision.post_id, BoardPostRevision.id)
            ).all()
        )
        if post_ids
        else []
    )
    rows.extend(_state("board_post_revisions", row, fingerprint) for row in revisions)
    revision_ids = tuple(row.id for row in revisions)
    revision_attachments = (
        list(
            db.scalars(
                select(BoardPostRevisionAttachment)
                .where(BoardPostRevisionAttachment.revision_id.in_(revision_ids))
                .order_by(BoardPostRevisionAttachment.id)
            ).all()
        )
        if revision_ids
        else []
    )
    revision_links = (
        list(
            db.scalars(
                select(BoardPostRevisionRecordLink)
                .where(BoardPostRevisionRecordLink.revision_id.in_(revision_ids))
                .order_by(BoardPostRevisionRecordLink.id)
            ).all()
        )
        if revision_ids
        else []
    )
    rows.extend(
        _state("board_post_revision_attachments", row, fingerprint) for row in revision_attachments
    )
    rows.extend(
        _state("board_post_revision_record_links", row, fingerprint) for row in revision_links
    )

    departments_by_board = {
        board.id: (
            departments_by_id.get(board.department_id) if board.department_id is not None else None
        )
        for board in boards
    }
    blockers: list[LifecycleBlocker] = []
    for file in children["files"]:
        if file.state == "purged":
            continue
        department = departments_by_board[file.board_id]
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_FILE_DEPENDENCY,
                entity_type="files",
                entity_id=file.id,
                detail=(
                    "Purge every attached Board file and confirm object deletion "
                    "before purging the Department"
                ),
                conflicting_entity_type="boards",
                conflicting_entity_id=file.board_id,
                department_id=department.id if department is not None else None,
                department_name=(department.department_name if department is not None else None),
            )
        )

    ids: dict[str, tuple[UUID, ...]] = {
        "boards": board_ids,
        "board_groups": tuple(row.id for row in children["board_groups"]),
        "board_events": tuple(row.id for row in children["board_events"]),
        "board_event_reminders": reminder_ids,
        "board_posts": post_ids,
        "board_attachments": tuple(row.id for row in children["board_attachments"]),
        "board_record_links": tuple(row.id for row in children["board_record_links"]),
        "board_files": tuple(row.id for row in children["files"]),
        "scheduled_work": work_ids,
        "in_app_notifications": tuple(row.id for row in notifications),
        "board_post_revisions": revision_ids,
        "board_post_revision_attachments": tuple(row.id for row in revision_attachments),
        "board_post_revision_record_links": tuple(row.id for row in revision_links),
    }
    return rows, blockers, ids
