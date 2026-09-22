"""HTTP response contracts for recent published-automation runs."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, JsonValue

from app.systems.sandbox.designs.schemas import StrictModel


class AutomationRunResponse(StrictModel):
    id: UUID
    created_at: datetime = Field(alias="createdAt")
    automation_id: UUID = Field(alias="automationId")
    automation_name: Annotated[str, Field(min_length=1, max_length=80)] = Field(
        alias="automationName"
    )
    event_kind: Literal["record-created", "field-changed", "schedule"] = Field(alias="eventKind")
    state: Literal["succeeded", "skipped", "suspended", "failed"]
    details: dict[str, JsonValue]
    attempts: Annotated[int, Field(ge=0, le=5)]


class AutomationRunListResponse(StrictModel):
    items: list[AutomationRunResponse]
    limit: Annotated[int, Field(ge=1, le=50)]
    offset: Annotated[int, Field(ge=0)]
    count: Annotated[int, Field(ge=0)]
    total: Annotated[int, Field(ge=0)]
    has_more: bool = Field(alias="hasMore")
