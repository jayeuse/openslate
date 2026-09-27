from enum import StrEnum
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
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
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.openview.views.access import visible_to
from app.systems.openview.views.models import SavedView, SavedViewDefault
from app.systems.openview.views.schemas import (
    ViewAudienceOptionResponse,
    ViewDataSourceResponse,
    ViewDefaultResponse,
    ViewDefaultSet,
    ViewFieldResponse,
)
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module

router = APIRouter()
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]


class DataSourceSort(StrEnum):
    NAME = "name"


class FieldSort(StrEnum):
    NAME = "name"
    POSITION = "position"


class AudienceSort(StrEnum):
    LABEL = "label"


class DefaultSort(StrEnum):
    MODULE_ID = "module_id"


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
ROLE_AUDIENCE_SPEC = ListQuerySpec(
    sort_fields={AudienceSort.LABEL: cast(ColumnElement[Any], Role.role)},
    default_sort=AudienceSort.LABEL,
    tie_breaker=cast(ColumnElement[Any], Role.id),
    deleted_field=cast(ColumnElement[bool], Role.is_deleted),
    search_fields=(cast(ColumnElement[str], Role.role),),
)
USER_AUDIENCE_SPEC = ListQuerySpec(
    sort_fields={AudienceSort.LABEL: cast(ColumnElement[Any], User.username)},
    default_sort=AudienceSort.LABEL,
    tie_breaker=cast(ColumnElement[Any], User.id),
    deleted_field=cast(ColumnElement[bool], User.is_deleted),
    search_fields=(cast(ColumnElement[str], User.username),),
)
DEFAULT_SPEC = ListQuerySpec(
    sort_fields={DefaultSort.MODULE_ID: cast(ColumnElement[Any], SavedViewDefault.module_id)},
    default_sort=DefaultSort.MODULE_ID,
    tie_breaker=cast(ColumnElement[Any], SavedViewDefault.id),
)


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message},
    )


def _commit(db: Session, code: str, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(code, message) from error


@router.get("/data-sources", response_model=StandardListResponse[ViewDataSourceResponse])
def list_data_sources(
    _: Reader,
    db: Database,
    params: Annotated[StandardListRequest[DataSourceSort], Query()],
) -> StandardListResponse[ViewDataSourceResponse]:
    result = execute_standard_list(
        db,
        select(Module).where(
            Module.is_deleted.is_(False),
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
    _: Reader,
    db: Database,
    params: Annotated[StandardListRequest[FieldSort], Query()],
) -> StandardListResponse[ViewFieldResponse]:
    active_module_id = db.scalar(
        select(Module.id).where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
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


@router.get(
    "/audience-options",
    response_model=StandardListResponse[ViewAudienceOptionResponse],
)
def list_audience_options(
    kind: Literal["role", "user"],
    _: Reader,
    db: Database,
    params: Annotated[StandardListRequest[AudienceSort], Query()],
) -> StandardListResponse[ViewAudienceOptionResponse]:
    if kind == "role":
        role_result = execute_standard_list(
            db,
            select(Role).where(Role.is_deleted.is_(False)),
            params,
            ROLE_AUDIENCE_SPEC,
        )
        items = [
            ViewAudienceOptionResponse(kind="role", id=item.id, label=item.role)
            for item in role_result.items
        ]
        pagination = role_result.pagination
    else:
        user_result = execute_standard_list(
            db,
            select(User).where(
                User.status == UserStatus.ACTIVE,
                User.is_deleted.is_(False),
            ),
            params,
            USER_AUDIENCE_SPEC,
        )
        items = [
            ViewAudienceOptionResponse(kind="user", id=item.id, label=item.username)
            for item in user_result.items
        ]
        pagination = user_result.pagination
    return StandardListResponse(items=items, pagination=pagination)


@router.get("/defaults", response_model=StandardListResponse[ViewDefaultResponse])
def list_personal_defaults(
    user: Reader,
    db: Database,
    params: Annotated[StandardListRequest[DefaultSort], Query()],
) -> StandardListResponse[ViewDefaultResponse]:
    visible_view_ids = (
        select(SavedView.id)
        .join(Module, Module.id == SavedView.module_id)
        .where(
            visible_to(user),
            SavedView.is_deleted.is_(False),
            Module.is_deleted.is_(False),
        )
    )
    result = execute_standard_list(
        db,
        select(SavedViewDefault).where(
            SavedViewDefault.user_id == user.id,
            SavedViewDefault.view_id.in_(visible_view_ids),
        ),
        params,
        DEFAULT_SPEC,
    )
    view_ids = [item.view_id for item in result.items]
    views = {
        item.id: item
        for item in db.scalars(select(SavedView).where(SavedView.id.in_(view_ids))).all()
    }
    items = [
        ViewDefaultResponse(
            module_id=item.module_id,
            view_id=item.view_id,
            revision=views[item.view_id].revision,
        )
        for item in result.items
        if item.view_id in views
    ]
    return StandardListResponse(items=items, pagination=result.pagination)


@router.put("/defaults/{module_id}", response_model=ViewDefaultResponse)
def set_personal_default(
    module_id: UUID,
    payload: ViewDefaultSet,
    user: Writer,
    db: Database,
) -> ViewDefaultResponse:
    module = db.scalar(
        select(Module)
        .where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
        )
        .with_for_update()
    )
    if module is None:
        raise _conflict("default_view_invalid", "The default view is unavailable")
    view = db.scalar(
        select(SavedView)
        .where(
            SavedView.id == payload.view_id,
            SavedView.module_id == module_id,
            SavedView.is_deleted.is_(False),
            visible_to(user),
        )
        .with_for_update()
    )
    if view is None:
        raise _conflict("default_view_invalid", "The default view is unavailable")
    existing = db.scalar(
        select(SavedViewDefault).where(
            SavedViewDefault.user_id == user.id,
            SavedViewDefault.module_id == module_id,
        )
    )
    if existing is not None and existing.view_id == view.id:
        return ViewDefaultResponse(module_id=module_id, view_id=view.id, revision=view.revision)
    if existing is None:
        existing = SavedViewDefault(user_id=user.id, module_id=module_id, view_id=view.id)
        db.add(existing)
    else:
        existing.view_id = view.id
    _commit(db, "default_view_invalid", "Unable to save the default view")
    return ViewDefaultResponse(module_id=module_id, view_id=view.id, revision=view.revision)


@router.delete("/defaults/{module_id}", status_code=status.HTTP_204_NO_CONTENT)
def unset_personal_default(module_id: UUID, user: Writer, db: Database) -> Response:
    existing = db.scalar(
        select(SavedViewDefault).where(
            SavedViewDefault.user_id == user.id,
            SavedViewDefault.module_id == module_id,
        )
    )
    if existing is not None:
        db.delete(existing)
        _commit(db, "default_view_invalid", "Unable to remove the default view")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
