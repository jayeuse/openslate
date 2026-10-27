"""Public Board activity projection; audit snapshots are deliberately excluded.

Only a Board manager gets the ``group`` of a group change: the group's name and its
level before and after, which Board settings > Access already shows that manager.
"""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.access.policy.models import AccessLevel
from app.systems.manage.audit.models import AuditAction


class BoardActivitySort(StrEnum):
    CREATED_AT = "created_at"


class BoardActivityKind(StrEnum):
    BOARD = "board"
    GROUP = "group"


class BoardActivityListRequest(StandardListRequest[BoardActivitySort]):
    sort_order: SortOrder = SortOrder.DESC


class BoardActivityGroup(BaseModel):
    """``name`` is null once the group is deleted; ``level`` is null for a removal and
    ``previous_level`` is null for an add."""

    name: str | None
    level: AccessLevel | None
    previous_level: AccessLevel | None


class BoardActivityResponse(BaseModel):
    id: UUID
    created_at: datetime
    kind: BoardActivityKind
    action: AuditAction
    summary: str
    actor_label: str | None
    group: BoardActivityGroup | None


class BoardActivityListResponse(StandardListResponse[BoardActivityResponse]):
    pass
