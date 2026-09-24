"""Board-scoped file links; content audience is mandatory even for managers."""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.access.users.models import User
from app.systems.boards.access import can_access_board
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_service import (
    audience_clause,
    board_grants,
    displayed_revision,
    read_manager,
    revision_visible,
)
from app.systems.boards.announcement_work import cancel_announcement_work
from app.systems.boards.attachment_models import (
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import _audience_clause as event_audience_clause
from app.systems.boards.models import Board, BoardPermission
from app.systems.platform.files.access import authorize_board_file, error, load
from app.systems.platform.files.models import File


def _hidden() -> HTTPException:
    return error("file_not_found", "File not found", 404)


def _content(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    *,
    write: bool,
    lock: bool = False,
    published: bool = False,
) -> tuple[Board, BoardEvent | BoardAnnouncement]:
    board = authorize_board_file(db, actor, board_id, write=write, lock=lock)
    if kind == "event":
        event_statement = select(BoardEvent).where(
            BoardEvent.id == content_id,
            BoardEvent.board_id == board_id,
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
            event_audience_clause(actor),
        )
        if lock:
            event_statement = event_statement.with_for_update().execution_options(
                populate_existing=True
            )
        item: BoardEvent | BoardAnnouncement | None = db.scalar(event_statement)
    elif kind == "announcement":
        conditions = [
            BoardAnnouncement.id == content_id,
            BoardAnnouncement.board_id == board_id,
            BoardAnnouncement.is_deleted.is_(False),
            BoardAnnouncement.deleted_at.is_(None),
        ]
        if not published:
            conditions.append(audience_clause(BoardAnnouncement, actor))
        announcement_statement = select(BoardAnnouncement).where(*conditions)
        if lock:
            announcement_statement = announcement_statement.with_for_update().execution_options(
                populate_existing=True
            )
        item = db.scalar(announcement_statement)
    else:
        raise _hidden()
    if item is None:
        raise _hidden()
    if write:
        if isinstance(item, BoardEvent) and item.archived:
            raise error("event_archived", "Restore the event before attaching files")
        if isinstance(item, BoardAnnouncement) and item.status == "archived":
            raise error("announcement_archived", "Restore the announcement before attaching files")
        if item.author_id != actor.id:
            # The Board grant is checked separately; only a manager may edit
            # another author's content, and content audience still applies.
            if not can_access_board(board, actor, BoardPermission.MANAGE, board_grants(db, board)):
                raise _hidden()
    return board, item


def _displayed(
    db: Session, board: Board, item: BoardAnnouncement, actor: User
) -> BoardAnnouncementRevision:
    if item.status == "archived":
        raise _hidden()
    revision = displayed_revision(db, item)
    if revision is None or not revision_visible(db, revision, actor):
        raise _hidden()
    if (
        revision.expires_at is not None
        and revision.expires_at <= datetime.now(UTC)
        and item.author_id != actor.id
        and not read_manager(db, board, actor)
    ):
        raise _hidden()
    return revision


def _draft(db: Session, board: Board, item: BoardAnnouncement, actor: User) -> None:
    if item.status not in ("draft", "scheduled") or not (
        item.author_id == actor.id or read_manager(db, board, actor)
    ):
        raise _hidden()


def attachment_files(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    *,
    view: str = "published",
    limit: int = 100,
    offset: int = 0,
) -> list[File]:
    board, item = _content(
        db,
        actor,
        board_id,
        kind,
        content_id,
        write=False,
        published=kind == "announcement" and view == "published",
    )
    if kind == "announcement" and view == "published":
        assert isinstance(item, BoardAnnouncement)
        revision = _displayed(db, board, item, actor)
        links = select(BoardAnnouncementRevisionAttachment.file_id).where(
            BoardAnnouncementRevisionAttachment.revision_id == revision.id
        )
    else:
        if kind == "announcement":
            assert isinstance(item, BoardAnnouncement)
            _draft(db, board, item, actor)
        elif view != "current":
            raise _hidden()
        links = select(BoardContentAttachment.file_id).where(
            BoardContentAttachment.board_id == board_id,
            BoardContentAttachment.is_linked.is_(True),
            BoardContentAttachment.event_id == content_id
            if kind == "event"
            else BoardContentAttachment.announcement_id == content_id,
        )
    return list(
        db.scalars(
            select(File)
            .where(
                File.id.in_(links),
                File.board_id == board_id,
                File.purpose == "board_attachment",
                File.state == "ready",
                File.is_deleted.is_(False),
                File.deleted_at.is_(None),
            )
            .order_by(File.created_at, File.id)
            .limit(limit)
            .offset(offset)
        ).all()
    )


def visible_file(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    file_id: UUID,
    *,
    view: str,
) -> File:
    board, item = _content(
        db,
        actor,
        board_id,
        kind,
        content_id,
        write=False,
        published=kind == "announcement" and view == "published",
    )
    if kind == "announcement" and view == "published":
        assert isinstance(item, BoardAnnouncement)
        revision = _displayed(db, board, item, actor)
        link = db.scalar(
            select(BoardAnnouncementRevisionAttachment.id).where(
                BoardAnnouncementRevisionAttachment.revision_id == revision.id,
                BoardAnnouncementRevisionAttachment.file_id == file_id,
            )
        )
    else:
        if kind == "announcement":
            assert isinstance(item, BoardAnnouncement)
            _draft(db, board, item, actor)
        link = db.scalar(
            select(BoardContentAttachment.id).where(
                BoardContentAttachment.board_id == board_id,
                BoardContentAttachment.is_linked.is_(True),
                BoardContentAttachment.file_id == file_id,
                BoardContentAttachment.event_id == content_id
                if kind == "event"
                else BoardContentAttachment.announcement_id == content_id,
            )
        )
    if link is None:
        raise _hidden()
    file = load(db, file_id, active_parent=True)
    if (
        file.board_id != board_id
        or file.purpose != "board_attachment"
        or file.is_deleted
        or file.state != "ready"
    ):
        raise _hidden()
    return file


def link_file(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    file_id: UUID,
    *,
    board_revision: int,
    content_revision: int,
) -> File:
    board, item = _content(db, actor, board_id, kind, content_id, write=True, lock=True)
    revision = item.revision
    if board.revision != board_revision or revision != content_revision:
        raise error("stale_revision", "Board content changed; reload before attaching")
    file = load(db, file_id, active_parent=True, lock=True)
    if (
        file.board_id != board_id
        or file.purpose != "board_attachment"
        or file.state != "ready"
        or file.is_deleted
    ):
        raise _hidden()
    existing = db.scalar(
        select(BoardContentAttachment)
        .where(BoardContentAttachment.file_id == file_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if existing is not None:
        if (
            existing.board_id != board_id
            or existing.event_id != (content_id if kind == "event" else None)
            or existing.announcement_id != (content_id if kind == "announcement" else None)
        ):
            raise error("file_already_owned", "File already belongs to another content item")
        if existing.is_linked:
            return file
        existing.is_linked = True
    else:
        db.add(
            BoardContentAttachment(
                board_id=board_id,
                file_id=file_id,
                event_id=content_id if kind == "event" else None,
                announcement_id=content_id if kind == "announcement" else None,
            )
        )
    _content_changed(db, board, item)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise error("file_already_owned", "File already belongs to another content item") from exc
    return file


def unlink_file(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    file_id: UUID,
    *,
    board_revision: int,
    content_revision: int,
) -> None:
    board, item = _content(db, actor, board_id, kind, content_id, write=True, lock=True)
    if board.revision != board_revision or item.revision != content_revision:
        raise error("stale_revision", "Board content changed; reload before detaching")
    link = db.scalar(
        select(BoardContentAttachment)
        .where(
            BoardContentAttachment.board_id == board_id,
            BoardContentAttachment.file_id == file_id,
            BoardContentAttachment.event_id == content_id
            if kind == "event"
            else BoardContentAttachment.announcement_id == content_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if link is None or not link.is_linked:
        raise _hidden()
    link.is_linked = False
    _content_changed(db, board, item)
    db.commit()


def _content_changed(db: Session, board: Board, item: BoardEvent | BoardAnnouncement) -> None:
    item.revision += 1
    board.revision += 1
    if isinstance(item, BoardAnnouncement):
        item.status = "draft"
        item.publish_at = None
        cancel_announcement_work(db, item)


def delete_event_attachments(db: Session, event_id: UUID) -> None:
    rows = db.scalars(
        select(BoardContentAttachment)
        .where(BoardContentAttachment.event_id == event_id)
        .order_by(BoardContentAttachment.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()


def delete_announcement_attachments(db: Session, announcement_id: UUID) -> None:
    revision_ids = select(BoardAnnouncementRevision.id).where(
        BoardAnnouncementRevision.announcement_id == announcement_id
    )
    snapshots = db.scalars(
        select(BoardAnnouncementRevisionAttachment)
        .where(BoardAnnouncementRevisionAttachment.revision_id.in_(revision_ids))
        .order_by(BoardAnnouncementRevisionAttachment.id)
        .with_for_update()
    )
    for snapshot in snapshots:
        db.delete(snapshot)
    db.flush()
    rows = db.scalars(
        select(BoardContentAttachment)
        .where(BoardContentAttachment.announcement_id == announcement_id)
        .order_by(BoardContentAttachment.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()
