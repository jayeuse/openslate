"""Board announcement API, intentionally unmounted until Phase 5 integration."""

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import ValidationError
from sqlalchemy import and_, func, literal, or_, select
from sqlalchemy.orm import Session

from app.common.dependencies import require_legacy_capability
from app.common.listing import execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.boards.announcement_listing import display_join, editable_statement, list_spec
from app.systems.boards.announcement_models import (
    BoardAnnouncement,
    BoardAnnouncementRevision,
)
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.announcement_schemas import (
    AnnouncementContent,
    AnnouncementCreate,
    AnnouncementListRequest,
    AnnouncementListResponse,
    AnnouncementMutationResponse,
    AnnouncementPatch,
    AnnouncementPublicationResponse,
    AnnouncementPublish,
    AnnouncementResponse,
    AnnouncementRevisionWrite,
    AnnouncementSchedule,
    AnnouncementView,
)
from app.systems.boards.announcement_service import (
    actionable,
    active_audience_target,
    announcement,
    audience_clause,
    check_announcement,
    check_board,
    commit,
    conflict,
    current_content,
    displayed_revision,
    mutation,
    not_found,
    publish_locked,
    published_expiry,
    published_result,
    read_manager,
    revision_visible,
    set_content,
    write_manager,
)
from app.systems.boards.announcement_service import (
    response as announcement_response,
)
from app.systems.boards.announcement_work import (
    cancel_announcement_work,
    delete_announcement_work,
)
from app.systems.boards.models import Board, BoardPermission
from app.systems.boards.router import _board_with_access
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind

MAX_ANNOUNCEMENTS = 500


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]


def _require_editor_role(actor: User) -> None:
    if not has_capability(actor.role, Capability.RECORDS_WRITE):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.get("/{board_id}/announcements", response_model=AnnouncementListResponse)
def list_announcements(
    board_id: UUID,
    actor: Reader,
    db: Database,
    params: Annotated[AnnouncementListRequest, Query()],
) -> AnnouncementListResponse:
    editable = params.view is AnnouncementView.EDITABLE
    if editable:
        _require_editor_role(actor)
    board = _board_with_access(
        db, actor, board_id, BoardPermission.EDIT if editable else BoardPermission.VIEW
    )
    manager = read_manager(db, board, actor)
    base = select(BoardAnnouncement).where(
        BoardAnnouncement.board_id == board.id,
        BoardAnnouncement.is_deleted.is_(False),
        BoardAnnouncement.deleted_at.is_(None),
    )
    if params.view is AnnouncementView.PUBLISHED:
        statement = base.join(BoardAnnouncementRevision, display_join()).where(
            BoardAnnouncement.status != "archived",
            audience_clause(BoardAnnouncementRevision, actor),
            published_expiry(actor, manager, datetime.now(UTC)),
        )
    elif params.view is AnnouncementView.EDITABLE:
        statement = editable_statement(base, actor, manager)
    elif params.view is AnnouncementView.DRAFT:
        statement = base.where(
            BoardAnnouncement.status.in_(("draft", "scheduled")),
            or_(
                BoardAnnouncement.author_id == actor.id,
                and_(literal(manager), audience_clause(BoardAnnouncement, actor)),
            ),
        )
    else:
        if not manager:
            raise not_found()
        statement = base.outerjoin(BoardAnnouncementRevision, display_join()).where(
            BoardAnnouncement.status == "archived",
            audience_clause(BoardAnnouncement, actor),
            or_(
                BoardAnnouncement.displayed_publication_number.is_(None),
                audience_clause(BoardAnnouncementRevision, actor),
            ),
        )
    if params.author_id is not None:
        author_source = (
            BoardAnnouncementRevision
            if params.view is AnnouncementView.PUBLISHED
            else BoardAnnouncement
        )
        statement = statement.where(author_source.author_id == params.author_id)
    result = execute_standard_list(db, statement, params, list_spec(params.view))
    items = [
        announcement_response(
            item,
            board,
            displayed_revision(db, item) if params.view is AnnouncementView.PUBLISHED else None,
        )
        for item in result.items
    ]
    return AnnouncementListResponse(
        items=items, pagination=result.pagination, board_revision=board.revision
    )


@router.post(
    "/{board_id}/announcements",
    response_model=AnnouncementMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_announcement(
    board_id: UUID, payload: AnnouncementCreate, actor: Writer, db: Database, response: Response
) -> AnnouncementMutationResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.EDIT, lock=True)
    check_board(board, payload.board_revision)
    active_audience_target(db, payload.audience)
    if payload.pinned and not write_manager(db, board, actor):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required to pin")
    count = db.scalar(
        select(func.count(BoardAnnouncement.id)).where(
            BoardAnnouncement.board_id == board.id,
            BoardAnnouncement.is_deleted.is_(False),
            BoardAnnouncement.deleted_at.is_(None),
        )
    )
    if count is None or count >= MAX_ANNOUNCEMENTS:
        raise conflict("announcement_limit_reached", "The Board has 500 announcements")
    item = BoardAnnouncement(board_id=board.id, author_id=actor.id)
    set_content(item, payload)
    db.add(item)
    board.revision += 1
    commit(db)
    db.refresh(item)
    response.headers["Location"] = f"/api/boards/{board.id}/announcements/{item.id}?view=draft"
    return mutation(item, board)


