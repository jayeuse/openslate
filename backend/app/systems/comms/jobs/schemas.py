"""Live S23 DTOs. Password proof is write-only and never a persisted job field."""

from datetime import UTC, date, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, Field, StrictBool, field_validator, model_validator

from app.systems.comms.messages.schemas import SendRequest, Watermark, WireModel


class CommsScheduleRequest(SendRequest):
    conversation_id: UUID
    send_at: AwareDatetime
    parent_id: UUID | None = None
    also_send_to_channel: StrictBool = False

    @model_validator(mode="after")
    def root_shape(self) -> Self:
        if self.parent_id is None and self.also_send_to_channel:
            raise ValueError("Only a thread reply can also be sent to the channel")
        self.send_at = self.send_at.astimezone(UTC)
        return self


class CommsScheduleResponse(WireModel):
    id: UUID
    org_id: UUID
    author_id: UUID
    request: CommsScheduleRequest
    status: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    message_id: UUID | None
    failure_code: Literal["access_lost", "post_denied", "invalid_content", "unavailable"] | None
    created_at: datetime
    updated_at: datetime


class WorkspaceScope(WireModel):
    kind: Literal["workspace"]


class ChannelScope(WireModel):
    kind: Literal["channel"]
    id: UUID


class RetentionQuery(WireModel):
    scope_kind: Literal["workspace", "channel"]
    channel_id: UUID | None = None

    @model_validator(mode="after")
    def exact_scope(self) -> Self:
        if (self.scope_kind == "channel") != (self.channel_id is not None):
            raise ValueError("Only channel scope requires channel_id")
        return self


class RetentionPolicy(WireModel):
    scope: Annotated[WorkspaceScope | ChannelScope, Field(discriminator="kind")]
    message_days: Watermark | None
    file_days: Watermark | None

    @model_validator(mode="after")
    def nonnull_workspace(self) -> Self:
        if self.scope.kind == "workspace" and (self.message_days is None or self.file_days is None):
            raise ValueError("Workspace periods cannot inherit")
        return self


class RetentionPreviewRequest(RetentionPolicy):
    password: str = Field(min_length=1, max_length=256)


class RetentionUpdate(RetentionPreviewRequest):
    preview_digest: str = Field(pattern=r"^[a-f0-9]{64}$")


class EffectiveRetention(WireModel):
    message_days: Watermark
    file_days: Watermark


class RetentionSources(WireModel):
    message_days: Literal["workspace", "channel"]
    file_days: Literal["workspace", "channel"]


class RetentionResponse(WireModel):
    policy: RetentionPolicy
    effective: EffectiveRetention
    sources: RetentionSources


class RetentionPreview(RetentionResponse):
    message_count: Watermark
    file_count: Watermark
    preview_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    expires_at: datetime


class CommsExportRequest(WireModel):
    conversation_ids: list[UUID] = Field(min_length=1, max_length=100)
    format: Literal["csv", "xlsx"]
    after: date | None = None
    before: date | None = None
    reason: str | None = Field(None, min_length=1, max_length=2000)

    @field_validator("conversation_ids")
    @classmethod
    def distinct(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Conversation IDs must be distinct")
        return value

    @field_validator("reason", mode="before")
    @classmethod
    def reason_text(cls, value: object) -> object:
        if isinstance(value, str):
            if "\x00" in value:
                raise ValueError("Reason cannot contain NUL")
            value.encode("utf-8")
            return value.strip()
        return value

    @model_validator(mode="after")
    def ordered_dates(self) -> Self:
        if self.after is not None and self.before is not None and self.after >= self.before:
            raise ValueError("after must precede before")
        return self


class CommsExportCreate(CommsExportRequest):
    password: str | None = Field(None, min_length=1, max_length=256)


class CommsExportResponse(WireModel):
    id: UUID
    org_id: UUID
    requested_by: UUID
    request: CommsExportRequest
    status: Literal["pending", "running", "succeeded", "failed", "cancelled"]
    failure_code: Literal["access_lost", "unavailable"] | None
    created_at: datetime
    updated_at: datetime
