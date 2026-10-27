"""Record-date sources of a Board calendar and of My calendar (BR57, BE8).

A Board's sources: any reader lists them, its managers add and remove them. My
calendar's sources: the actor's own, in the bound organization. Adding a source needs
read on its module now, and its field must be a live ``date`` or ``datetime`` field of
that module. Every list leaves out the sources whose module the viewer cannot read
now, with no count and no placeholder (the Same Answer Rule); removing one of those
answers 404, as an unknown source does.

At most five sources per owner. The count is taken under a lock: the Board row for a
Board, a transaction advisory lock on the person and organization for My calendar.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.core.database.organization_scope import bound_organization_column, session_organization
from app.systems.access.policy.checks import module_filter, module_level
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.calendar_source_models import MAX_SOURCES, BoardCalendarSource
from app.systems.boards.kanban_service import (
    commit,
    kanban_error,
    not_found,
    read_board,
    write_board,
)
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(tags=["calendar sources"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]
DATE_TYPES = (FieldType.DATE.value, FieldType.DATETIME.value)


class CalendarSourceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    module_id: UUID
    date_field_id: UUID


class CalendarSourceResponse(BaseModel):
    id: UUID
    module_id: UUID
    module_name: str
    department_id: UUID
    date_field_id: UUID
    field_name: str
    field_type: Literal["date", "datetime"]
    position: int


class CalendarSourceList(BaseModel):
    items: list[CalendarSourceResponse]


def _visible(
    db: Session, viewer: User, owner: ColumnElement[bool], source_id: UUID | None = None
) -> list[CalendarSourceResponse]:
    """The owner's sources on live date fields of live modules the viewer reads now."""

    statement = (
        select(BoardCalendarSource, Module, Field)
        .join(Module, Module.id == BoardCalendarSource.module_id)
        .join(Field, Field.id == BoardCalendarSource.date_field_id)
        .where(
            owner,
            BoardCalendarSource.org_id == bound_organization_column(),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
            Field.is_deleted.is_(False),
            Field.module_id == Module.id,
            Field.type.in_(DATE_TYPES),
            module_filter(db, viewer, AccessLevel.READ, BoardCalendarSource.module_id),
        )
        .order_by(BoardCalendarSource.position, BoardCalendarSource.id)
    )
    if source_id is not None:
        statement = statement.where(BoardCalendarSource.id == source_id)
    return [
        CalendarSourceResponse(
            id=source.id,
            module_id=module.id,
            module_name=module.module_name,
            department_id=module.department_id,
            date_field_id=field.id,
            field_name=field.name,
            field_type="datetime" if field.type == FieldType.DATETIME.value else "date",
            position=source.position,
        )
        for source, module, field in db.execute(statement).tuples()
    ]


def _date_field(db: Session, actor: User, payload: CalendarSourceCreate) -> None:
    """A readable live module and a live date field of it; anything else is one 409."""

    unavailable = kanban_error(
        "calendar_source_unavailable", "The module or date field is unavailable"
    )
    if module_level(db, actor, payload.module_id) is None:
        raise unavailable
    field = db.scalar(
        select(Field)
        .join(Module, Module.id == Field.module_id)
        .where(
            Field.id == payload.date_field_id,
            Field.module_id == payload.module_id,
            Field.is_deleted.is_(False),
            Field.type.in_(DATE_TYPES),
            Module.is_deleted.is_(False),
            Module.deleted_at.is_(None),
        )
    )
    if field is None:
        raise unavailable


