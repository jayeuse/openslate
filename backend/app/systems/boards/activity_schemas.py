"""Public Board activity projection; audit snapshots are deliberately excluded."""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.manage.audit.models import AuditAction


class BoardActivitySort(StrEnum):
    CREATED_AT = "created_at"


class BoardActivityKind(StrEnum):
    BOARD = "board"
    GROUP = "group"


class BoardActivityListRequest(StandardListRequest[BoardActivitySort]):
    sort_order: SortOrder = SortOrder.DESC


class BoardActivityResponse(BaseModel):
    id: UUID
    created_at: datetime
    kind: BoardActivityKind
    action: AuditAction
    summary: str
    actor_label: str | None


class BoardActivityListResponse(StandardListResponse[BoardActivityResponse]):
    pass
