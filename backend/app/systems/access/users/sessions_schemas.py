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
    ip_address: str | None
    current: bool

    model_config = ConfigDict(extra="forbid")


class AdminSessionListResponse(StandardListResponse[AdminSessionResponse]):
    pass


class AdminSessionCollectionSortField(StrEnum):
    REFRESHED_AT = "refreshed_at"
    PERSON_NAME = "person_name"


class AdminSessionCollectionRequest(StandardListRequest[AdminSessionCollectionSortField]):
    sort_by: AdminSessionCollectionSortField = AdminSessionCollectionSortField.REFRESHED_AT
    sort_order: SortOrder = SortOrder.DESC
    status: Literal["all", "current", "remote"] = "all"
    device: Literal["all", "Desktop", "Mobile", "Tablet", "Unknown"] = "all"


class AdminSessionCollectionItem(AdminSessionResponse):
    user_id: UUID
    person_name: str
    device: Literal["Desktop", "Mobile", "Tablet", "Unknown"]
    browser: str


class AdminSessionCollectionResponse(StandardListResponse[AdminSessionCollectionItem]):
    pass


class SignInEventSortField(StrEnum):
    OCCURRED_AT = "occurred_at"


class SignInEventListRequest(StandardListRequest[SignInEventSortField]):
    """Offset pagination, newest first; there is no search and no deleted filter."""

    sort_by: Literal[SignInEventSortField.OCCURRED_AT] = SignInEventSortField.OCCURRED_AT
    sort_order: Literal[SortOrder.DESC] = SortOrder.DESC


SignInEventKind = Literal["signed_in", "session_ended", "sign_in_failed", "locked_out"]


class SignInEventResponse(BaseModel):
    """One event of the caller's own sign-in history; ``kind:id`` is unique."""

    id: UUID
    kind: SignInEventKind
    occurred_at: datetime
    user_agent: str | None
    ip_address: str | None

    model_config = ConfigDict(extra="forbid")


class SignInEventListResponse(StandardListResponse[SignInEventResponse]):
    pass
