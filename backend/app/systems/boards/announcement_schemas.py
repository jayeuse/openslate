"""Typed Board announcement publication and lifecycle contracts."""

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.boards.content_links import ContentLink


class AnnouncementAudience(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["everyone", "author", "role", "user", "department"] = "everyone"
    role_id: UUID | None = None
    user_id: UUID | None = None
    department_id: UUID | None = None

    @model_validator(mode="after")
    def one_target(self) -> Self:
        targets = (self.role_id, self.user_id, self.department_id)
        expected = {"role": 0, "user": 1, "department": 2}.get(self.kind)
        if expected is None:
            valid = all(value is None for value in targets)
        else:
            valid = all(
                (value is not None) == (index == expected) for index, value in enumerate(targets)
            )
        if not valid:
            raise ValueError("Audience target must match its kind")
        return self


class AnnouncementContent(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=2000)
    links: list[ContentLink] = Field(default_factory=list, max_length=20)
    audience: AnnouncementAudience = Field(default_factory=AnnouncementAudience)
    expires_at: datetime | None = None
    pinned: StrictBool = False

    @model_validator(mode="after")
    def utc_expiry(self) -> Self:
        if self.expires_at is not None:
            if self.expires_at.tzinfo is None or self.expires_at.utcoffset() is None:
                raise ValueError("Expiration must be a UTC instant")
            if self.expires_at.utcoffset() != timedelta(0):
                raise ValueError("Expiration must be a UTC instant")
            self.expires_at = self.expires_at.astimezone(UTC)
        return self


class AnnouncementCreate(AnnouncementContent):
    board_revision: int = Field(ge=1)


class AnnouncementPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    board_revision: int = Field(ge=1)
    announcement_revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=100)
    body: str | None = Field(default=None, min_length=1, max_length=2000)
    links: list[ContentLink] | None = Field(default=None, max_length=20)
    audience: AnnouncementAudience | None = None
    expires_at: datetime | None = None
    pinned: StrictBool | None = None

    @model_validator(mode="after")
    def changed(self) -> Self:
        if not self.model_fields_set - {"board_revision", "announcement_revision"}:
            raise ValueError("At least one announcement field is required")
        return self


class AnnouncementRevisionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_revision: int = Field(ge=1)
    announcement_revision: int = Field(ge=1)


class AnnouncementSchedule(AnnouncementRevisionWrite):
    publish_at: datetime

    @model_validator(mode="after")
    def utc_publish_time(self) -> Self:
        if self.publish_at.tzinfo is None or self.publish_at.utcoffset() is None:
            raise ValueError("Publication time must be a UTC instant")
        if self.publish_at.utcoffset() != timedelta(0):
            raise ValueError("Publication time must be a UTC instant")
        self.publish_at = self.publish_at.astimezone(UTC)
        return self


class AnnouncementPublish(AnnouncementRevisionWrite):
    publication_key: UUID


class AnnouncementView(StrEnum):
    PUBLISHED = "published"
    DRAFT = "draft"
    EDITABLE = "editable"
    ARCHIVE = "archive"


class AnnouncementSort(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"
    TITLE = "title"


class AnnouncementListRequest(StandardListRequest[AnnouncementSort]):
    view: AnnouncementView = AnnouncementView.PUBLISHED
    sort_order: SortOrder = SortOrder.DESC
    author_id: UUID | None = None


class AnnouncementResponse(BaseModel):
    id: UUID
    board_id: UUID
    author_id: UUID
    title: str
    body: str
    links: list[ContentLink]
    audience: AnnouncementAudience
    status: str
    publish_at: datetime | None
    expires_at: datetime | None
    pinned: bool
    announcement_revision: int | None
    board_revision: int
    publication_number: int | None
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AnnouncementListResponse(StandardListResponse[AnnouncementResponse]):
    board_revision: int


class AnnouncementMutationResponse(BaseModel):
    id: UUID
    announcement_revision: int
    board_revision: int


class AnnouncementPublicationResponse(BaseModel):
    id: UUID
    announcement_id: UUID
    publication_number: int
    publication_key: UUID
    published_at: datetime
