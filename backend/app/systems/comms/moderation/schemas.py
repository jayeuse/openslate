from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, field_validator

from app.systems.comms.messages.schemas import WireModel


class ReportRequest(WireModel):
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason", mode="before")
    @classmethod
    def trimmed(cls, value: object) -> object:
        if isinstance(value, str):
            if "\x00" in value:
                raise ValueError("Report text cannot contain NUL")
            try:
                value.encode("utf-8")
            except UnicodeError as exc:
                raise ValueError("Report text must be valid Unicode") from exc
            return value.strip()
        return value


class CommsReportResponse(WireModel):
    id: UUID
    org_id: UUID
    created_at: datetime
    updated_at: datetime
    conversation_id: UUID
    message_id: UUID
    reporter_id: UUID
    reason: str
    status: Literal["open", "resolved"]


class RevisionResponse(WireModel):
    id: UUID
    message_id: UUID
    author_id: UUID
    created_at: datetime
    body: str


class RestrictionRequest(WireModel):
    user_ids: list[UUID]
    until: AwareDatetime | None

    @field_validator("user_ids")
    @classmethod
    def distinct(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("People must be distinct")
        return value
