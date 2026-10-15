"""Board-scoped file links on posts and events."""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.access.users.models import User
from app.systems.boards.attachment_models import (
    BoardAttachment,
    BoardPostRevisionAttachment,
)
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_service import displayed_revision, manager
from app.systems.boards.post_work import cancel_post_work
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
) -> tuple[Board, BoardEvent | BoardPost]:
    board = authorize_board_file(db, actor, board_id, write=write, lock=lock)
    if kind == "event":
        event_statement = select(BoardEvent).where(
            BoardEvent.id == content_id,
            BoardEvent.board_id == board_id,
            BoardEvent.is_deleted.is_(False),
            BoardEvent.deleted_at.is_(None),
        )
        if lock:
            event_statement = event_statement.with_for_update().execution_options(
                populate_existing=True
            )
        item: BoardEvent | BoardPost | None = db.scalar(event_statement)
    elif kind == "post":
        post_statement = select(BoardPost).where(
            BoardPost.id == content_id,
            BoardPost.board_id == board_id,
            BoardPost.is_deleted.is_(False),
            BoardPost.deleted_at.is_(None),
        )
        if lock:
            post_statement = post_statement.with_for_update().execution_options(
                populate_existing=True
            )
        item = db.scalar(post_statement)
    else:
        raise _hidden()
    if item is None:
        raise _hidden()
    if write:
        if isinstance(item, BoardEvent) and item.archived:
            raise error("event_archived", "Restore the event before attaching files")
        if isinstance(item, BoardPost) and item.status == "archived":
            raise error("post_archived", "Restore the post before attaching files")
        if item.author_id != actor.id and not manager(db, board, actor):
            # Writers change their own content; only a manager changes another author's.
            raise _hidden()
    return board, item


def _displayed(db: Session, board: Board, item: BoardPost, actor: User) -> BoardPostRevision:
    if item.status == "archived":
        raise _hidden()
    revision = displayed_revision(db, item)
    if revision is None:
        raise _hidden()
    if (
        revision.expires_at is not None
        and revision.expires_at <= datetime.now(UTC)
        and item.author_id != actor.id
        and not manager(db, board, actor)
    ):
        raise _hidden()
    return revision


def _draft(db: Session, board: Board, item: BoardPost, actor: User) -> None:
    if item.status not in ("draft", "scheduled") or not (
        item.author_id == actor.id or manager(db, board, actor)
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
    )
    if kind == "post" and view == "published":
        assert isinstance(item, BoardPost)
        revision = _displayed(db, board, item, actor)
        links = select(BoardPostRevisionAttachment.file_id).where(
            BoardPostRevisionAttachment.revision_id == revision.id
        )
    else:
        if kind == "post":
            assert isinstance(item, BoardPost)
            _draft(db, board, item, actor)
        elif view != "current":
            raise _hidden()
        links = select(BoardAttachment.file_id).where(
            BoardAttachment.board_id == board_id,
            BoardAttachment.is_linked.is_(True),
            BoardAttachment.event_id == content_id
            if kind == "event"
            else BoardAttachment.post_id == content_id,
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
    )
    if kind == "post" and view == "published":
        assert isinstance(item, BoardPost)
        revision = _displayed(db, board, item, actor)
        link = db.scalar(
            select(BoardPostRevisionAttachment.id).where(
                BoardPostRevisionAttachment.revision_id == revision.id,
                BoardPostRevisionAttachment.file_id == file_id,
            )
        )
    else:
        if kind == "post":
            assert isinstance(item, BoardPost)
            _draft(db, board, item, actor)
        link = db.scalar(
            select(BoardAttachment.id).where(
                BoardAttachment.board_id == board_id,
                BoardAttachment.is_linked.is_(True),
                BoardAttachment.file_id == file_id,
                BoardAttachment.event_id == content_id
                if kind == "event"
                else BoardAttachment.post_id == content_id,
            )
        )
    if link is None:
        raise _hidden()
    file = load(db, file_id)
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
        select(BoardAttachment)
        .where(BoardAttachment.file_id == file_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if existing is not None:
        if (
            existing.board_id != board_id
            or existing.event_id != (content_id if kind == "event" else None)
            or existing.post_id != (content_id if kind == "post" else None)
        ):
            raise error("file_already_owned", "File already belongs to another content item")
        if existing.is_linked:
            return file
        existing.is_linked = True
    else:
        db.add(
            BoardAttachment(
                org_id=file.org_id,
                board_id=board_id,
                file_id=file_id,
                event_id=content_id if kind == "event" else None,
                post_id=content_id if kind == "post" else None,
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
        select(BoardAttachment)
        .where(
            BoardAttachment.board_id == board_id,
            BoardAttachment.file_id == file_id,
            BoardAttachment.event_id == content_id
            if kind == "event"
            else BoardAttachment.post_id == content_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if link is None or not link.is_linked:
        raise _hidden()
    link.is_linked = False
    _content_changed(db, board, item)
    db.commit()


def _content_changed(db: Session, board: Board, item: BoardEvent | BoardPost) -> None:
    item.revision += 1
    board.revision += 1
    if isinstance(item, BoardPost):
        item.status = "draft"
        item.publish_at = None
        cancel_post_work(db, item)


def delete_event_attachments(db: Session, event_id: UUID) -> None:
    rows = db.scalars(
        select(BoardAttachment)
        .where(BoardAttachment.event_id == event_id)
        .order_by(BoardAttachment.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()


def delete_post_attachments(db: Session, post_id: UUID) -> None:
    revision_ids = select(BoardPostRevision.id).where(
        BoardPostRevision.post_id == post_id
    )
    snapshots = db.scalars(
        select(BoardPostRevisionAttachment)
        .where(BoardPostRevisionAttachment.revision_id.in_(revision_ids))
        .order_by(BoardPostRevisionAttachment.id)
        .with_for_update()
    )
    for snapshot in snapshots:
        db.delete(snapshot)
    db.flush()
    rows = db.scalars(
        select(BoardAttachment)
        .where(BoardAttachment.post_id == post_id)
        .order_by(BoardAttachment.id)
        .with_for_update()
    )
    for row in rows:
        db.delete(row)
    db.flush()