def _add(
    db: Session, actor: User, owner: ColumnElement[bool], row: BoardCalendarSource,
    payload: CalendarSourceCreate,
) -> None:
    """Check the field, the limit and duplicates (the owner is locked), then insert."""

    _date_field(db, actor, payload)
    count, last = db.execute(
        select(func.count(BoardCalendarSource.id), func.max(BoardCalendarSource.position))
        .where(owner, BoardCalendarSource.org_id == bound_organization_column())
    ).one()
    if count >= MAX_SOURCES:
        raise kanban_error(
            "calendar_source_limit", f"A calendar holds at most {MAX_SOURCES} sources"
        )
    if db.scalar(
        select(BoardCalendarSource.id).where(
            owner,
            BoardCalendarSource.org_id == bound_organization_column(),
            BoardCalendarSource.date_field_id == payload.date_field_id,
        )
    ):
        raise kanban_error("calendar_source_exists", "This date field is already a source")
    row.module_id, row.date_field_id = payload.module_id, payload.date_field_id
    row.position = 0 if last is None else last + 1
    row.created_by = actor.id
    db.add(row)
    commit(db, "calendar_source_conflict", "Unable to add the source; reload the calendar")


def _remove(db: Session, actor: User, owner: ColumnElement[bool], source_id: UUID) -> None:
    if not _visible(db, actor, owner, source_id):
        raise not_found("Calendar source")
    row = db.get(BoardCalendarSource, source_id)
    assert row is not None
    db.delete(row)
    commit(db, "calendar_source_conflict", "Unable to remove the source; reload the calendar")


def _created(
    db: Session, actor: User, owner: ColumnElement[bool], row: BoardCalendarSource,
    response: Response, location: str,
) -> CalendarSourceResponse:
    [created] = _visible(db, actor, owner, row.id)
    response.headers["Location"] = f"{location}/{row.id}"
    return created


# A Board calendar


def _board_owner(board_id: UUID) -> ColumnElement[bool]:
    return BoardCalendarSource.board_id == board_id


@router.get("/boards/{board_id}/calendar-sources", response_model=CalendarSourceList)
def list_board_calendar_sources(
    board_id: UUID, actor: Reader, db: Database
) -> CalendarSourceList:
    board = read_board(db, actor, board_id)
    return CalendarSourceList(items=_visible(db, actor, _board_owner(board.id)))


@router.post(
    "/boards/{board_id}/calendar-sources",
    response_model=CalendarSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_board_calendar_source(
    board_id: UUID,
    payload: CalendarSourceCreate,
    actor: Reader,
    db: Database,
    response: Response,
) -> CalendarSourceResponse:
    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    row = BoardCalendarSource(id=uuid7(), org_id=board.org_id, board_id=board.id)
    _add(db, actor, _board_owner(board.id), row, payload)
    path = f"/api/boards/{board.id}/calendar-sources"
    return _created(db, actor, _board_owner(board.id), row, response, path)


@router.delete(
    "/boards/{board_id}/calendar-sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_board_calendar_source(
    board_id: UUID, source_id: UUID, actor: Reader, db: Database
) -> None:
    board = write_board(db, actor, board_id, AccessLevel.MANAGE)
    _remove(db, actor, _board_owner(board.id), source_id)


# My calendar


def _my_owner(actor: User) -> ColumnElement[bool]:
    return BoardCalendarSource.user_id == actor.id


def _lock_person(db: Session, actor: User) -> None:
    key = f"board_calendar_sources:{session_organization(db)}:{actor.id}"
    db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(key, 0))))


@router.get("/me/calendar-sources", response_model=CalendarSourceList)
def list_my_calendar_sources(actor: Reader, db: Database) -> CalendarSourceList:
    return CalendarSourceList(items=_visible(db, actor, _my_owner(actor)))


@router.post(
    "/me/calendar-sources",
    response_model=CalendarSourceResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_my_calendar_source(
    payload: CalendarSourceCreate, actor: Reader, db: Database, response: Response
) -> CalendarSourceResponse:
    _lock_person(db, actor)
    row = BoardCalendarSource(id=uuid7(), org_id=session_organization(db), user_id=actor.id)
    _add(db, actor, _my_owner(actor), row, payload)
    return _created(db, actor, _my_owner(actor), row, response, "/api/me/calendar-sources")


@router.delete("/me/calendar-sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_my_calendar_source(source_id: UUID, actor: Reader, db: Database) -> None:
    _lock_person(db, actor)
    _remove(db, actor, _my_owner(actor), source_id)
