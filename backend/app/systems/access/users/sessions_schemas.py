"""Public schemas for administrator-managed identity sessions."""

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse


class AdminSessionSortField(StrEnum):
    REFRESHED_AT = "refreshed_at"


class AdminSessionListRequest(StandardListRequest[AdminSessionSortField]):
    """Offset pagination with an intentionally fixed newest-session-first order."""

    sort_by: Literal[AdminSessionSortField.REFRESHED_AT] = AdminSessionSortField.REFRESHED_AT
    sort_order: Literal[SortOrder.DESC] = SortOrder.DESC


class AdminSessionResponse(BaseModel):
    id: UUID
    created_at: datetime
    refreshed_at: datetime
    expires_at: datetime
    user_agent: str | None
    current: bool

    model_config = ConfigDict(extra="forbid")


class AdminSessionListResponse(StandardListResponse[AdminSessionResponse]):
    pass
