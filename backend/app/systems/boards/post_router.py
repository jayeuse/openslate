"""Board post API: drafts, scheduled and immediate publication, archive and delete."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import ValidationError
from sqlalchemy import func, literal, or_, select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.common.listing import SortOrder, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board
from app.systems.boards.post_listing import display_join, editable_statement, list_spec
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_schemas import (
    PostContent,
    PostCreate,
    PostDeleteResponse,
    PostListRequest,
    PostListResponse,
    PostMutationResponse,
    PostPatch,
    PostPublicationResponse,
    PostPublish,
    PostResponse,
    PostRevisionWrite,
    PostSchedule,
    PostSort,
    PostView,
)
from app.systems.boards.post_service import (
    actionable,
    check_board,
    check_post,
    commit,
    conflict,
    current_content,
    displayed_revision,
    manager,
    mutation,
    not_found,
    post,
    publish_locked,
    published_expiry,
    published_result,
    set_content,
)
from app.systems.boards.post_service import (
    response as post_response,
)
from app.systems.boards.post_work import cancel_post_work, delete_post_work
from app.systems.boards.router import _board_with_access
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind

MAX_POSTS = 500


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _manager_only() -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required")


@router.get("/{board_id}/posts", response_model=PostListResponse)
def list_posts(
    board_id: UUID,
    actor: Reader,
    db: Database,
    params: Annotated[PostListRequest, Query()],
) -> PostListResponse:
    editable = params.view is PostView.EDITABLE
    board = _board_with_access(
        db, actor, board_id, AccessLevel.WRITE if editable else AccessLevel.READ
    )
    is_manager = manager(db, board, actor)
    base = select(BoardPost).where(
        BoardPost.board_id == board.id,
        BoardPost.is_deleted.is_(False),
        BoardPost.deleted_at.is_(None),
    )
    if params.view is PostView.PUBLISHED:
        statement = base.join(BoardPostRevision, display_join()).where(
            BoardPost.status != "archived",
            published_expiry(actor, is_manager, datetime.now(UTC)),
        )
    elif params.view is PostView.EDITABLE:
        statement = editable_statement(base, actor, is_manager)
    elif params.view is PostView.DRAFT:
        statement = base.where(
            BoardPost.status.in_(("draft", "scheduled")),
            or_(BoardPost.author_id == actor.id, literal(is_manager)),
        )
    else:
        if not is_manager:
            raise _manager_only()
        statement = base.where(BoardPost.status == "archived")
    if params.author_id is not None:
        author_source = BoardPostRevision if params.view is PostView.PUBLISHED else BoardPost
        statement = statement.where(author_source.author_id == params.author_id)
    pinned_first = (
        params.sort_by in (None, PostSort.UPDATED_AT) and params.sort_order is SortOrder.DESC
    )
    result = execute_standard_list(
        db, statement, params, list_spec(params.view, pinned_first=pinned_first)
    )
    items = [
        post_response(
            item,
            board,
            displayed_revision(db, item) if params.view is PostView.PUBLISHED else None,
        )
        for item in result.items
    ]
    return PostListResponse(
        items=items, pagination=result.pagination, board_revision=board.revision
    )


@router.post(
    "/{board_id}/posts",
    response_model=PostMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_post(
    board_id: UUID, payload: PostCreate, actor: Reader, db: Database, response: Response
) -> PostMutationResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    check_board(board, payload.board_revision)
    if payload.pinned and not manager(db, board, actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required to pin")
    count = db.scalar(
        select(func.count(BoardPost.id)).where(
            BoardPost.board_id == board.id,
            BoardPost.is_deleted.is_(False),
            BoardPost.deleted_at.is_(None),
        )
    )
    if count is None or count >= MAX_POSTS:
        raise conflict("post_limit_reached", "The Board has 500 posts")
    item = BoardPost(org_id=board.org_id, board_id=board.id, author_id=actor.id)
    set_content(item, payload)
    db.add(item)
    board.revision += 1
    commit(db)
    db.refresh(item)
    response.headers["Location"] = f"/api/boards/{board.id}/posts/{item.id}?view=draft"
    return mutation(item, board)


def _published_post(db: Session, board: Board, post_id: UUID, actor: User) -> BoardPost | None:
    """The post as its readers see it, or None when it is not on the Board now."""

    return db.scalar(
        select(BoardPost)
        .join(BoardPostRevision, display_join())
        .where(
            BoardPost.id == post_id,
            BoardPost.board_id == board.id,
            BoardPost.is_deleted.is_(False),
            BoardPost.deleted_at.is_(None),
            BoardPost.status != "archived",
            published_expiry(actor, manager(db, board, actor), datetime.now(UTC)),
        )
    )


@router.get("/{board_id}/posts/{post_id}", response_model=PostResponse)
def read_post(
    board_id: UUID,
    post_id: UUID,
    actor: Reader,
    db: Database,
    view: PostView = PostView.PUBLISHED,
) -> PostResponse:
    editable = view is PostView.EDITABLE
    board = _board_with_access(
        db, actor, board_id, AccessLevel.WRITE if editable else AccessLevel.READ
    )
    if view is PostView.PUBLISHED:
        found = _published_post(db, board, post_id, actor)
        if found is None:
            raise not_found()
        return post_response(found, board, displayed_revision(db, found))
    item = post(db, board.id, post_id)
    is_manager = manager(db, board, actor)
    if item.author_id != actor.id and not is_manager:
        raise not_found()
    if editable and item.status not in ("draft", "scheduled", "published"):
        raise not_found()
    if view is PostView.DRAFT and item.status not in ("draft", "scheduled"):
        raise not_found()
    if view is PostView.ARCHIVE and (item.status != "archived" or not is_manager):
        raise not_found()
    return post_response(item, board)


def _editable(
    db: Session, board_id: UUID, post_id: UUID, actor: User, board_revision: int
) -> tuple[Board, BoardPost]:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    item, _ = actionable(db, board, post_id, actor)
    check_board(board, board_revision)
    if item.status == "archived":
        raise conflict("post_archived", "Restore the post before editing it")
    return board, item


@router.patch("/{board_id}/posts/{post_id}", response_model=PostMutationResponse)
def update_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostPatch,
    actor: Reader,
    db: Database,
) -> PostMutationResponse:
    board, item = _editable(db, board_id, post_id, actor, payload.board_revision)
    check_post(item, payload.post_revision)
    values = current_content(item).model_dump()
    values.update(
        payload.model_dump(exclude_unset=True, exclude={"board_revision", "post_revision"})
    )
    try:
        content = PostContent.model_validate(values)
    except ValidationError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "post_invalid", "message": "Post fields are invalid"},
        ) from error
    if payload.pinned is not None and payload.pinned != item.pinned:
        if not manager(db, board, actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required to pin")
    set_content(item, content)
    item.status, item.publish_at = "draft", None
    item.revision += 1
    board.revision += 1
    cancel_post_work(db, item)
    commit(db)
    return mutation(item, board)


@router.post("/{board_id}/posts/{post_id}/schedule", response_model=PostMutationResponse)
def schedule_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostSchedule,
    actor: Reader,
    db: Database,
) -> PostMutationResponse:
    board, item = _editable(db, board_id, post_id, actor, payload.board_revision)
    check_post(item, payload.post_revision)
    now = datetime.now(UTC)
    if payload.publish_at <= now or (item.expires_at and item.expires_at <= payload.publish_at):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "post_schedule_invalid",
                "message": "Choose a future publication before expiration",
            },
        )
    item.status, item.publish_at = "scheduled", payload.publish_at
    item.revision += 1
    board.revision += 1
    cancel_post_work(db, item)
    db.add(
        ScheduledWork(
            org_id=item.org_id,
            kind=WorkKind.POST_PUBLISH,
            post_id=item.id,
            source_revision=item.revision,
            scheduling_actor_id=actor.id,
            scheduled_for=payload.publish_at,
            next_attempt_at=payload.publish_at,
        )
    )
    commit(db)
    return mutation(item, board)


@router.post("/{board_id}/posts/{post_id}/publish", response_model=PostPublicationResponse)
def publish_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostPublish,
    actor: Reader,
    db: Database,
) -> PostPublicationResponse:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    item, _ = actionable(db, board, post_id, actor)
    previous_revision = item.revision
    published = publish_locked(
        db,
        board,
        item,
        actor,
        publication_key=payload.publication_key,
        published_at=datetime.now(UTC),
        board_revision=payload.board_revision,
        post_revision=payload.post_revision,
    )
    if item.revision != previous_revision:
        cancel_post_work(db, item)
        commit(db)
        db.refresh(published)
    return published_result(published)


def _managed(
    db: Session,
    board_id: UUID,
    post_id: UUID,
    actor: User,
    payload: PostRevisionWrite,
) -> tuple[Board, BoardPost, BoardPostRevision | None]:
    board = _board_with_access(db, actor, board_id, AccessLevel.WRITE, lock=True)
    item, displayed = actionable(db, board, post_id, actor)
    check_board(board, payload.board_revision)
    check_post(item, payload.post_revision)
    return board, item, displayed


@router.post("/{board_id}/posts/{post_id}/unpublish", response_model=PostMutationResponse)
def unpublish_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostRevisionWrite,
    actor: Reader,
    db: Database,
) -> PostMutationResponse:
    board, item, displayed = _managed(db, board_id, post_id, actor, payload)
    if displayed is None:
        raise conflict("post_not_published", "There is no displayed publication")
    item.displayed_publication_number = None
    item.status, item.publish_at = "draft", None
    item.revision += 1
    board.revision += 1
    cancel_post_work(db, item)
    commit(db)
    return mutation(item, board)


def _archive(db: Session, board: Board, item: BoardPost) -> None:
    item.status = "archived"
    item.revision += 1
    board.revision += 1
    cancel_post_work(db, item)


@router.post("/{board_id}/posts/{post_id}/archive", response_model=PostMutationResponse)
def archive_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostRevisionWrite,
    actor: Reader,
    db: Database,
) -> PostMutationResponse:
    board, item, _ = _managed(db, board_id, post_id, actor, payload)
    if item.status == "archived":
        raise conflict("post_archived", "The post is already archived")
    _archive(db, board, item)
    commit(db)
    return mutation(item, board)


@router.post("/{board_id}/posts/{post_id}/restore", response_model=PostMutationResponse)
def restore_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostRevisionWrite,
    actor: Reader,
    db: Database,
) -> PostMutationResponse:
    board, item, displayed = _managed(db, board_id, post_id, actor, payload)
    if item.status != "archived":
        raise conflict("post_not_archived", "Archive the post before restoring it")
    item.status = "published" if displayed else "draft"
    item.publish_at = displayed.published_at if displayed else None
    item.revision += 1
    board.revision += 1
    commit(db)
    return mutation(item, board)


@router.delete("/{board_id}/posts/{post_id}", response_model=PostDeleteResponse)
def delete_post(
    board_id: UUID,
    post_id: UUID,
    payload: PostRevisionWrite,
    actor: Reader,
    db: Database,
) -> PostDeleteResponse:
    """Delete a post that was never published; archive a published one.

    A published post keeps its revisions, so the edit history stays. Only the
    Board purge removes revisions.
    """

    board, item, _ = _managed(db, board_id, post_id, actor, payload)
    published_before = db.scalar(
        select(BoardPostRevision.id).where(BoardPostRevision.post_id == item.id).limit(1)
    )
    if published_before is not None:
        if item.status == "archived":
            raise conflict("post_archived", "The post is already archived")
        _archive(db, board, item)
        commit(db)
        return PostDeleteResponse(
            id=item.id, outcome="archived", post_revision=item.revision,
            board_revision=board.revision,
        )
    from app.systems.boards.attachment_service import delete_post_attachments
    from app.systems.boards.record_link_service import delete_content_links

    delete_post_attachments(db, item.id)
    delete_content_links(db, "post", item.id)
    delete_post_work(db, item)
    db.delete(item)
    board.revision += 1
    commit(db)
    return PostDeleteResponse(
        id=post_id, outcome="deleted", post_revision=None, board_revision=board.revision
    )
