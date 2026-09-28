"""Contextual Record shortcuts without copying source Record data."""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.policy.checks import module_filter, module_level
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.attachment_service import (
    _content,
    _content_changed,
    _displayed,
    _draft,
    _hidden,
)
from app.systems.boards.post_models import BoardPost
from app.systems.boards.record_link_models import (
    BoardPostRevisionRecordLink,
    BoardRecordLink,
)
from app.systems.platform.files.access import error
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def _owner_filter(kind: str, content_id: UUID) -> ColumnElement[bool]:
    return (
        BoardRecordLink.event_id == content_id
        if kind == "event"
        else BoardRecordLink.post_id == content_id
    )


def _available_record(db: Session, actor: User, record_id: UUID) -> Record:
    """A record the actor cannot read is unavailable, the same as a missing one."""
    module_id = db.scalar(select(Record.module_id).where(Record.id == record_id))
    if module_id is None or module_level(db, actor, module_id) is None:
        raise error("record_unavailable", "The selected Record is unavailable", 409)
    module = db.scalar(
        select(Module)
        .where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
        .with_for_update()
    )
    record = db.scalar(
        select(Record)
        .where(
            Record.id == record_id,
            Record.module_id == module_id,
            Record.is_deleted.is_(False),
            Record.deleted_at.is_(None),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if module is None or record is None:
        raise error("record_unavailable", "The selected Record is unavailable", 409)
    return record


def listed_links(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    *,
    view: str,
    limit: int,
    offset: int,
) -> tuple[list[BoardRecordLink | BoardPostRevisionRecordLink], dict[UUID, UUID]]:
    board, item = _content(
        db,
        actor,
        board_id,
        kind,
        content_id,
        write=False,
    )
    if kind == "post" and view == "published":
        assert isinstance(item, BoardPost)
        revision = _displayed(db, board, item, actor)
        links: list[BoardRecordLink | BoardPostRevisionRecordLink] = list(
            db.scalars(
                select(BoardPostRevisionRecordLink)
                .where(BoardPostRevisionRecordLink.revision_id == revision.id)
                .order_by(
                    BoardPostRevisionRecordLink.created_at,
                    BoardPostRevisionRecordLink.id,
                )
                .limit(limit)
                .offset(offset)
            )
        )
    else:
        if kind == "post":
            assert isinstance(item, BoardPost)
            _draft(db, board, item, actor)
        elif view != "current":
            raise _hidden()
        links = list(
            db.scalars(
                select(BoardRecordLink)
                .where(
                    BoardRecordLink.board_id == board_id,
                    _owner_filter(kind, content_id),
                )
                .order_by(BoardRecordLink.created_at, BoardRecordLink.id)
                .limit(limit)
                .offset(offset)
            )
        )
    record_ids = [link.record_id for link in links]
    active: dict[UUID, UUID] = (
        {
            record_id: module_id
            for record_id, module_id in db.execute(
                select(Record.id, Record.module_id)
                .join(Module, Module.id == Record.module_id)
                .where(
                    Record.id.in_(record_ids),
                    Record.is_deleted.is_(False),
                    Record.deleted_at.is_(None),
                    Module.is_deleted.is_(False),
                    Module.deleted_at.is_(None),
                    module_filter(db, actor, AccessLevel.READ, Record.module_id),
                )
            ).all()
        }
        if record_ids
        else {}
    )
    return links, active


def link_record(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    record_id: UUID,
    label: str,
    *,
    board_revision: int,
    content_revision: int,
) -> BoardRecordLink:
    board, item = _content(db, actor, board_id, kind, content_id, write=True, lock=True)
    if board.revision != board_revision or item.revision != content_revision:
        raise error("stale_revision", "Board content changed; reload before linking")
    count = db.scalar(
        select(func.count(BoardRecordLink.id)).where(
            BoardRecordLink.board_id == board_id, _owner_filter(kind, content_id)
        )
    )
    if count is not None and count >= 20:
        raise error("record_link_limit", "Board content supports at most 20 Record links")
    existing = db.scalar(
        select(BoardRecordLink.id).where(
            _owner_filter(kind, content_id), BoardRecordLink.record_id == record_id
        )
    )
    if existing is not None:
        raise error("record_link_exists", "Record is already linked to this content")
    record = _available_record(db, actor, record_id)
    link = BoardRecordLink(
        board_id=board_id,
        event_id=content_id if kind == "event" else None,
        post_id=content_id if kind == "post" else None,
        record_id=record.id,
        module_id=record.module_id,
        label=label,
    )
    db.add(link)
    _content_changed(db, board, item)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise error("record_link_invalid", "Record link changed; reload before linking") from exc
    return link


def unlink_record(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    link_id: UUID,
    *,
    board_revision: int,
    content_revision: int,
) -> None:
    board, item = _content(db, actor, board_id, kind, content_id, write=True, lock=True)
    if board.revision != board_revision or item.revision != content_revision:
        raise error("stale_revision", "Board content changed; reload before unlinking")
    link = db.scalar(
        select(BoardRecordLink)
        .where(
            BoardRecordLink.id == link_id,
            BoardRecordLink.board_id == board_id,
            _owner_filter(kind, content_id),
        )
        .with_for_update()
    )
    if link is None:
        raise _hidden()
    db.delete(link)
    _content_changed(db, board, item)
    db.commit()


def delete_content_links(db: Session, kind: str, content_id: UUID) -> None:
    rows = db.scalars(
        select(BoardRecordLink)
        .where(_owner_filter(kind, content_id))
        .order_by(BoardRecordLink.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()


def delete_revision_links(db: Session, revision_ids: list[UUID]) -> None:
    if not revision_ids:
        return
    rows = db.scalars(
        select(BoardPostRevisionRecordLink)
        .where(BoardPostRevisionRecordLink.revision_id.in_(revision_ids))
        .order_by(BoardPostRevisionRecordLink.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()
