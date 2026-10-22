"""Message-family wire shapes. Files and record-link admission remain with S18."""

from datetime import datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.systems.comms.access import error

Watermark = Annotated[int, Field(ge=0, le=9007199254740991)]
Sequence = Annotated[int, Field(ge=1, le=9007199254740991)]


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class MessageContent(WireModel):
    body: str = Field(strict=True, max_length=4000)

    @field_validator("body", mode="before")
    @classmethod
    def valid_text(cls, value: object) -> object:
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeError as exc:
                raise error("comms_invalid_input", "Invalid message text", 422) from exc
            if "\x00" in value:
                raise error("comms_invalid_input", "Invalid message text", 422)
        return value

    @field_validator("mention_user_ids", check_fields=False)
    @classmethod
    def distinct_mentions(cls, values: list[UUID]) -> list[UUID]:
        if len(values) != len(set(values)):
            raise ValueError("Mention IDs must be distinct")
        return values


class SendRequest(MessageContent):
    client_key: UUID
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=10)
    record_ids: list[UUID] = Field(default_factory=list)
    mention_user_ids: list[UUID] = Field(default_factory=list)
    mentions_channel: bool = Field(False, strict=True)
    mentions_here: bool = Field(False, strict=True)
    reply_to_id: UUID | None = None

    @field_validator("attachment_ids", "record_ids")
    @classmethod
    def distinct_links(cls, values: list[UUID]) -> list[UUID]:
        if len(set(values)) != len(values):
            raise ValueError("References must be distinct")
        return values

    @model_validator(mode="after")
    def nonempty(self) -> Self:
        if not self.body.strip() and not self.attachment_ids and not self.record_ids:
            raise error("comms_message_empty", "Message is empty", 422)
        return self


class ReplyRequest(SendRequest):
    also_send_to_channel: bool = Field(False, strict=True)


class EditRequest(MessageContent):
    mention_user_ids: list[UUID]
    mentions_channel: bool = Field(strict=True)
    mentions_here: bool = Field(strict=True)


class ReadRequest(WireModel):
    last_read_seq: Watermark = Field(strict=True)


class ReadResponse(WireModel):
    conversation_id: UUID
    last_read_seq: Watermark


class HistoryRequest(WireModel):
    limit: int = Field(50, ge=1, le=100)
    before_seq: Sequence | None = None
    after_seq: Watermark | None = None
    around_seq: Sequence | None = None

    @model_validator(mode="after")
    def one_direction(self) -> Self:
        if (
            sum(
                value is not None
                for value in (
                    self.before_seq,
                    self.after_seq,
                    self.around_seq,
                )
            )
            > 1
        ):
            raise ValueError("Choose one history direction")
        return self


class ThreadResponse(WireModel):
    id: UUID
    org_id: UUID
    conversation_id: UUID
    root_message_id: UUID
    name: str
    resolved: bool
    locked: bool
    archived: bool
    followed: bool
    reply_count: Watermark
    last_reply_at: datetime | None


class MessageIdentity(WireModel):
    id: UUID
    org_id: UUID
    conversation_id: UUID
    seq: Sequence
    author_id: UUID
    client_key: UUID
    created_at: datetime
    parent_id: UUID | None
    reply_to_id: UUID | None
    also_send_to_channel: bool
    thread: ThreadResponse | None


class Attachment(WireModel):
    id: UUID
    filename: str
    media_type: str
    size: int


class RecordField(WireModel):
    field_id: UUID
    label: str
    display_value: str


class UnavailableRecord(WireModel):
    id: UUID
    state: Literal["unavailable"]


class AvailableRecord(WireModel):
    id: UUID
    state: Literal["available"]
    record_id: UUID
    module_id: UUID
    module_name: str
    title: str
    fields: list[RecordField]


class Reaction(WireModel):
    emoji: str
    user_ids: list[UUID]


class LinkPreview(WireModel):
    url: str
    title: str
    description: str
    site_name: str


class LiveMessage(MessageIdentity):
    state: Literal["live"]
    body: str
    edited_at: datetime | None
    pinned_at: datetime | None
    pinned_by: UUID | None
    attachments: list[Attachment]
    record_references: list[UnavailableRecord | AvailableRecord]
    mention_user_ids: list[UUID]
    mentions_channel: bool
    mentions_here: bool
    reactions: list[Reaction]
    link_previews: list[LinkPreview]


class Tombstone(MessageIdentity):
    state: Literal["deleted"]
    deleted_at: datetime


MessageResponse = Annotated[LiveMessage | Tombstone, Field(discriminator="state")]


class HistoryPagination(WireModel):
    limit: int
    count: int
    first_seq: Sequence | None
    last_seq: Sequence | None
    high_water_seq: Watermark
    has_older: bool
    has_newer: bool


class HistoryResponse(WireModel):
    org_id: UUID
    conversation_id: UUID
    thread_root_id: UUID | None = None
    items: list[MessageResponse]
    pagination: HistoryPagination


class MuteOff(WireModel):
    kind: Literal["off", "indefinite"] = "off"


class MuteUntil(WireModel):
    kind: Literal["until"]
    until: datetime


class MemberPreferences(WireModel):
    notify: Literal["all", "mentions", "mute"] = "all"
    mute: MuteOff | MuteUntil = Field(default_factory=MuteOff)
    starred: bool = False
    hidden: bool = False
    manual_unread: bool = False


class CategoryPreferences(WireModel):
    collapsed: bool = False
    mute: MuteOff | MuteUntil = Field(default_factory=MuteOff)


class ResourceIdentity(WireModel):
    id: UUID
    org_id: UUID
    created_at: datetime
    updated_at: datetime


class Category(ResourceIdentity):
    name: str
    position: int
    department_id: UUID | None


class ConversationIdentity(ResourceIdentity):
    archived_at: datetime | None
    level: Literal["read", "post", "manage"]
    member_count: int
    member_role: Literal["member", "manager"] | None


class ChannelIdentity(ConversationIdentity):
    kind: Literal["channel"]
    name: str
    topic: str
    category_id: UUID | None
    position: int


class OrganizationChannel(ChannelIdentity):
    scope: Literal["organization"]


class DepartmentChannel(ChannelIdentity):
    scope: Literal["department"]
    department_id: UUID


class DirectConversation(ConversationIdentity):
    kind: Literal["direct"]
    participant_ids: list[UUID]


class GroupConversation(ConversationIdentity):
    kind: Literal["group"]
    name: str
    participant_ids: list[UUID]


Conversation = (
    OrganizationChannel
    | DepartmentChannel
    | DirectConversation
    | GroupConversation
)


class ConversationSummary(WireModel):
    conversation: Conversation
    preferences: MemberPreferences
    last_read_seq: Watermark
    high_water_seq: Watermark
    unread_count: int
    mention_count: int
    first_unread_seq: Sequence | None


class CategorySummary(WireModel):
    category: Category
    preferences: CategoryPreferences


class BootstrapResponse(WireModel):
    org_id: UUID
    user_id: UUID
    categories: list[CategorySummary]
    conversations: list[ConversationSummary]