@router.get("/{board_id}/announcements/{announcement_id}", response_model=AnnouncementResponse)
def read_announcement(
    board_id: UUID,
    announcement_id: UUID,
    actor: Reader,
    db: Database,
    view: AnnouncementView = AnnouncementView.PUBLISHED,
) -> AnnouncementResponse:
    editable = view is AnnouncementView.EDITABLE
    if editable:
        _require_editor_role(actor)
    board = _board_with_access(
        db, actor, board_id, BoardPermission.EDIT if editable else BoardPermission.VIEW
    )
    manager = read_manager(db, board, actor)
    if view is AnnouncementView.PUBLISHED:
        item = db.scalar(
            select(BoardAnnouncement)
            .join(BoardAnnouncementRevision, display_join())
            .where(
                BoardAnnouncement.id == announcement_id,
                BoardAnnouncement.board_id == board.id,
                BoardAnnouncement.is_deleted.is_(False),
                BoardAnnouncement.deleted_at.is_(None),
                BoardAnnouncement.status != "archived",
                audience_clause(BoardAnnouncementRevision, actor),
                published_expiry(actor, manager, datetime.now(UTC)),
            )
        )
        if item is None:
            raise not_found()
        return announcement_response(item, board, displayed_revision(db, item))
    item = announcement(db, board.id, announcement_id, actor)
    if editable:
        if item.status not in ("draft", "scheduled", "published"):
            raise not_found()
        if item.author_id != actor.id:
            if not manager:
                raise not_found()
            if item.status == "published":
                displayed = displayed_revision(db, item)
                if displayed is None or not revision_visible(db, displayed, actor):
                    raise not_found()
    elif view is AnnouncementView.DRAFT:
        if item.status not in ("draft", "scheduled") or not (item.author_id == actor.id or manager):
            raise not_found()
    else:
        if item.status != "archived" or not manager:
            raise not_found()
        displayed = displayed_revision(db, item)
        if displayed is not None and not revision_visible(db, displayed, actor):
            raise not_found()
    return announcement_response(item, board)


def _editable(
    db: Session, board_id: UUID, announcement_id: UUID, actor: User, board_revision: int
) -> tuple[Board, BoardAnnouncement]:
    board = _board_with_access(db, actor, board_id, BoardPermission.EDIT, lock=True)
    item, _ = actionable(db, board.id, announcement_id, actor)
    if item.author_id != actor.id and not write_manager(db, board, actor):
        raise not_found()
    check_board(board, board_revision)
    if item.status == "archived":
        raise conflict("announcement_archived", "Restore the announcement before editing it")
    return board, item


@router.patch(
    "/{board_id}/announcements/{announcement_id}", response_model=AnnouncementMutationResponse
)
def update_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementPatch,
    actor: Writer,
    db: Database,
) -> AnnouncementMutationResponse:
    board, item = _editable(db, board_id, announcement_id, actor, payload.board_revision)
    check_announcement(item, payload.announcement_revision)
    values = current_content(item).model_dump()
    values.update(
        payload.model_dump(exclude_unset=True, exclude={"board_revision", "announcement_revision"})
    )
    try:
        content = AnnouncementContent.model_validate(values)
    except ValidationError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "announcement_invalid", "message": "Announcement fields are invalid"},
        ) from error
    if payload.pinned is not None and payload.pinned != item.pinned:
        if not write_manager(db, board, actor):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Manage access required to pin")
    active_audience_target(db, content.audience)
    set_content(item, content)
    item.status, item.publish_at = "draft", None
    item.revision += 1
    board.revision += 1
    cancel_announcement_work(db, item)
    commit(db)
    return mutation(item, board)


@router.post(
    "/{board_id}/announcements/{announcement_id}/schedule",
    response_model=AnnouncementMutationResponse,
)
def schedule_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementSchedule,
    actor: Writer,
    db: Database,
) -> AnnouncementMutationResponse:
    board, item = _editable(db, board_id, announcement_id, actor, payload.board_revision)
    check_announcement(item, payload.announcement_revision)
    now = datetime.now(UTC)
    if payload.publish_at <= now or (item.expires_at and item.expires_at <= payload.publish_at):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "announcement_schedule_invalid",
                "message": "Choose a future publication before expiration",
            },
        )
    active_audience_target(db, current_content(item).audience)
    item.status, item.publish_at = "scheduled", payload.publish_at
    item.revision += 1
    board.revision += 1
    cancel_announcement_work(db, item)
    db.add(
        ScheduledWork(
            kind=WorkKind.ANNOUNCEMENT_PUBLISH,
            announcement_id=item.id,
            source_revision=item.revision,
            scheduling_actor_id=actor.id,
            scheduled_for=payload.publish_at,
            next_attempt_at=payload.publish_at,
        )
    )
    commit(db)
    return mutation(item, board)


