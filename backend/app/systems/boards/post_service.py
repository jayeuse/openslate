"""Post reads, and ordered, multi-row publication coordination."""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, true
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.access import has_level
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.post_inbox import stage_publication_inbox
from app.systems.boards.post_models import (
    BoardPost,
    BoardPostRevision,
    publication_content_fingerprint,
)
from app.systems.boards.post_schemas import (
    PostContent,
    PostMutationResponse,
    PostPublicationResponse,
    PostResponse,
)
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.manage.audit.context import set_audit_actor
from app.systems.platform.scheduling.models import ScheduledWork


def manager(db: Session, board: Board, actor: User) -> bool:
    """Managers pin posts and change or archive the posts of other users."""

    return has_level(db, actor, board, AccessLevel.MANAGE)


def set_content(item: BoardPost, content: PostContent) -> None:
    item.title, item.body = content.title, content.body
    item.links = [link.model_dump() for link in content.links]
    item.expires_at, item.pinned = content.expires_at, content.pinned


def current_content(item: BoardPost) -> PostContent:
    return PostContent(
        title=item.title,
        body=item.body,
        links=item.links,
        expires_at=item.expires_at.astimezone(UTC) if item.expires_at else None,
        pinned=item.pinned,
    )


def fingerprint(
    item: BoardPost,
    attachment_file_ids: list[UUID] | None = None,
    record_links: list[tuple[UUID, UUID]] | None = None,
) -> str:
    return publication_content_fingerprint(
        author_id=item.author_id,
        title=item.title,
        body=item.body,
        links=item.links,
        expires_at=item.expires_at,
        attachment_file_ids=attachment_file_ids,
        record_links=record_links,
    )


def published_result(revision: BoardPostRevision) -> PostPublicationResponse:
    return PostPublicationResponse(
        id=revision.id,
        post_id=revision.post_id,
        publication_number=revision.publication_number,
        publication_key=revision.publication_key,
        published_at=revision.published_at.astimezone(UTC),
    )


def publish_locked(
    db: Session,
    board: Board,
    item: BoardPost,
    actor: User,
    *,
    publication_key: UUID,
    published_at: datetime,
    board_revision: int,
    post_revision: int,
    scheduled_work: ScheduledWork | None = None,
) -> BoardPostRevision:
    """Stage publication after the caller locks Board then post and authorizes the actor.

    The caller owns commit/rollback. Identical-key retries return their existing revision
    before stale-version checks, matching the manual publication contract.
    """
    if (
        item.board_id != board.id
        or board.is_deleted
        or board.deleted_at is not None
        or item.is_deleted
        or item.deleted_at is not None
    ):
        raise not_found()
    if board.status != BoardStatus.ACTIVE or item.status == "archived":
        raise conflict("post_unavailable", "Restore before publishing")
    attachment_file_ids = list(
        db.scalars(
            select(BoardAttachment.file_id)
            .where(
                BoardAttachment.post_id == item.id,
                BoardAttachment.is_linked.is_(True),
            )
            .order_by(BoardAttachment.file_id)
            .with_for_update()
        )
    )
    current_record_links = list(
        db.scalars(
            select(BoardRecordLink)
            .where(BoardRecordLink.post_id == item.id)
            .order_by(BoardRecordLink.id)
            .with_for_update()
        )
    )
    content_fingerprint = fingerprint(
        item,
        attachment_file_ids,
        [(link.record_id, link.module_id) for link in current_record_links],
    )
    prior = db.scalar(
        select(BoardPostRevision)
        .where(
            BoardPostRevision.post_id == item.id,
            BoardPostRevision.publication_key == publication_key,
        )
        .with_for_update()
    )
    if prior is not None:
        if prior.content_fingerprint != content_fingerprint or prior.performed_by != actor.id:
            raise conflict(
                "publication_key_conflict", "Publication key was used for different content"
            )
        return prior
    check_board(board, board_revision)
    check_post(item, post_revision)
    if item.expires_at is not None and item.expires_at <= published_at:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "post_expired",
                "message": "Expiration must follow publication",
            },
        )
    number = (
        int(
            db.scalar(
                select(func.max(BoardPostRevision.publication_number)).where(
                    BoardPostRevision.post_id == item.id,
                )
            )
            or 0
        )
        + 1
    )
    published = BoardPostRevision(
        id=uuid7(),
        post_id=item.id,
        publication_number=number,
        publication_key=publication_key,
        content_fingerprint=content_fingerprint,
        author_id=item.author_id,
        title=item.title,
        body=item.body,
        links=[dict(link) for link in item.links],
        published_at=published_at,
        expires_at=item.expires_at,
    )
    set_audit_actor(db, actor.id)
    db.add(published)
    # The snapshot tables have no relationship() to order their inserts, and their
    # triggers read this revision, so it must reach the database first.
    db.flush()
    for file_id in attachment_file_ids:
        db.add(BoardPostRevisionAttachment(revision_id=published.id, file_id=file_id))
    for link in current_record_links:
        db.add(
            BoardPostRevisionRecordLink(
                revision_id=published.id,
                record_id=link.record_id,
                module_id=link.module_id,
            )
        )
    item.status, item.publish_at = "published", published_at
    item.displayed_publication_number = number
    item.revision += 1
    board.revision += 1
    stage_publication_inbox(
        db,
        board,
        item,
        actor,
        published,
        source_revision=post_revision,
        published_at=published_at,
        scheduled_work=scheduled_work,
    )
    return published


