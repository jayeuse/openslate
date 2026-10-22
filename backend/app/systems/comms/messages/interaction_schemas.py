"""Thread, reaction and pin command shapes; ordinary lists keep offset pagination."""

from enum import StrEnum
from typing import Self

from pydantic import Field, StrictBool, model_validator

from app.common.listing import SortOrder
from app.systems.comms.messages.schemas import WireModel


class TimeSort(StrEnum):
    CREATED = "created_at"
    UPDATED = "updated_at"


class TimeList(WireModel):
    limit: int = Field(25, ge=1, le=100)
    offset: int = Field(0, ge=0)
    sort_order: SortOrder = SortOrder.ASC
    sort_by: TimeSort = TimeSort.CREATED


class ThreadList(TimeList):
    followed: bool | None = None
    resolved: bool | None = None
    archived: bool = False


class ThreadPatch(WireModel):
    name: str | None = Field(None, strict=True)
    resolved: StrictBool | None = None
    locked: StrictBool | None = None
    archived: StrictBool | None = None

    @model_validator(mode="after")
    def nonnull(self) -> Self:
        if any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Thread fields cannot be null")
        return self


class FollowRequest(WireModel):
    followed: StrictBool


class ReactionRequest(WireModel):
    emoji: str = Field(min_length=1, strict=True)


class PinRequest(WireModel):
    pinned: StrictBool
