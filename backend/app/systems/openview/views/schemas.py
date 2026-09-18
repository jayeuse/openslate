from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.systems.sandbox.records.query_schemas import QueryDefinition


class ViewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    module_id: UUID
    name: str = Field(min_length=1, max_length=200)
    visibility: Literal["private", "workspace"] = "private"
    definition: QueryDefinition


class ViewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    definition: QueryDefinition | None = None

    @model_validator(mode="after")
    def nonempty_update(self) -> Self:
        changed = self.model_fields_set - {"revision"}
        if not changed or any(getattr(self, key) is None for key in changed):
            raise ValueError("At least one non-null change is required")
        return self


class ViewResponse(ViewCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    owner_id: UUID
    revision: int
    is_deleted: bool
    created_at: datetime
    updated_at: datetime
