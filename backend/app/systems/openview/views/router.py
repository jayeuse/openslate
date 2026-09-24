from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
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
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.schemas import ViewCreate, ViewResponse, ViewUpdate
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import invalid_view, validate_definition

router = APIRouter(prefix="/views", tags=["views"])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Database = Annotated[Session, Depends(get_db)]


class ViewSort(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"


class ViewList(StandardListRequest[ViewSort]):
    module_id: UUID | None = None


SPEC = ListQuerySpec(
    sort_fields={
        ViewSort.NAME: cast(ColumnElement[Any], SavedView.name),
        ViewSort.CREATED_AT: cast(ColumnElement[Any], SavedView.created_at),
    },
    default_sort=ViewSort.NAME,
    tie_breaker=cast(ColumnElement[Any], SavedView.id),
    deleted_field=cast(ColumnElement[bool], SavedView.is_deleted),
    search_fields=(cast(ColumnElement[str], SavedView.name),),
)


def visible_to(user: User) -> ColumnElement[bool]:
    return or_(
        SavedView.visibility == "workspace",
        and_(SavedView.visibility == "private", SavedView.owner_id == user.id),
    )


def get_view(db: Session, user: User, view_id: UUID, *, write: bool = False) -> SavedView:
    statement = select(SavedView).where(SavedView.id == view_id, visible_to(user))
    if write:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    view = db.scalar(statement)
    if view is None:
        raise HTTPException(404, detail="View not found")
    if write and view.visibility == "workspace" and user.role.role != "admin":
        raise HTTPException(403, detail="Forbidden")
    return view


def commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(409, detail="Unable to save view") from error


@router.get("", response_model=StandardListResponse[ViewResponse])
def list_views(user: Reader, db: Database, params: Annotated[ViewList, Query()]) -> Any:
    statement = select(SavedView).where(visible_to(user))
    if params.module_id is not None:
        statement = statement.where(SavedView.module_id == params.module_id)
    result = execute_standard_list(db, statement, params, SPEC)
    return {"items": result.items, "pagination": result.pagination}


@router.post("", response_model=ViewResponse, status_code=201)
def create_view(payload: ViewCreate, user: Reader, db: Database, response: Response) -> SavedView:
    if payload.visibility == "workspace" and user.role.role != "admin":
        raise HTTPException(403, detail="Forbidden")
    if db.scalar(select(Module).where(Module.id == payload.module_id).with_for_update()) is None:
        raise invalid_view("The module no longer exists")
    validate_definition(db, payload.module_id, payload.definition)
    view = SavedView(
        module_id=payload.module_id,
        owner_id=user.id,
        name=payload.name,
        visibility=payload.visibility,
        definition=payload.definition.model_dump(mode="json"),
    )
    db.add(view)
    commit(db)
    db.refresh(view)
    response.headers["Location"] = f"/api/views/{view.id}"
    return view


@router.get("/{view_id}", response_model=ViewResponse)
def read_view(view_id: UUID, user: Reader, db: Database) -> SavedView:
    # Return stale definitions intact so callers can explicitly repair them.
    return get_view(db, user, view_id)


@router.patch("/{view_id}", response_model=ViewResponse)
def update_view(view_id: UUID, payload: ViewUpdate, user: Reader, db: Database) -> SavedView:
    current = get_view(db, user, view_id)
    if db.scalar(select(Module).where(Module.id == current.module_id).with_for_update()) is None:
        raise invalid_view("The module no longer exists")
    view = get_view(db, user, view_id, write=True)
    if view.is_deleted or view.revision != payload.revision:
        raise HTTPException(409, detail="View changed; reload before saving")
    definition = payload.definition
    if definition is None:
        from app.systems.sandbox.records.query_schemas import QueryDefinition

        definition = QueryDefinition.model_validate(view.definition)
    validate_definition(db, view.module_id, definition)
    name = payload.name if payload.name is not None else view.name
    normalized_definition = definition.model_dump(mode="json")
    if view.name == name and view.definition == normalized_definition:
        return view
    view.name = name
    view.definition = normalized_definition
    view.revision += 1
    commit(db)
    return view


@router.delete("/{view_id}", status_code=204)
def archive_view(view_id: UUID, user: Reader, db: Database) -> Response:
    view = get_view(db, user, view_id, write=True)
    if not view.is_deleted:
        view.is_deleted = True
        view.deleted_at = datetime.now(UTC)
        view.revision += 1
        commit(db)
    return Response(status_code=204)