def published_expiry(actor: User, is_manager: bool, now: datetime) -> ColumnElement[bool]:
    if is_manager:
        return true()
    return or_(
        BoardPostRevision.expires_at.is_(None),
        BoardPostRevision.expires_at > now,
        BoardPost.author_id == actor.id,
    )


def conflict(code: str, message: str, current_revision: int | None = None) -> HTTPException:
    detail: dict[str, str | int] = {"code": code, "message": message}
    if current_revision is not None:
        detail["current_revision"] = current_revision
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


def not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Board post not found")


def post(db: Session, board_id: UUID, post_id: UUID, *, lock: bool = False) -> BoardPost:
    statement = select(BoardPost).where(
        BoardPost.id == post_id,
        BoardPost.board_id == board_id,
        BoardPost.is_deleted.is_(False),
        BoardPost.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(statement)
    if found is None:
        raise not_found()
    return found


def displayed_revision(
    db: Session, item: BoardPost, *, lock: bool = False
) -> BoardPostRevision | None:
    number = item.displayed_publication_number
    if number is None:
        return None
    statement = select(BoardPostRevision).where(
        BoardPostRevision.post_id == item.id,
        BoardPostRevision.publication_number == number,
        BoardPostRevision.is_deleted.is_(False),
        BoardPostRevision.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    revision = db.scalar(statement)
    if revision is None:
        raise conflict("publication_invalid", "The displayed publication is unavailable")
    return revision


def actionable(
    db: Session, board: Board, post_id: UUID, actor: User
) -> tuple[BoardPost, BoardPostRevision | None]:
    """Lock a post the actor may change: their own, or any post for a manager.

    Call only after taking the Board FOR UPDATE lock; then lock child and snapshot.
    """
    item = post(db, board.id, post_id, lock=True)
    if item.author_id != actor.id and not manager(db, board, actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required")
    return item, displayed_revision(db, item, lock=True)


def check_board(board: Board, revision: int) -> None:
    if board.revision != revision:
        raise conflict(
            "stale_board_revision", "Board changed; reload before saving", board.revision
        )
    if board.status != BoardStatus.ACTIVE:
        raise conflict("board_archived", "Restore the Board before changing posts")


def check_post(item: BoardPost, revision: int) -> None:
    if item.revision != revision:
        raise conflict(
            "stale_post_revision",
            "Post changed; reload before saving",
            item.revision,
        )


def commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict("post_conflict", "Unable to save Board post") from error
    except SQLAlchemyError:
        db.rollback()
        raise


def response(
    item: BoardPost, board: Board, published: BoardPostRevision | None = None
) -> PostResponse:
    source = published if published is not None else item
    return PostResponse(
        id=item.id,
        board_id=item.board_id,
        author_id=source.author_id,
        title=source.title,
        body=source.body,
        links=source.links,
        status="published" if published is not None else item.status,
        publish_at=published.published_at.astimezone(UTC) if published else item.publish_at,
        expires_at=source.expires_at.astimezone(UTC) if source.expires_at else None,
        pinned=item.pinned,
        post_revision=None if published is not None else item.revision,
        board_revision=board.revision,
        publication_number=published.publication_number if published else None,
        published_at=published.published_at.astimezone(UTC) if published else None,
        edited=published is not None and published.publication_number > 1,
        created_at=published.created_at if published is not None else item.created_at,
        updated_at=published.updated_at if published is not None else item.updated_at,
    )


def mutation(item: BoardPost, board: Board) -> PostMutationResponse:
    return PostMutationResponse(
        id=item.id, post_revision=item.revision, board_revision=board.revision
    )
