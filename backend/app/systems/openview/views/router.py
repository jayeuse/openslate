from dataclasses import replace
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import select, tuple_
from sqlalchemy.exc import IntegrityError
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
from app.systems.access.policy.checks import require_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import EffectiveAccess, effective_levels, includes
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import User
from app.systems.openview.views.access import visible_to
from app.systems.openview.views.catalog import router as catalog_router
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.schemas import (
    ViewCreate,
    ViewPresentation,
    ViewResponse,
    ViewRestore,
    ViewUpdate,
)
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import invalid_view, validate_definition
from app.systems.sandbox.records.query_schemas import QueryDefinition

router = APIRouter(prefix="/views", tags=["views"])
router.include_router(catalog_router)
Reader = Annotated[User, Depends(get_current_user)]
# Changing a view needs ``manage`` on its module; each route checks the module.
Writer = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class ViewSort(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class ViewList(StandardListRequest[ViewSort]):
    module_id: UUID | None = None


VIEW_SPEC = ListQuerySpec(
    sort_fields={
        ViewSort.NAME: cast(ColumnElement[Any], SavedView.name),
        ViewSort.CREATED_AT: cast(ColumnElement[Any], SavedView.created_at),
        ViewSort.UPDATED_AT: cast(ColumnElement[Any], SavedView.updated_at),
    },
    default_sort=ViewSort.NAME,
    tie_breaker=cast(ColumnElement[Any], SavedView.id),
    deleted_field=cast(ColumnElement[bool], SavedView.is_deleted),
    search_fields=(cast(ColumnElement[str], SavedView.name),),
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="View not found")


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _stale_revision(current_revision: int) -> HTTPException:
    return _conflict(
        "stale_revision",
        "View changed; reload before saving",
        current_revision=current_revision,
    )


def _active_module(db: Session, module_id: UUID) -> Module:
    module = db.scalar(
        select(Module)
        .where(
            Module.id == module_id,
            Module.is_deleted.is_(False),
        )
        .with_for_update()
    )
    if module is None:
        raise invalid_view("The module is unavailable")
    return module


def _can_edit(access: EffectiveAccess, view: SavedView) -> bool:
    return includes(access.module_level(view.module_id), AccessLevel.MANAGE)


def _view_response(view: SavedView, can_edit: bool) -> ViewResponse:
    return ViewResponse(
        id=view.id,
        module_id=view.module_id,
        name=view.name,
        is_default=view.is_default,
        definition=QueryDefinition.model_validate(view.definition),
        presentation=ViewPresentation.model_validate(view.presentation),
        revision=view.revision,
        is_deleted=view.is_deleted,
        can_edit=can_edit,
        created_at=view.created_at,
        updated_at=view.updated_at,
    )


def _managed_response(view: SavedView) -> ViewResponse:
    """Response after a change: only a manager of the module can change a view."""

    return _view_response(view, can_edit=True)


def _clear_default(db: Session, module_id: UUID, *, keep: UUID | None) -> None:
    """Clear the module's current default view. The caller holds the module lock."""

    current = db.scalars(
        select(SavedView)
        .where(
            SavedView.module_id == module_id,
            SavedView.is_default.is_(True),
            SavedView.is_deleted.is_(False),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    for view in current:
        if view.id != keep:
            view.is_default = False
            view.revision += 1
    db.flush()


def _validate_definition(
    db: Session, user: User, module_id: UUID, definition: QueryDefinition
) -> None:
    fields = validate_definition(db, module_id, definition, reader=user)
    references = [
        *definition.columns,
        *definition.filters,
        *definition.sort,
        *definition.search_fields,
    ]
    if any(fields[reference.field_id].is_deleted for reference in references):
        raise invalid_view("A referenced field is no longer active")


def _validate_presentation(
    db: Session,
    module_id: UUID,
    presentation: ViewPresentation,
    definition: QueryDefinition,
) -> None:
    if presentation.layout == "timeline" and (
        presentation.timeline_start_field_id is None or presentation.timeline_end_field_id is None
    ):
        raise invalid_view("Timeline presentation requires start and end fields")

    field_ids = {
        *presentation.column_field_ids,
        *presentation.pinned_field_ids,
        *(
            field_id
            for field_id in (
                presentation.primary_field_id,
                presentation.secondary_field_id,
                presentation.date_field_id,
                presentation.timeline_start_field_id,
                presentation.timeline_end_field_id,
                presentation.timeline_deadline_field_id,
                presentation.timeline_progress_field_id,
                presentation.group_by_field_id,
            )
            if field_id is not None
        ),
    }
    if not field_ids:
        return
    definition_field_ids = {reference.field_id for reference in definition.columns}
    if not field_ids.issubset(definition_field_ids):
        raise invalid_view("Presentation fields must be included in query columns")
    fields = {
        field.id: field
        for field in db.scalars(
            select(Field).where(Field.module_id == module_id, Field.id.in_(field_ids))
        ).all()
    }
    if len(fields) != len(field_ids) or any(field.is_deleted for field in fields.values()):
        raise invalid_view("A presentation field is unavailable")
    date_types = {FieldType.DATE, FieldType.DATETIME}
    if (
        presentation.date_field_id is not None
        and fields[presentation.date_field_id].type not in date_types
    ):
        raise invalid_view("Calendar presentation requires a date or datetime field")
    timeline_date_ids = {
        field_id
        for field_id in (
            presentation.timeline_start_field_id,
            presentation.timeline_end_field_id,
            presentation.timeline_deadline_field_id,
        )
        if field_id is not None
    }
    if any(fields[field_id].type not in date_types for field_id in timeline_date_ids):
        raise invalid_view("Timeline interval roles must be date or datetime fields")
    if presentation.timeline_progress_field_id is not None and fields[
        presentation.timeline_progress_field_id
    ].type not in {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}:
        raise invalid_view("Timeline progress must use a numeric field")


def get_view(db: Session, user: User, view_id: UUID, *, write: bool = False) -> SavedView:
    statement = select(SavedView).where(SavedView.id == view_id, visible_to(db, user))
    if write:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    view = db.scalar(statement)
    if view is None:
        raise _not_found()
    if write:
        require_module_access(db, user, view.module_id, AccessLevel.MANAGE)
    return view


def commit(
    db: Session,
    *,
    code: str = "view_invalid",
    message: str = "Unable to save view",
) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict(code, message) from error


@router.get("", response_model=StandardListResponse[ViewResponse])
def list_views(
    user: Reader,
    db: Database,
    params: Annotated[ViewList, Query()],
    request: Request,
) -> StandardListResponse[ViewResponse]:
    statement = select(SavedView).where(visible_to(db, user))
    if params.module_id is not None:
        statement = statement.where(SavedView.module_id == params.module_id)
    spec = VIEW_SPEC
    if "sort_by" not in request.query_params and "sort_order" not in request.query_params:
        spec = replace(
            VIEW_SPEC,
            sort_fields={
                **VIEW_SPEC.sort_fields,
                ViewSort.NAME: tuple_(SavedView.is_default.is_(False), SavedView.name),
            },
        )
    result = execute_standard_list(db, statement, params, spec)
    access = effective_levels(db, user)
    return StandardListResponse(
        items=[_view_response(item, _can_edit(access, item)) for item in result.items],
        pagination=result.pagination,
    )


@router.post("", response_model=ViewResponse, status_code=status.HTTP_201_CREATED)
def create_view(
    payload: ViewCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> ViewResponse:
    require_module_access(db, user, payload.module_id, AccessLevel.MANAGE)
    _active_module(db, payload.module_id)
    _validate_definition(db, user, payload.module_id, payload.definition)
    _validate_presentation(db, payload.module_id, payload.presentation, payload.definition)
    if payload.is_default:
        _clear_default(db, payload.module_id, keep=None)
    view = SavedView(
        org_id=sole_active_membership(db, user.id).org_id,
        module_id=payload.module_id,
        name=payload.name,
        is_default=payload.is_default,
        definition=payload.definition.model_dump(mode="json"),
        presentation=payload.presentation.model_dump(mode="json"),
    )
    db.add(view)
    commit(db)
    db.refresh(view)
    response.headers["Location"] = f"/api/views/{view.id}"
    return _managed_response(view)


@router.get("/{view_id}", response_model=ViewResponse)
def read_view(view_id: UUID, user: Reader, db: Database) -> ViewResponse:
    view = get_view(db, user, view_id)
    return _view_response(view, _can_edit(effective_levels(db, user), view))


@router.patch("/{view_id}", response_model=ViewResponse)
def update_view(
    view_id: UUID,
    payload: ViewUpdate,
    user: Writer,
    db: Database,
) -> ViewResponse:
    current = get_view(db, user, view_id)
    require_module_access(db, user, current.module_id, AccessLevel.MANAGE)
    _active_module(db, current.module_id)
    view = get_view(db, user, view_id, write=True)
    if view.revision != payload.revision:
        raise _stale_revision(view.revision)
    if view.is_deleted:
        raise _conflict("view_archived", "Restore the view before editing it")

    definition = (
        payload.definition
        if payload.definition is not None
        else QueryDefinition.model_validate(view.definition)
    )
    presentation = (
        payload.presentation
        if payload.presentation is not None
        else ViewPresentation.model_validate(view.presentation)
    )
    _validate_definition(db, user, view.module_id, definition)
    _validate_presentation(db, view.module_id, presentation, definition)

    name = payload.name if payload.name is not None else view.name
    normalized_definition = definition.model_dump(mode="json")
    normalized_presentation = presentation.model_dump(mode="json")
    current_presentation = ViewPresentation.model_validate(view.presentation).model_dump(
        mode="json"
    )
    is_default = payload.is_default if payload.is_default is not None else view.is_default
    if (
        view.name == name
        and view.definition == normalized_definition
        and current_presentation == normalized_presentation
        and view.is_default == is_default
    ):
        return _managed_response(view)

    if is_default and not view.is_default:
        _clear_default(db, view.module_id, keep=view.id)
    view.name = name
    view.definition = normalized_definition
    if current_presentation != normalized_presentation:
        view.presentation = normalized_presentation
    view.is_default = is_default
    view.revision += 1
    commit(db)
    db.refresh(view)
    return _managed_response(view)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_view(
    view_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
) -> Response:
    current = get_view(db, user, view_id)
    require_module_access(db, user, current.module_id, AccessLevel.MANAGE)
    _active_module(db, current.module_id)
    view = get_view(db, user, view_id, write=True)
    if view.revision != revision:
        raise _stale_revision(view.revision)
    if view.is_deleted:
        raise _conflict("view_archived", "The view is already archived")
    # An archived view is no longer the module's default.
    view.is_default = False
    view.is_deleted = True
    view.deleted_at = datetime.now(UTC)
    view.revision += 1
    commit(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{view_id}/restore", response_model=ViewResponse)
def restore_view(
    view_id: UUID,
    payload: ViewRestore,
    user: Writer,
    db: Database,
) -> ViewResponse:
    current = get_view(db, user, view_id)
    require_module_access(db, user, current.module_id, AccessLevel.MANAGE)
    _active_module(db, current.module_id)
    view = get_view(db, user, view_id, write=True)
    if view.revision != payload.revision:
        raise _stale_revision(view.revision)
    if not view.is_deleted:
        raise _conflict("view_not_archived", "The view is already active")
    view.is_deleted = False
    view.deleted_at = None
    view.revision += 1
    commit(db)
    db.refresh(view)
    return _managed_response(view)
