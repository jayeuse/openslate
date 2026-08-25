from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.common.normalization import normalize_email, normalize_username


class InvitationCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    username: str = Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    role_id: UUID | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return normalize_email(value)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)
