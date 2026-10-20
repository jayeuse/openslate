"""S20 HTTP-only B8 heartbeat shapes; the frozen Phase-A client remains separate."""

from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.systems.comms.messages.schemas import Watermark, WireModel


class ConversationHead(WireModel):
    conversation_id: UUID
    high_water_seq: Watermark = Field(strict=True)


class HeartbeatRequest(WireModel):
    state: Literal["online", "away"]
    known_sequences: list[ConversationHead] = Field(default_factory=list, max_length=100)

    @field_validator("known_sequences")
    @classmethod
    def distinct(cls, values: list[ConversationHead]) -> list[ConversationHead]:
        if len({row.conversation_id for row in values}) != len(values):
            raise ValueError("Conversation IDs must be distinct")
        return values


class HeartbeatResponse(WireModel):
    org_id: UUID
    user_id: UUID
    changed: list[ConversationHead] = Field(max_length=100)
    truncated: bool


class PresenceQuery(WireModel):
    user_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("user_ids")
    @classmethod
    def distinct(cls, values: list[UUID]) -> list[UUID]:
        if len(set(values)) != len(values):
            raise ValueError("User IDs must be distinct")
        return values


class PresenceState(WireModel):
    user_id: UUID
    state: Literal["online", "away", "offline"]


class PresenceSnapshot(WireModel):
    org_id: UUID
    items: list[PresenceState] = Field(max_length=100)
