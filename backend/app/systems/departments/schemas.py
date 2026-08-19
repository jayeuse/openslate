from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DepartmentCreate(BaseModel):
    department_name: str = Field(min_length=1, max_length=150)


class DepartmentUpdate(BaseModel):
    department_name: str | None = Field(default=None, min_length=1, max_length=150)


class DepartmentResponse(DepartmentCreate):
    id: UUID
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
