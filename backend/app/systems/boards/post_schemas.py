"""Typed Board post publication and lifecycle contracts."""

from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.boards.content_links import ContentLink


class PostContent(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=2000)
    links: list[ContentLink] = Field(default_factory=list, max_length=20)
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


class PostCreate(PostContent):
    board_revision: int = Field(ge=1)


class PostPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    board_revision: int = Field(ge=1)
    post_revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=100)
    body: str | None = Field(default=None, min_length=1, max_length=2000)
    links: list[ContentLink] | None = Field(default=None, max_length=20)
    expires_at: datetime | None = None
    pinned: StrictBool | None = None

    @model_validator(mode="after")
    def changed(self) -> Self:
        if not self.model_fields_set - {"board_revision", "post_revision"}:
            raise ValueError("At least one post field is required")
        return self


class PostRevisionWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    board_revision: int = Field(ge=1)
    post_revision: int = Field(ge=1)


class PostSchedule(PostRevisionWrite):
    publish_at: datetime

    @model_validator(mode="after")
    def utc_publish_time(self) -> Self:
        if self.publish_at.tzinfo is None or self.publish_at.utcoffset() is None:
            raise ValueError("Publication time must be a UTC instant")
        if self.publish_at.utcoffset() != timedelta(0):
            raise ValueError("Publication time must be a UTC instant")
        self.publish_at = self.publish_at.astimezone(UTC)
        return self


class PostPublish(PostRevisionWrite):
    publication_key: UUID


class PostView(StrEnum):
    PUBLISHED = "published"
    DRAFT = "draft"
    EDITABLE = "editable"
    ARCHIVE = "archive"


class PostSort(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"
    TITLE = "title"


class PostListRequest(StandardListRequest[PostSort]):
    view: PostView = PostView.PUBLISHED
    sort_order: SortOrder = SortOrder.DESC
    author_id: UUID | None = None


class PostResponse(BaseModel):
    id: UUID
    board_id: UUID
    author_id: UUID
    title: str
    body: str
    links: list[ContentLink]
    status: str
    publish_at: datetime | None
    expires_at: datetime | None
    pinned: bool
    post_revision: int | None
    board_revision: int
    publication_number: int | None
    published_at: datetime | None
    edited: bool
    created_at: datetime
    updated_at: datetime


class PostListResponse(StandardListResponse[PostResponse]):
    board_revision: int


class PostMutationResponse(BaseModel):
    id: UUID
    post_revision: int
    board_revision: int


class PostDeleteResponse(BaseModel):
    """``deleted`` for a post that was never published; ``archived`` keeps its history."""

    id: UUID
    outcome: Literal["deleted", "archived"]
    post_revision: int | None
    board_revision: int


class PostPublicationResponse(BaseModel):
    id: UUID
    post_id: UUID
    publication_number: int
    publication_key: UUID
    published_at: datetime


class PostRevisionSummary(BaseModel):
    """One published version of a post, as listed in its edit history."""

    id: UUID
    post_id: UUID
    publication_number: int
    author_id: UUID
    title: str
    published_at: datetime


class PostRevisionListResponse(BaseModel):
    post_id: UUID
    items: list[PostRevisionSummary]


class PostRevisionResponse(PostRevisionSummary):
    body: str
    links: list[ContentLink]
    expires_at: datetime | None
