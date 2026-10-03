"""Administrator CSV batch preview/import command (explicitly non-idempotent)."""

from typing import Annotated, Any, Literal, Self
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, model_validator
from pydantic import Field as SchemaField
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin
from app.core.database import get_db
from app.systems.access.policy.checks import require_module_access
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.importing import (
    PreparedImportRow,
    create_import_records,
    creation_schema_digest,
    prepare_import_rows,
    selected_import_fields,
)
from app.systems.sandbox.relationships.errors import RelationshipError
from app.systems.sandbox.relationships.locking import lock_row

router = APIRouter(prefix="/records", tags=["records"])
Admin = Annotated[User, Depends(require_admin)]
Database = Annotated[Session, Depends(get_db)]


class RecordImportMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column_index: int = SchemaField(ge=0, strict=True)
    field_id: UUID


class RecordImportRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    row_number: int = SchemaField(ge=2, strict=True)
    cells: list[str]


class RecordImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["preview", "import"]
    module_id: UUID
    headers: list[str]
    mapping: list[RecordImportMapping] = SchemaField(min_length=1)
    rows: list[RecordImportRow] = SchemaField(max_length=100)
    defaults: dict[UUID, Any]
    schema_digest: str | None = SchemaField(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def valid_batch(self) -> Self:
        columns = [item.column_index for item in self.mapping]
        field_ids = [item.field_id for item in self.mapping]
        if len(set(columns)) != len(columns) or len(set(field_ids)) != len(field_ids):
            raise ValueError("Mapping columns and fields must be unique")
        if any(column >= len(self.headers) for column in columns):
            raise ValueError("Mapping columns must be within the headers")
        if set(field_ids) & self.defaults.keys():
            raise ValueError("Defaults may only apply to unmapped fields")
        numbers = [row.row_number for row in self.rows]
        if len(set(numbers)) != len(numbers):
            raise ValueError("Row numbers must be unique")
        if any(len(row.cells) != len(self.headers) for row in self.rows):
            raise ValueError("Each row must match the header count")
        if self.mode == "import" and self.schema_digest is None:
            raise ValueError("Import requires the preview schema digest")
        return self


class RecordImportIssue(BaseModel):
    code: str
    message: str
    field_id: UUID | None
    column_index: int | None


class RecordImportRowResponse(BaseModel):
    row_number: int
    status: Literal["valid", "invalid", "created"]
    record_id: UUID | None
    data: dict[str, Any]
    errors: list[RecordImportIssue]


class RecordImportResponse(BaseModel):
    mode: Literal["preview", "import"]
    schema_digest: str
    rows: list[RecordImportRowResponse]
    valid_count: int
    invalid_count: int
    created_count: int


def _row_response(row: PreparedImportRow, columns: dict[UUID, int]) -> RecordImportRowResponse:
    return RecordImportRowResponse(
        row_number=row.row_number,
        status="invalid" if row.issues else "created" if row.record_id is not None else "valid",
        record_id=row.record_id,
        data=row.data,
        errors=[
            RecordImportIssue(
                code=issue.code,
                message=issue.message,
                field_id=issue.field_id,
                column_index=columns.get(issue.field_id) if issue.field_id is not None else None,
            )
            for issue in row.issues
        ],
    )


@router.post(
    "/import",
    response_model=RecordImportResponse,
    responses={
        409: {"description": "Schema changed or the batch could not be persisted"},
        503: {"description": "Import outcome could not be confirmed"},
    },
)
def import_records(
    payload: RecordImportRequest,
    actor: Admin,
    db: Database,
    response: Response,
) -> RecordImportResponse:
    """Preview never writes; import commits valid rows once and must never be auto-retried."""

    response.headers["Cache-Control"] = "private, no-store"
    require_module_access(db, actor, payload.module_id, AccessLevel.WRITE)
    try:
        module = lock_row(db, Module, payload.module_id)
    except RelationshipError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    if module is None or module.is_deleted:
        raise HTTPException(status_code=409, detail="Module is not active")
    fields = list(db.scalars(select(Field).where(Field.module_id == module.id)).all())
    digest = creation_schema_digest(fields)
    if payload.mode == "import" and payload.schema_digest != digest:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "schema_changed",
                "message": "Module schema changed; preview again",
            },
        )
    defaults = {str(field_id): value for field_id, value in payload.defaults.items()}
    try:
        selected = selected_import_fields(
            fields,
            [(item.column_index, item.field_id) for item in payload.mapping],
            defaults,
        )
    except ValueError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_import_mapping",
                "message": str(error),
            },
        ) from error
    prepared = prepare_import_rows(
        db,
        module.id,
        fields,
        selected,
        [(row.row_number, row.cells) for row in payload.rows],
        defaults,
    )
    columns = {item.field_id: item.column_index for item in payload.mapping}
    valid_count = sum(not row.issues for row in prepared)
    try:
        if payload.mode == "import" and valid_count:
            create_import_records(db, module.id, prepared)
        result = RecordImportResponse(
            mode=payload.mode,
            schema_digest=digest,
            rows=[_row_response(row, columns) for row in prepared],
            valid_count=valid_count,
            invalid_count=len(prepared) - valid_count,
            created_count=valid_count if payload.mode == "import" else 0,
        )
        if payload.mode == "import" and valid_count:
            db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "record_import_failed",
                "message": "Unable to import records",
            },
        ) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={
                "code": "record_import_unconfirmed",
                "message": "Import outcome could not be confirmed",
            },
        ) from error
    return result