@router.post(
    "/{board_id}/announcements/{announcement_id}/publish",
    response_model=AnnouncementPublicationResponse,
)
def publish_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementPublish,
    actor: Writer,
    db: Database,
) -> AnnouncementPublicationResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.EDIT, lock=True)
    item, _ = actionable(db, board.id, announcement_id, actor)
    if item.author_id != actor.id and not write_manager(db, board, actor):
        raise not_found()
    previous_revision = item.revision
    published = publish_locked(
        db,
        board,
        item,
        actor,
        publication_key=payload.publication_key,
        published_at=datetime.now(UTC),
        board_revision=payload.board_revision,
        announcement_revision=payload.announcement_revision,
    )
    if item.revision != previous_revision:
        cancel_announcement_work(db, item)
        commit(db)
        db.refresh(published)
    return published_result(published)


def _managed(
    db: Session,
    board_id: UUID,
    announcement_id: UUID,
    actor: User,
    payload: AnnouncementRevisionWrite,
) -> tuple[Board, BoardAnnouncement, BoardAnnouncementRevision | None]:
    board = _board_with_access(db, actor, board_id, BoardPermission.MANAGE, lock=True)
    item, displayed = actionable(db, board.id, announcement_id, actor)
    check_board(board, payload.board_revision)
    check_announcement(item, payload.announcement_revision)
    return board, item, displayed


@router.post(
    "/{board_id}/announcements/{announcement_id}/unpublish",
    response_model=AnnouncementMutationResponse,
)
def unpublish_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementRevisionWrite,
    actor: Writer,
    db: Database,
) -> AnnouncementMutationResponse:
    board, item, displayed = _managed(db, board_id, announcement_id, actor, payload)
    if displayed is None:
        raise conflict("announcement_not_published", "There is no displayed publication")
    item.displayed_publication_number = None
    item.status, item.publish_at = "draft", None
    item.revision += 1
    board.revision += 1
    cancel_announcement_work(db, item)
    commit(db)
    return mutation(item, board)


@router.post(
    "/{board_id}/announcements/{announcement_id}/archive",
    response_model=AnnouncementMutationResponse,
)
def archive_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementRevisionWrite,
    actor: Writer,
    db: Database,
) -> AnnouncementMutationResponse:
    board, item, _ = _managed(db, board_id, announcement_id, actor, payload)
    if item.status == "archived":
        raise conflict("announcement_archived", "The announcement is already archived")
    item.status = "archived"
    item.revision += 1
    board.revision += 1
    cancel_announcement_work(db, item)
    commit(db)
    return mutation(item, board)


@router.post(
    "/{board_id}/announcements/{announcement_id}/restore",
    response_model=AnnouncementMutationResponse,
)
def restore_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementRevisionWrite,
    actor: Writer,
    db: Database,
) -> AnnouncementMutationResponse:
    board, item, displayed = _managed(db, board_id, announcement_id, actor, payload)
    if item.status != "archived":
        raise conflict("announcement_not_archived", "Archive the announcement before restoring it")
    item.status = "published" if displayed else "draft"
    item.publish_at = displayed.published_at if displayed else None
    item.revision += 1
    board.revision += 1
    commit(db)
    return mutation(item, board)


@router.delete(
    "/{board_id}/announcements/{announcement_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_announcement(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementRevisionWrite,
    actor: Writer,
    db: Database,
) -> None:
    board, item, _ = _managed(db, board_id, announcement_id, actor, payload)
    if item.status != "archived":
        raise conflict("announcement_not_archived", "Archive the announcement before deleting it")
    from app.systems.boards.attachment_service import delete_announcement_attachments
    from app.systems.boards.record_link_service import (
        delete_content_links,
        delete_revision_links,
    )

    delete_announcement_attachments(db, item.id)
    revision_ids = list(
        db.scalars(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.announcement_id == item.id
            )
        )
    )
    delete_revision_links(db, revision_ids)
    delete_content_links(db, "announcement", item.id)
    delete_announcement_work(db, item)
    personal_states = db.scalars(
        select(BoardAnnouncementPersonalState)
        .where(BoardAnnouncementPersonalState.announcement_id == item.id)
        .order_by(BoardAnnouncementPersonalState.id)
        .with_for_update()
    ).all()
    for personal_state in personal_states:
        db.delete(personal_state)
    db.flush()
    revisions = db.scalars(
        select(BoardAnnouncementRevision)
        .where(
            BoardAnnouncementRevision.announcement_id == item.id,
        )
        .order_by(BoardAnnouncementRevision.publication_number)
        .with_for_update()
    ).all()
    for revision in revisions:
        db.delete(revision)
    db.flush()
    db.delete(item)
    board.revision += 1
    commit(db)
