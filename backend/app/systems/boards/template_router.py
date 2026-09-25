"""Organization-level Board template routes; not mounted in the application yet."""

import json
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_legacy_capability
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.boards.models import BoardPermission, BoardStatus
from app.systems.boards.portability import PortabilityError, parse_portable_board
from app.systems.boards.portability_router import (
    _bundle_from_board,
    _create_private_board,
    _http_error,
)
from app.systems.boards.portability_schemas import PortableBoardBundle
from app.systems.boards.router import _board_with_access
from app.systems.boards.schemas import BoardResponse
from app.systems.boards.template_models import BoardTemplate

MAX_ACTIVE_TEMPLATES = 50
# Application-wide namespace, independent of file quota and migration locks.
TEMPLATE_COUNT_LOCK = 74261596103948295


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/board-templates", tags=["boards"], dependencies=[Depends(_private_cache)]
)
Manager = Annotated[
    User,
    Depends(require_legacy_capability(Capability.RECORDS_READ, Capability.RECORDS_WRITE)),
]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]


class TemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    board_id: UUID
    name: str = Field(min_length=1, max_length=80)


class TemplateSort(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class TemplateListRequest(StandardListRequest[TemplateSort]):
    pass


class TemplateResponse(BaseModel):
    id: UUID
    name: str
    widget_count: int
    created_at: datetime
    updated_at: datetime


class TemplateListResponse(StandardListResponse[TemplateResponse]):
    pass


TEMPLATE_LIST_SPEC = ListQuerySpec(
    sort_fields={
        TemplateSort.NAME: cast(ColumnElement[Any], BoardTemplate.name),
        TemplateSort.CREATED_AT: cast(ColumnElement[Any], BoardTemplate.created_at),
        TemplateSort.UPDATED_AT: cast(ColumnElement[Any], BoardTemplate.updated_at),
    },
    default_sort=TemplateSort.NAME,
    tie_breaker=cast(ColumnElement[Any], BoardTemplate.id),
    search_fields=(cast(ColumnElement[str], BoardTemplate.name),),
    deleted_field=None,
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Board template not found")


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message},
    )


def _stored_bundle(template: BoardTemplate) -> PortableBoardBundle:
    try:
        raw = json.dumps(template.bundle, allow_nan=False).encode()
        return parse_portable_board(raw)
    except (TypeError, ValueError, PortabilityError) as error:
        raise _conflict("template_invalid", "Saved Board template is invalid") from error


def _response(template: BoardTemplate) -> TemplateResponse:
    bundle = _stored_bundle(template)
    return TemplateResponse(
        id=template.id,
        name=template.name,
        widget_count=len(bundle.configuration.widgets),
        created_at=template.created_at,
        updated_at=template.updated_at,
    )


def _active_template(db: Session, template_id: UUID, *, lock: bool = False) -> BoardTemplate:
    statement = select(BoardTemplate).where(
        BoardTemplate.id == template_id,
        BoardTemplate.is_deleted.is_(False),
        BoardTemplate.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    template = db.scalar(statement)
    if template is None:
        raise _not_found()
    return template


@router.get("", response_model=TemplateListResponse)
def list_board_templates(
    actor: Manager,
    db: Database,
    params: Annotated[TemplateListRequest, Query()],
) -> TemplateListResponse:
    result = execute_standard_list(
        db,
        select(BoardTemplate).where(
            BoardTemplate.is_deleted.is_(False), BoardTemplate.deleted_at.is_(None)
        ),
        params,
        TEMPLATE_LIST_SPEC,
    )
    return TemplateListResponse(
        items=[_response(template) for template in result.items],
        pagination=result.pagination,
    )


@router.post("", response_model=TemplateResponse, status_code=status.HTTP_201_CREATED)
def save_board_template(
    payload: TemplateCreate, actor: Manager, db: Database, response: Response
) -> TemplateResponse:
    try:
        board = _board_with_access(db, actor, payload.board_id, BoardPermission.MANAGE, lock=True)
        if board.status != BoardStatus.ACTIVE:
            raise _conflict("board_archived", "Restore the Board before saving a template")
        bundle = _bundle_from_board(db, board.id, actor, mutation=True)
        db.scalar(select(func.pg_advisory_xact_lock(TEMPLATE_COUNT_LOCK)))
        active_count = db.scalar(
            select(func.count(BoardTemplate.id)).where(
                BoardTemplate.is_deleted.is_(False), BoardTemplate.deleted_at.is_(None)
            )
        )
        if active_count is None or active_count >= MAX_ACTIVE_TEMPLATES:
            raise _conflict("template_limit_reached", "The workspace has 50 active templates")
        template = BoardTemplate(name=payload.name, bundle=bundle.model_dump(mode="json"))
        db.add(template)
        db.commit()
    except PortabilityError as error:
        db.rollback()
        raise _http_error(error) from error
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise _conflict("template_conflict", "Unable to save Board template") from error
    except SQLAlchemyError:
        db.rollback()
        raise
    db.refresh(template)
    response.headers["Location"] = f"/api/board-templates/{template.id}"
    return _response(template)


@router.get("/{template_id}", response_model=TemplateResponse)
def read_board_template(template_id: UUID, actor: Manager, db: Database) -> TemplateResponse:
    return _response(_active_template(db, template_id))


@router.post(
    "/{template_id}/boards", response_model=BoardResponse, status_code=status.HTTP_201_CREATED
)
def create_board_from_template(
    template_id: UUID, actor: Manager, db: Database, response: Response
) -> BoardResponse:
    try:
        template = _active_template(db, template_id, lock=True)
        bundle = _stored_bundle(template)
        board = _create_private_board(db, actor, bundle)
    except PortabilityError as error:
        db.rollback()
        raise _http_error(error) from error
    except HTTPException:
        db.rollback()
        raise
    response.headers["Location"] = f"/api/boards/{board.id}"
    return BoardResponse.model_validate(board)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_board_template(template_id: UUID, actor: Writer, db: Database) -> None:
    template = _active_template(db, template_id, lock=True)
    template.is_deleted = True
    template.deleted_at = datetime.now(UTC)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("template_conflict", "Unable to delete Board template") from error
    except SQLAlchemyError:
        db.rollback()
        raise
