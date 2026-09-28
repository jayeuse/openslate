"""Strict HTTP shapes for saved Sandbox test evidence."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from app.systems.sandbox.designs.schemas import ID, StrictModel

TestValue = str | int | Annotated[float, Field(allow_inf_nan=False)] | bool | None
NonNullTestValue = str | int | Annotated[float, Field(allow_inf_nan=False)] | bool
MAX_TRIGGER_TRACES = 5_500


class AddedEvent(StrictModel):
    kind: Literal["record-created"]


class ChangedFieldEvent(StrictModel):
    kind: Literal["field-changed"]
    field_id: ID = Field(alias="fieldId")
    previous_value: TestValue | None = Field(default=None, alias="previousValue")


class ThresholdEvent(StrictModel):
    kind: Literal["threshold-crossed"]
    field_id: ID = Field(alias="fieldId")
    previous_value: NonNullTestValue = Field(alias="previousValue")


class ScheduleEvent(StrictModel):
    kind: Literal["schedule"]
    frequency: Literal["daily", "weekly"]
    time: Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
    weekday: Annotated[int, Field(ge=1, le=7)] | None = None

    @model_validator(mode="after")
    def weekly_requires_weekday(self) -> ScheduleEvent:
        if self.frequency == "weekly" and self.weekday is None:
            raise ValueError("weekly schedules require weekday")
        return self


TestEvent = Annotated[
    AddedEvent | ChangedFieldEvent | ThresholdEvent | ScheduleEvent,
    Field(discriminator="kind"),
]


class SandboxTestRunCreateRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")
    module_id: ID = Field(alias="moduleId")
    values: dict[ID, TestValue] = Field(default_factory=dict, max_length=5_000)
    event: TestEvent
    trigger_ids: list[ID] | None = Field(default=None, max_length=500, alias="triggerIds")

    @model_validator(mode="after")
    def trigger_ids_are_unique(self) -> SandboxTestRunCreateRequest:
        if self.trigger_ids is not None and len(set(self.trigger_ids)) != len(
            self.trigger_ids
        ):
            raise ValueError("triggerIds must be unique")
        return self


class SandboxTestInputResponse(StrictModel):
    module_id: ID = Field(alias="moduleId")
    values: dict[ID, TestValue] = Field(max_length=5_000)


class SandboxTestIssueResponse(StrictModel):
    code: ID
    message: Annotated[str, Field(min_length=1, max_length=1_000)]
    target_id: ID | None = Field(default=None, alias="targetId")


class SandboxTestRouteResponse(StrictModel):
    label: Annotated[str, Field(min_length=1, max_length=1_000)]
    detail: Annotated[str, Field(min_length=1, max_length=1_000)] | None = None


class SandboxTestTriggerTraceResponse(StrictModel):
    trigger_id: ID = Field(alias="triggerId")
    label: Annotated[str, Field(min_length=1, max_length=1_000)]
    outcome: Annotated[str, Field(min_length=1, max_length=1_000)]


class SandboxTestResultResponse(StrictModel):
    values: dict[ID, TestValue] = Field(max_length=5_000)
    routes: list[SandboxTestRouteResponse] = Field(max_length=1_000)
    trigger_traces: list[SandboxTestTriggerTraceResponse] = Field(
        max_length=MAX_TRIGGER_TRACES, alias="triggerTraces"
    )
    issues: list[SandboxTestIssueResponse] = Field(max_length=5_000)


class SandboxTestRunResponse(StrictModel):
    id: UUID
    created_at: datetime = Field(alias="createdAt")
    document_revision: Annotated[int, Field(gt=0)] = Field(alias="documentRevision")
    input: SandboxTestInputResponse
    event: TestEvent
    trigger_ids: list[ID] | None = Field(alias="triggerIds")
    result: SandboxTestResultResponse


class SandboxTestRunListResponse(StrictModel):
    items: list[SandboxTestRunResponse]
    limit: Annotated[int, Field(ge=1, le=100)]
    offset: Annotated[int, Field(ge=0)]
    count: Annotated[int, Field(ge=0)]
    total: Annotated[int, Field(ge=0)]
    has_more: bool = Field(alias="hasMore")
