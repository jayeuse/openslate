"""Bounded, typed global search contract."""

from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.common.listing import DeletedFilter, SortOrder, StandardListRequest, StandardListResponse


class SearchKind(StrEnum):
    RECORD = "record"
    PERSON = "person"
    POST = "post"
    EVENT = "event"


class SearchSort(StrEnum):
    RELEVANCE = "relevance"


class SearchRequest(StandardListRequest[SearchSort]):
    kind: SearchKind
    sort_order: SortOrder = SortOrder.DESC
    deleted: Literal[DeletedFilter.EXCLUDE] = DeletedFilter.EXCLUDE


class SearchItem(BaseModel):
    kind: SearchKind
    id: UUID
    title: str
    context_label: str
    module_id: UUID | None
    board_id: UUID | None
    can_open: bool


class SearchResponse(StandardListResponse[SearchItem]):
    pass
