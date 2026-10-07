from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, JsonValue, field_validator


class RecordCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    module_id: UUID
    data: dict[str, Any] = Field(default_factory=dict)


class RecordUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    module_id: UUID | None = None
    data: dict[str, Any] | None = None


class RecordResponse(RecordCreate):
    id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None
    display_values: dict[str, str] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class RecordBatchItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_id: UUID
    revision: AwareDatetime
    field_id: UUID
    value: JsonValue

    @field_validator("revision", mode="before")
    @classmethod
    def timestamp_revision(cls, value: Any) -> Any:
        if not isinstance(value, (str, datetime)):
            raise ValueError("Revision must be the record's updated_at timestamp")
        return value


class RecordBatchUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    module_id: UUID
    items: list[RecordBatchItem] = Field(max_length=100)


class RecordBatchUpdated(BaseModel):
    status: Literal["updated"] = "updated"
    record_id: UUID
    record: RecordResponse


class RecordBatchStale(BaseModel):
    status: Literal["stale"] = "stale"
    record_id: UUID


class RecordBatchFieldError(BaseModel):
    code: str
    field_id: UUID | None
    message: str


class RecordBatchInvalid(BaseModel):
    status: Literal["invalid"] = "invalid"
    record_id: UUID
    errors: list[RecordBatchFieldError]
    truncated: bool = False


class RecordBatchForbidden(BaseModel):
    status: Literal["forbidden"] = "forbidden"
    record_id: UUID


RecordBatchResult = Annotated[
    RecordBatchUpdated | RecordBatchStale | RecordBatchInvalid | RecordBatchForbidden,
    Field(discriminator="status"),
]


class RecordBatchResponse(BaseModel):
    results: list[RecordBatchResult]
