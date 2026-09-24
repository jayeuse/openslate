from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_capability
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.models import Role, User
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.openview.views.access import visible_to
from app.systems.openview.views.catalog import router as catalog_router
from app.systems.openview.views.models import AudienceKind, SavedView
from app.systems.openview.views.schemas import (
    ViewAudience,
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
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_capability(Capability.RECORDS_WRITE))]
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
            Module.is_schema_accepted.is_(True),
        )
        .with_for_update()
    )
    if module is None:
        raise invalid_view("The module is unavailable")
    return module


def _view_audience(view: SavedView) -> ViewAudience:
    return ViewAudience(
        kind=AudienceKind(view.audience_kind).value,
        role_id=view.audience_role_id,
        user_id=view.audience_user_id,
    )


def _view_response(view: SavedView, user: User) -> ViewResponse:
    return ViewResponse(
        id=view.id,
        module_id=view.module_id,
        owner_id=view.owner_id,
        name=view.name,
        visibility=view.visibility,
        audience=_view_audience(view),
        definition=QueryDefinition.model_validate(view.definition),
        presentation=ViewPresentation.model_validate(view.presentation),
        revision=view.revision,
        is_deleted=view.is_deleted,
        can_edit=view.owner_id == user.id and has_capability(user.role, Capability.RECORDS_WRITE),
        created_at=view.created_at,
        updated_at=view.updated_at,
    )


def _validate_definition(db: Session, module_id: UUID, definition: QueryDefinition) -> None:
    fields = validate_definition(db, module_id, definition)
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
        presentation.timeline_start_field_id is None
        or presentation.timeline_end_field_id is None
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


def _validate_audience(db: Session, audience: ViewAudience) -> None:
    if audience.kind == "role":
        valid = db.scalar(
            select(Role.id)
            .where(Role.id == audience.role_id, Role.is_deleted.is_(False))
            .with_for_update()
        )
    elif audience.kind == "user":
        valid = db.scalar(
            select(User.id).where(
                User.id == audience.user_id,
                User.status == "active",
                User.is_deleted.is_(False),
            ).with_for_update()
        )
    else:
        return
    if valid is None:
        raise _conflict("audience_invalid", "The selected audience is unavailable")


def _audience_columns(audience: ViewAudience) -> tuple[AudienceKind, UUID | None, UUID | None]:
    return AudienceKind(audience.kind), audience.role_id, audience.user_id


def get_view(db: Session, user: User, view_id: UUID, *, write: bool = False) -> SavedView:
    statement = select(SavedView).where(SavedView.id == view_id, visible_to(user))
    if write:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    view = db.scalar(statement)
    if view is None:
        raise _not_found()
    if write and view.owner_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Forbidden")
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
) -> StandardListResponse[ViewResponse]:
    statement = select(SavedView).where(visible_to(user))
    if params.module_id is not None:
        statement = statement.where(SavedView.module_id == params.module_id)
    result = execute_standard_list(db, statement, params, VIEW_SPEC)
    return StandardListResponse(
        items=[_view_response(item, user) for item in result.items],
        pagination=result.pagination,
    )


@router.post("", response_model=ViewResponse, status_code=status.HTTP_201_CREATED)
def create_view(
    payload: ViewCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> ViewResponse:
    _active_module(db, payload.module_id)
    audience = payload.audience or ViewAudience(kind="private")
    _validate_audience(db, audience)
    _validate_definition(db, payload.module_id, payload.definition)
    _validate_presentation(db, payload.module_id, payload.presentation, payload.definition)
    audience_kind, role_id, audience_user_id = _audience_columns(audience)
    view = SavedView(
        module_id=payload.module_id,
        owner_id=user.id,
        name=payload.name,
        visibility=audience.visibility,
        audience_kind=audience_kind,
        audience_role_id=role_id,
        audience_user_id=audience_user_id,
        definition=payload.definition.model_dump(mode="json"),
        presentation=payload.presentation.model_dump(mode="json"),
    )
    db.add(view)
    commit(db)
    db.refresh(view)
    response.headers["Location"] = f"/api/views/{view.id}"
    return _view_response(view, user)


@router.get("/{view_id}", response_model=ViewResponse)
def read_view(view_id: UUID, user: Reader, db: Database) -> ViewResponse:
    return _view_response(get_view(db, user, view_id), user)


@router.patch("/{view_id}", response_model=ViewResponse)
def update_view(
    view_id: UUID,
    payload: ViewUpdate,
    user: Writer,
    db: Database,
) -> ViewResponse:
    current = get_view(db, user, view_id)
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
    _validate_definition(db, view.module_id, definition)
    _validate_presentation(db, view.module_id, presentation, definition)

    audience = _view_audience(view)
    if payload.audience is not None:
        audience = payload.audience
        _validate_audience(db, audience)
    elif payload.visibility == "private":
        audience = ViewAudience(kind="private")
    elif payload.visibility == "workspace" and view.visibility == "private":
        audience = ViewAudience(kind="everyone")

    name = payload.name if payload.name is not None else view.name
    normalized_definition = definition.model_dump(mode="json")
    normalized_presentation = presentation.model_dump(mode="json")
    current_presentation = ViewPresentation.model_validate(view.presentation).model_dump(
        mode="json"
    )
    audience_kind, role_id, audience_user_id = _audience_columns(audience)
    visibility = audience.visibility
    if (
        view.name == name
        and view.definition == normalized_definition
        and current_presentation == normalized_presentation
        and view.audience_kind == audience_kind
        and view.audience_role_id == role_id
        and view.audience_user_id == audience_user_id
        and view.visibility == visibility
    ):
        return _view_response(view, user)

    view.name = name
    view.definition = normalized_definition
    if current_presentation != normalized_presentation:
        view.presentation = normalized_presentation
    view.audience_kind = audience_kind
    view.audience_role_id = role_id
    view.audience_user_id = audience_user_id
    view.visibility = visibility
    view.revision += 1
    commit(db)
    db.refresh(view)
    return _view_response(view, user)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_view(
    view_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
) -> Response:
    current = get_view(db, user, view_id)
    _active_module(db, current.module_id)
    view = get_view(db, user, view_id, write=True)
    if view.revision != revision:
        raise _stale_revision(view.revision)
    if view.is_deleted:
        raise _conflict("view_archived", "The view is already archived")
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
    return _view_response(view, user)
