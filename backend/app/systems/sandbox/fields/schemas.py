from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import field_config


def validate_field_config(field_type: FieldType, config: dict[str, Any]) -> dict[str, Any]:
    return field_config(field_type, config)


def _trim_name(value: Any) -> Any:
    return value.strip() if isinstance(value, str) else value


class FieldResponse(BaseModel):
    module_id: UUID
    name: str = Field(min_length=1, max_length=150)
    type: FieldType
    required: bool = False
    position: int = Field(ge=0)
    audit_redacted: bool = False
    config: dict[str, Any] = Field(default_factory=dict)
    relationship_target_module_id: UUID | None = None
    relationship_multiple_targets: bool | None = None
    relationship_multiple_sources: bool | None = None

    id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value: Any) -> Any:
        return _trim_name(value)

    @model_validator(mode="after")
    def validate_config(self) -> "FieldResponse":
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
        self.config = validate_field_config(self.type, self.config)
        return self

    @field_validator("audit_redacted", mode="before")
    @classmethod
    def default_missing_audit_redaction(cls, value: Any) -> Any:
        return False if value is None else value
