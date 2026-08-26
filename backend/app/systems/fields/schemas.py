from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.systems.fields.models import FieldType
from app.systems.fields.validation import field_config


def validate_field_config(field_type: FieldType, config: dict[str, Any]) -> dict[str, Any]:
    return field_config(field_type, config)


def _trim_name(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


class FieldCreate(BaseModel):
    module_id: UUID
    name: str = Field(min_length=1, max_length=150)
    type: FieldType
    required: bool = False
    position: int = Field(ge=0)
    config: dict[str, Any] = Field(default_factory=dict)
    relationship_target_module_id: UUID | None = None
    relationship_multiple_targets: bool | None = None
    relationship_multiple_sources: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: Any) -> Any:
        return _trim_name(value)

    @model_validator(mode="after")
    def validate_config(self) -> "FieldCreate":
        metadata = (
            self.relationship_target_module_id,
            self.relationship_multiple_targets,
            self.relationship_multiple_sources,
        )
        if self.type is FieldType.RELATIONSHIP:
            if any(value is None for value in metadata):
                raise ValueError("Relationship fields require complete relationship metadata")
            if self.required:
                raise ValueError("Relationship fields cannot be required")
            if self.config:
                raise ValueError("Relationship fields cannot have configuration")
        elif any(value is not None for value in metadata):
            raise ValueError("Primitive fields cannot have relationship metadata")
        validate_field_config(self.type, self.config)
        return self


class FieldUpdate(BaseModel):
    module_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=150)
    type: FieldType | None = None
    required: bool | None = None
    position: int | None = Field(default=None, ge=0)
    config: dict[str, Any] | None = None
    relationship_target_module_id: UUID | None = None
    relationship_multiple_targets: bool | None = None
    relationship_multiple_sources: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: Any) -> Any:
        return _trim_name(value)

    @model_validator(mode="after")
    def validate_config_when_type_is_present(self) -> "FieldUpdate":
        metadata = (
            self.relationship_target_module_id,
            self.relationship_multiple_targets,
            self.relationship_multiple_sources,
        )
        if self.type is FieldType.RELATIONSHIP:
            if self.required is True:
                raise ValueError("Relationship fields cannot be required")
            if self.config:
                raise ValueError("Relationship fields cannot have configuration")
        elif self.type is not None:
            if any(value is not None for value in metadata):
                raise ValueError("Primitive fields cannot have relationship metadata")
            if self.config is not None:
                validate_field_config(self.type, self.config)
            else:
                validate_field_config(self.type, {})
        return self


class FieldReorder(BaseModel):
    field_ids: list[UUID] = Field(min_length=1)


class FieldResponse(FieldCreate):
    id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)
