"""Typed Board widget configuration and revisioned mutation contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest
from app.common.listing.schemas import PaginationMetadata
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.query_schemas import FieldReference, QueryFilter


class BoardWidgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    fields: list[FieldReference] = Field(default_factory=list, max_length=24)
    filters: list[QueryFilter] = Field(default_factory=list, max_length=8)
    logic: Literal["and", "or"] = "and"
    metric: FieldReference | None = None
    visualization: Literal["bar", "line", "pie"] = "bar"
    size: Literal["half", "full"] = "half"
    refresh: Literal["manual", "one-minute", "five-minutes"] = "manual"
    pinned: bool = False

    @model_validator(mode="after")
    def validate_references(self) -> Self:
        if len({item.field_id for item in self.fields}) != len(self.fields):
            raise ValueError("Widget fields must be distinct")
        if self.metric and self.metric.expected_type not in {
            FieldType.NUMBER,
            FieldType.DECIMAL,
            FieldType.INTEGER,
        }:
            raise ValueError("Widget metric must be numeric")
        return self


class BoardWidgetSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    widget_type: Literal["summary", "workload", "records", "chart"]
    module_id: UUID
    config: BoardWidgetConfig


class BoardWidgetWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    widget: BoardWidgetSpec


class BoardWidgetOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    widget_ids: list[UUID] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def unique_ids(self) -> Self:
        if len(set(self.widget_ids)) != len(self.widget_ids):
            raise ValueError("Widget order must contain distinct IDs")
        return self


class BoardWidgetRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)


class BoardWidgetSort(StrEnum):
    POSITION = "position"
    CREATED_AT = "created_at"


class BoardWidgetListRequest(StandardListRequest[BoardWidgetSort]):
    pass


class BoardWidgetResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    board_id: UUID
    name: str
    widget_type: Literal["summary", "workload", "records", "chart"]
    module_id: UUID
    position: int = Field(ge=0, lt=12)
    config: BoardWidgetConfig
    created_at: datetime
    updated_at: datetime


class BoardWidgetMutationResponse(BaseModel):
    widget: BoardWidgetResponse
    board_revision: int


class BoardWidgetListResponse(BaseModel):
    items: list[BoardWidgetResponse] = Field(max_length=12)
    pagination: PaginationMetadata
    board_revision: int


class BoardWidgetOrderResponse(BaseModel):
    items: list[BoardWidgetResponse] = Field(max_length=12)
    board_revision: int
