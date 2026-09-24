"""Typed contracts for Board record shortcuts."""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.common.listing import StandardListRequest, StandardListResponse


class BoardPlacementSort(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class BoardPlacementListRequest(StandardListRequest[BoardPlacementSort]):
    pass


class BoardPlacementCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    record_id: UUID


class BoardPlacementResponse(BaseModel):
    id: UUID
    board_id: UUID
    record_id: UUID
    module_id: UUID | None
    available: bool
    created_at: datetime
    updated_at: datetime


class BoardPlacementListResponse(StandardListResponse[BoardPlacementResponse]):
    board_revision: int


class BoardPlacementMutationResponse(BaseModel):
    placement: BoardPlacementResponse
    board_revision: int
