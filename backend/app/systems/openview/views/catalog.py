"""Readable data sources and their fields for building views."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.openview.views.schemas import ViewDataSourceResponse, ViewFieldResponse
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module

router = APIRouter()
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class DataSourceSort(StrEnum):
    NAME = "name"


class FieldSort(StrEnum):
    NAME = "name"
    POSITION = "position"


DATA_SOURCE_SPEC = ListQuerySpec(
    sort_fields={DataSourceSort.NAME: cast(ColumnElement[Any], Module.module_name)},
    default_sort=DataSourceSort.NAME,
    tie_breaker=cast(ColumnElement[Any], Module.id),
    deleted_field=cast(ColumnElement[bool], Module.is_deleted),
    search_fields=(cast(ColumnElement[str], Module.module_name),),
)
FIELD_SPEC = ListQuerySpec(
    sort_fields={
        FieldSort.NAME: cast(ColumnElement[Any], Field.name),
        FieldSort.POSITION: cast(ColumnElement[Any], Field.position),
    },
    default_sort=FieldSort.POSITION,
    tie_breaker=cast(ColumnElement[Any], Field.id),
    deleted_field=cast(ColumnElement[bool], Field.is_deleted),
    search_fields=(cast(ColumnElement[str], Field.name),),
)


@router.get("/data-sources", response_model=StandardListResponse[ViewDataSourceResponse])
def list_data_sources(
    user: Reader,
    db: Database,
    params: Annotated[StandardListRequest[DataSourceSort], Query()],
) -> StandardListResponse[ViewDataSourceResponse]:
    result = execute_standard_list(
        db,
        select(Module).where(
            Module.is_deleted.is_(False),
            module_filter(db, user, AccessLevel.READ, Module.id),
        ),
        params,
        DATA_SOURCE_SPEC,
    )
    items = [
        ViewDataSourceResponse(
            id=item.id,
            name=item.module_name,
            department_id=item.department_id,
        )
        for item in result.items
    ]
    return StandardListResponse(items=items, pagination=result.pagination)


@router.get(
    "/data-sources/{module_id}/fields",
    response_model=StandardListResponse[ViewFieldResponse],
)
def list_data_source_fields(
    module_id: UUID,
    user: Reader,
    db: Database,
    params: Annotated[StandardListRequest[FieldSort], Query()],
) -> StandardListResponse[ViewFieldResponse]:
    active_module_id = db.scalar(
        select(Module.id).where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
            module_filter(db, user, AccessLevel.READ, Module.id),
        )
    )
    if active_module_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Data source not found")
    result = execute_standard_list(
        db,
        select(Field).where(
            Field.module_id == module_id,
            Field.is_deleted.is_(False),
            Field.type != FieldType.RELATIONSHIP,
        ),
        params,
        FIELD_SPEC,
    )
    items = [ViewFieldResponse.model_validate(item) for item in result.items]
    return StandardListResponse(items=items, pagination=result.pagination)
