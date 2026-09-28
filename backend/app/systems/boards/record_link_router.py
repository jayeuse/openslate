"""Record shortcuts scoped to a visible Board Event or Post."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_non_guest
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.record_link_models import (
    BoardPostRevisionRecordLink,
    BoardRecordLink,
)
from app.systems.boards.record_link_service import link_record, listed_links, unlink_record
from app.systems.platform.files.access import fresh_user


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards",
    tags=["board record links"],
    dependencies=[
        Depends(_private_cache),
        Depends(get_current_user),
    ],
)
Reader = Annotated[User, Depends(get_current_user)]
Writer = Annotated[User, Depends(require_non_guest)]
Database = Annotated[Session, Depends(get_db)]


class RecordLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    record_id: UUID
    label: str = Field(min_length=1, max_length=100)
    board_revision: int = Field(ge=1)
    content_revision: int = Field(ge=1)


class RecordLinkRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_revision: int = Field(ge=1)
    content_revision: int = Field(ge=1)


class RecordLinkResponse(BaseModel):
    id: UUID
    record_id: UUID
    module_id: UUID
    label: str
    available: bool
    url: str | None


class RecordLinkList(BaseModel):
    items: list[RecordLinkResponse]
    limit: int
    offset: int
    has_more: bool


def _response(
    link: BoardRecordLink | BoardPostRevisionRecordLink,
    active_modules: dict[UUID, UUID],
) -> RecordLinkResponse:
    available = active_modules.get(link.record_id) == link.module_id
    return RecordLinkResponse(
        id=link.id,
        record_id=link.record_id,
        module_id=link.module_id,
        label=link.label,
        available=available,
        url=(f"/openview?module={link.module_id}&record={link.record_id}" if available else None),
    )


def _list(
    db: Session,
    actor: User,
    board_id: UUID,
    kind: str,
    content_id: UUID,
    *,
    view: str,
    limit: int,
    offset: int,
) -> RecordLinkList:
    links, active_modules = listed_links(
        db,
        fresh_user(db, actor.id),
        board_id,
        kind,
        content_id,
        view=view,
        limit=limit + 1,
        offset=offset,
    )
    return RecordLinkList(
        items=[_response(link, active_modules) for link in links[:limit]],
        limit=limit,
        offset=offset,
        has_more=len(links) > limit,
    )


@router.get("/{board_id}/events/{event_id}/record-links", response_model=RecordLinkList)
def list_event_record_links(
    board_id: UUID,
    event_id: UUID,
    actor: Reader,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=20)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RecordLinkList:
    return _list(db, actor, board_id, "event", event_id, view="current", limit=limit, offset=offset)


@router.post(
    "/{board_id}/events/{event_id}/record-links", response_model=RecordLinkResponse, status_code=201
)
def create_event_record_link(
    board_id: UUID,
    event_id: UUID,
    payload: RecordLinkCreate,
    actor: Writer,
    db: Database,
    response: Response,
) -> RecordLinkResponse:
    link = link_record(
        db,
        fresh_user(db, actor.id),
        board_id,
        "event",
        event_id,
        payload.record_id,
        payload.label,
        board_revision=payload.board_revision,
        content_revision=payload.content_revision,
    )
    response.headers["Location"] = (
        f"/api/boards/{board_id}/events/{event_id}/record-links/{link.id}"
    )
    return _response(link, {link.record_id: link.module_id})


@router.delete("/{board_id}/events/{event_id}/record-links/{link_id}", status_code=204)
def delete_event_record_link(
    board_id: UUID,
    event_id: UUID,
    link_id: UUID,
    payload: RecordLinkRevision,
    actor: Writer,
    db: Database,
) -> None:
    unlink_record(
        db,
        fresh_user(db, actor.id),
        board_id,
        "event",
        event_id,
        link_id,
        board_revision=payload.board_revision,
        content_revision=payload.content_revision,
    )


@router.get(
    "/{board_id}/posts/{post_id}/record-links", response_model=RecordLinkList
)
def list_post_record_links(
    board_id: UUID,
    post_id: UUID,
    actor: Reader,
    db: Database,
    view: Literal["published", "draft"] = "published",
    limit: Annotated[int, Query(ge=1, le=20)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RecordLinkList:
    return _list(
        db,
        actor,
        board_id,
        "post",
        post_id,
        view=view,
        limit=limit,
        offset=offset,
    )


@router.post(
    "/{board_id}/posts/{post_id}/record-links",
    response_model=RecordLinkResponse,
    status_code=201,
)
def create_post_record_link(
    board_id: UUID,
    post_id: UUID,
    payload: RecordLinkCreate,
    actor: Writer,
    db: Database,
    response: Response,
) -> RecordLinkResponse:
    link = link_record(
        db,
        fresh_user(db, actor.id),
        board_id,
        "post",
        post_id,
        payload.record_id,
        payload.label,
        board_revision=payload.board_revision,
        content_revision=payload.content_revision,
    )
    response.headers["Location"] = (
        f"/api/boards/{board_id}/posts/{post_id}/record-links/{link.id}"
    )
    return _response(link, {link.record_id: link.module_id})


@router.delete(
    "/{board_id}/posts/{post_id}/record-links/{link_id}", status_code=204
)
def delete_post_record_link(
    board_id: UUID,
    post_id: UUID,
    link_id: UUID,
    payload: RecordLinkRevision,
    actor: Writer,
    db: Database,
) -> None:
    unlink_record(
        db,
        fresh_user(db, actor.id),
        board_id,
        "post",
        post_id,
        link_id,
        board_revision=payload.board_revision,
        content_revision=payload.content_revision,
    )
