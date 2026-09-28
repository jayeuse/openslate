"""Versioned, structure-only Board configuration for trusted server-side resolution.

Version 3 carries the Board name, description and tiles. Scope and access are not
portable: an import always creates a project Board without groups.
"""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.query_schemas import QueryFilter, Scalar


class PortableFieldReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=150)
    expected_type: FieldType

    @model_validator(mode="after")
    def primitive_named_field(self) -> Self:
        if not self.name.strip() or self.expected_type == FieldType.RELATIONSHIP:
            raise ValueError("A named primitive field is required")
        return self


class PortableQueryFilter(PortableFieldReference):
    operator: Literal[
        "eq",
        "neq",
        "lt",
        "lte",
        "gt",
        "gte",
        "contains",
        "prefix",
        "suffix",
        "in",
        "empty",
        "not_empty",
        "blank",
        "not_blank",
    ]
    value: Scalar | Annotated[list[Scalar], Field(min_length=1, max_length=100)] | None = None

    @model_validator(mode="after")
    def matching_operator_and_value(self) -> Self:
        # Reuse the live query grammar; the placeholder never enters the bundle.
        QueryFilter(
            field_id=UUID(int=0),
            expected_type=self.expected_type,
            operator=self.operator,
            value=self.value,
        )
        return self


class PortableWidgetSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_name: str = Field(min_length=1, max_length=150)
    module_name: str = Field(min_length=1, max_length=150)

    @model_validator(mode="after")
    def named_source(self) -> Self:
        if not self.department_name.strip() or not self.module_name.strip():
            raise ValueError("A named department and module are required")
        return self


class PortableWidgetConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    fields: list[PortableFieldReference] = Field(max_length=24)
    filters: list[PortableQueryFilter] = Field(max_length=8)
    logic: Literal["and", "or"]
    metric: PortableFieldReference | None
    visualization: Literal["bar", "line", "pie"]
    size: Literal["half", "full"]
    refresh: Literal["manual", "one-minute", "five-minutes"]
    pinned: StrictBool

    @model_validator(mode="after")
    def distinct_fields_and_numeric_metric(self) -> Self:
        if len({field.name for field in self.fields}) != len(self.fields):
            raise ValueError("Widget fields must be distinct")
        if self.metric and self.metric.expected_type not in {
            FieldType.NUMBER,
            FieldType.DECIMAL,
            FieldType.INTEGER,
        }:
            raise ValueError("Widget metric must be numeric")
        return self


class PortableWidget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)
    widget_type: Literal["summary", "workload", "records", "chart"]
    source: PortableWidgetSource
    config: PortableWidgetConfig

    @model_validator(mode="after")
    def named_widget(self) -> Self:
        if not self.name.strip():
            raise ValueError("Widget name is required")
        return self


class PortableBoardConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(max_length=240)
    widgets: list[PortableWidget] = Field(max_length=12)

    @model_validator(mode="after")
    def named_board(self) -> Self:
        if not self.name.strip():
            raise ValueError("A named Board is required")
        return self


class PortableBoardBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["openslate-board"]
    version: Literal[3]
    configuration: PortableBoardConfiguration

    @field_validator("version", mode="before")
    @classmethod
    def integer_version_only(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Bundle version must be an integer")
        return value
