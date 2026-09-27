"""HTTP response contracts for recent record-trigger runs."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, JsonValue

from app.systems.sandbox.designs.schemas import StrictModel


class TriggerRunResponse(StrictModel):
    id: UUID
    created_at: datetime = Field(alias="createdAt")
    trigger_id: UUID = Field(alias="triggerId")
    trigger_name: Annotated[str, Field(min_length=1, max_length=80)] = Field(
        alias="triggerName"
    )
    event_kind: Literal["record-created", "field-changed", "schedule"] = Field(alias="eventKind")
    state: Literal["succeeded", "skipped", "suspended", "failed"]
    details: dict[str, JsonValue]
    attempts: Annotated[int, Field(ge=0, le=5)]


class TriggerRunListResponse(StrictModel):
    items: list[TriggerRunResponse]
    limit: Annotated[int, Field(ge=1, le=50)]
    offset: Annotated[int, Field(ge=0)]
    count: Annotated[int, Field(ge=0)]
    total: Annotated[int, Field(ge=0)]
    has_more: bool = Field(alias="hasMore")
