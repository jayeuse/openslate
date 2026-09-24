"""Current-user read and bookmark state for displayed Board announcements."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import require_legacy_capability
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.announcement_router import _display_join
from app.systems.boards.announcement_service import (
    audience_clause,
    conflict,
    not_found,
    published_expiry,
    read_manager,
)
from app.systems.boards.models import Board, BoardPermission
from app.systems.boards.personal_router import _locked_actor
from app.systems.boards.router import _board_with_access
from app.systems.manage.audit.context import set_audit_actor


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Database = Annotated[Session, Depends(get_db)]


class AnnouncementPersonalStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    announcement_id: UUID
    publication_number: int
    read: bool
    bookmarked: bool


class _PublicationWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    publication_number: int = Field(ge=1, strict=True)


class AnnouncementReadWrite(_PublicationWrite):
    read: StrictBool


class AnnouncementBookmarkWrite(_PublicationWrite):
    bookmarked: StrictBool


def _displayed_item(
    db: Session, board: Board, announcement_id: UUID, actor: User, *, lock: bool = False
) -> BoardAnnouncement:
    manager = read_manager(db, board, actor)
    statement = (
        select(BoardAnnouncement)
        .join(BoardAnnouncementRevision, _display_join())
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
    if lock:
        statement = statement.with_for_update(of=BoardAnnouncement).execution_options(
            populate_existing=True
        )
    item = db.scalar(statement)
    if item is None:
        raise not_found()
    return item


def _current_state(
    db: Session, actor: User, item: BoardAnnouncement
) -> AnnouncementPersonalStateResponse:
    state = db.scalar(
        select(BoardAnnouncementPersonalState).where(
            BoardAnnouncementPersonalState.user_id == actor.id,
            BoardAnnouncementPersonalState.announcement_id == item.id,
            BoardAnnouncementPersonalState.is_deleted.is_(False),
            BoardAnnouncementPersonalState.deleted_at.is_(None),
        )
    )
    number = item.displayed_publication_number
    if number is None:
        raise not_found()
    return AnnouncementPersonalStateResponse(
        announcement_id=item.id,
        publication_number=number,
        read=state.read if state is not None else False,
        bookmarked=state.bookmarked if state is not None else False,
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict(
            "announcement_personal_conflict", "Announcement state changed; retry"
        ) from error
    except SQLAlchemyError:
        db.rollback()
        raise


@router.get(
    "/{board_id}/announcement-personal",
    response_model=list[AnnouncementPersonalStateResponse],
)
def list_announcement_personal_states(
    board_id: UUID,
    announcement_ids: Annotated[
        list[UUID], Query(alias="announcement_id", min_length=1, max_length=25)
    ],
    actor: Reader,
    db: Database,
) -> list[AnnouncementPersonalStateResponse]:
    if len(announcement_ids) != len(set(announcement_ids)):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "duplicate_announcement_id",
                "message": "Choose each announcement once",
            },
        )
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    manager = read_manager(db, board, actor)
    visible = db.execute(
        select(BoardAnnouncement.id, BoardAnnouncement.displayed_publication_number)
        .join(BoardAnnouncementRevision, _display_join())
        .where(
            BoardAnnouncement.id.in_(announcement_ids),
            BoardAnnouncement.board_id == board.id,
            BoardAnnouncement.is_deleted.is_(False),
            BoardAnnouncement.deleted_at.is_(None),
            BoardAnnouncement.status != "archived",
            audience_clause(BoardAnnouncementRevision, actor),
            published_expiry(actor, manager, datetime.now(UTC)),
        )
    ).all()
    numbers = {announcement_id: number for announcement_id, number in visible}
    if len(numbers) != len(announcement_ids) or any(number is None for number in numbers.values()):
        raise not_found()
    personal = db.scalars(
        select(BoardAnnouncementPersonalState).where(
            BoardAnnouncementPersonalState.user_id == actor.id,
            BoardAnnouncementPersonalState.announcement_id.in_(announcement_ids),
            BoardAnnouncementPersonalState.is_deleted.is_(False),
            BoardAnnouncementPersonalState.deleted_at.is_(None),
        )
    ).all()
    states = {state.announcement_id: state for state in personal}
    return [
        AnnouncementPersonalStateResponse(
            announcement_id=announcement_id,
            publication_number=numbers[announcement_id],
            read=states[announcement_id].read if announcement_id in states else False,
            bookmarked=states[announcement_id].bookmarked if announcement_id in states else False,
        )
        for announcement_id in announcement_ids
    ]


@router.get(
    "/{board_id}/announcements/{announcement_id}/personal",
    response_model=AnnouncementPersonalStateResponse,
)
def get_announcement_personal_state(
    board_id: UUID, announcement_id: UUID, actor: Reader, db: Database
) -> AnnouncementPersonalStateResponse:
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW)
    item = _displayed_item(db, board, announcement_id, actor)
    return _current_state(db, actor, item)


def _put_flag(
    db: Session,
    actor: User,
    board_id: UUID,
    announcement_id: UUID,
    publication_number: int,
    flag: Literal["read", "bookmarked"],
    value: bool,
) -> AnnouncementPersonalStateResponse:
    actor = _locked_actor(db, actor)
    board = _board_with_access(db, actor, board_id, BoardPermission.VIEW, lock=True)
    item = _displayed_item(db, board, announcement_id, actor, lock=True)
    number = item.displayed_publication_number
    if number != publication_number:
        raise conflict("stale_publication", "Displayed publication changed; reload before saving")
    state = db.scalar(
        select(BoardAnnouncementPersonalState)
        .where(
            BoardAnnouncementPersonalState.user_id == actor.id,
            BoardAnnouncementPersonalState.announcement_id == item.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    changed = False
    if state is None:
        if value:
            state = BoardAnnouncementPersonalState(
                user_id=actor.id,
                announcement_id=item.id,
                read=flag == "read",
                bookmarked=flag == "bookmarked",
            )
            db.add(state)
            changed = True
    elif state.is_deleted or state.deleted_at is not None:
        if value:
            state.is_deleted, state.deleted_at = False, None
            state.read, state.bookmarked = flag == "read", flag == "bookmarked"
            changed = True
    elif getattr(state, flag) != value:
        setattr(state, flag, value)
        changed = True
    if changed:
        set_audit_actor(db, actor.id)
    active = state is not None and not state.is_deleted and state.deleted_at is None
    read = state.read if active and state is not None else False
    bookmarked = state.bookmarked if active and state is not None else False
    _commit(db)
    return AnnouncementPersonalStateResponse(
        announcement_id=item.id,
        publication_number=publication_number,
        read=read,
        bookmarked=bookmarked,
    )


@router.put(
    "/{board_id}/announcements/{announcement_id}/personal/read",
    response_model=AnnouncementPersonalStateResponse,
)
def put_announcement_read(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementReadWrite,
    actor: Reader,
    db: Database,
) -> AnnouncementPersonalStateResponse:
    return _put_flag(
        db, actor, board_id, announcement_id, payload.publication_number, "read", payload.read
    )


@router.put(
    "/{board_id}/announcements/{announcement_id}/personal/bookmark",
    response_model=AnnouncementPersonalStateResponse,
)
def put_announcement_bookmark(
    board_id: UUID,
    announcement_id: UUID,
    payload: AnnouncementBookmarkWrite,
    actor: Reader,
    db: Database,
) -> AnnouncementPersonalStateResponse:
    return _put_flag(
        db,
        actor,
        board_id,
        announcement_id,
        payload.publication_number,
        "bookmarked",
        payload.bookmarked,
    )
