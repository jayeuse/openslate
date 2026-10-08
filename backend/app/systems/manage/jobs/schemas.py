"""Private administrator metadata for registered durable work."""

from datetime import datetime
from enum import StrEnum
from typing import Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest


class JobSort(StrEnum):
    PRIORITY = "priority"
    SCHEDULED_FOR = "scheduled_for"
    LAST_ATTEMPT_AT = "last_attempt_at"
    SUBJECT_LABEL = "subject_label"
    STATE = "state"
    KIND = "kind"


class JobsListRequest(StandardListRequest[JobSort]):
    kind: str | None = Field(default=None, min_length=1, max_length=64)
    state: str | None = Field(default=None, min_length=1, max_length=32)
    scheduled_after: AwareDatetime | None = None
    scheduled_before: AwareDatetime | None = None

    @model_validator(mode="after")
    def ordered_bounds(self) -> Self:
        if self.scheduled_after is not None and self.scheduled_before is not None:
            if self.scheduled_after >= self.scheduled_before:
                raise ValueError("The scheduled end must follow the start")
        return self


class JobResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: str
    id: UUID
    subject_label: str
    subject_link: str | None
    state: str
    scheduled_for: datetime | None
    last_attempt_at: datetime | None
    next_attempt_at: datetime | None
    attempts: int = Field(ge=0)
    failure_code: str | None
    failure_label: str | None
    can_retry: bool
