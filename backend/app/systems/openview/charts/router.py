"""Current-user Chart preference reads and writes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.dependencies import require_legacy_capability
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.openview.charts.models import UserChartPreference
from app.systems.openview.charts.schemas import (
    ChartPreferenceConfig,
    ChartPreferenceResponse,
    ChartPreferenceUpdate,
)
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import validate_definition
from app.systems.sandbox.records.query_schemas import FieldReference, QueryDefinition

router = APIRouter(prefix="/charts", tags=["charts"])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
ReadWriter = Annotated[
    User,
    Depends(
        require_legacy_capability(
            Capability.RECORDS_READ,
            Capability.RECORDS_WRITE,
        )
    ),
]
Database = Annotated[Session, Depends(get_db)]

_CATEGORICAL_TYPES = {
    FieldType.TEXT,
    FieldType.LONG_TEXT,
    FieldType.EMAIL,
    FieldType.URL,
    FieldType.BOOLEAN,
    FieldType.SELECT,
}
_NUMERIC_TYPES = {FieldType.NUMBER, FieldType.DECIMAL, FieldType.INTEGER}
_DATE_TYPES = {FieldType.DATE, FieldType.DATETIME}


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _invalid_preferences() -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "chart_preferences_invalid",
            "message": "Chart settings reference unavailable or changed fields",
        },
    )


def _field_by_id(
    fields: dict[UUID, Field], field_id: UUID | None, *, allowed: set[FieldType]
) -> Field | None:
    if field_id is None:
        return None
    field = fields.get(field_id)
    if field is None or field.is_deleted or field.type not in allowed:
        raise _invalid_preferences()
    return field


def _validate_preferences(db: Session, config: ChartPreferenceConfig) -> None:
    module = db.scalar(
        select(Module)
        .where(
            Module.id == config.module_id,
            Module.is_deleted.is_(False),
            Module.is_schema_accepted.is_(True),
        )
        .with_for_update()
    )
    if module is None:
        raise _invalid_preferences()

    fields = {
        field.id: field
        for field in db.scalars(
            select(Field).where(Field.module_id == config.module_id).order_by(Field.id)
        ).all()
    }
    if config.chart_type == "line":
        dimension = None
    else:
        dimension = _field_by_id(
            fields, config.dimension_id, allowed=_CATEGORICAL_TYPES
        )
        if dimension is None:
            raise _invalid_preferences()
    date_field = _field_by_id(fields, config.date_field_id, allowed=_DATE_TYPES)
    measure = _field_by_id(fields, config.measure_id, allowed=_NUMERIC_TYPES)
    if config.aggregation == "count":
        if measure is not None:
            raise _invalid_preferences()
    elif measure is None:
        raise _invalid_preferences()

    extra_references = [
        FieldReference(field_id=field.id, expected_type=field.type)
        for field in (dimension, date_field, measure)
        if field is not None
    ]
    definition = QueryDefinition(
        version=1,
        logic=config.filter_logic,
        filters=config.filters,
    )
    try:
        validate_definition(
            db,
            config.module_id,
            definition,
            extra_references=extra_references,
        )
    except HTTPException as error:
        if error.status_code == status.HTTP_409_CONFLICT:
            raise _invalid_preferences() from error
        raise


def _response(row: UserChartPreference | None) -> ChartPreferenceResponse:
    if row is None:
        return ChartPreferenceResponse(config=None)
    return ChartPreferenceResponse(config=ChartPreferenceConfig.model_validate(row.config))


@router.get("/preferences", response_model=ChartPreferenceResponse)
def get_chart_preferences(
    response: Response,
    user: Reader,
    db: Database,
) -> ChartPreferenceResponse:
    _private_cache(response)
    row = db.scalar(
        select(UserChartPreference).where(UserChartPreference.user_id == user.id)
    )
    return _response(row)


@router.put("/preferences", response_model=ChartPreferenceResponse)
def put_chart_preferences(
    payload: ChartPreferenceUpdate,
    response: Response,
    user: ReadWriter,
    db: Database,
) -> ChartPreferenceResponse:
    _private_cache(response)
    _validate_preferences(db, payload.config)
    row = db.scalar(
        select(UserChartPreference)
        .where(UserChartPreference.user_id == user.id)
        .with_for_update()
    )
    if row is None:
        row = UserChartPreference(
            user_id=user.id,
            config=payload.config.model_dump(mode="json"),
        )
        db.add(row)
    else:
        row.config = payload.config.model_dump(mode="json")
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "chart_preferences_conflict", "message": "Chart settings changed"},
        ) from error
    db.refresh(row)
    return _response(row)
