from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.common.listing import (
    StandardListRequest,
    StandardListResponse,
)


class RelationshipVisibility(StrEnum):
    AVAILABLE = "available"
    HIDDEN = "hidden"


class RelationshipAvailability(StrEnum):
    AVAILABLE = "available"
    HIDDEN = "hidden"
    ALL = "all"


class RelationshipHiddenReason(StrEnum):
    FIELD_ARCHIVED = "field_archived"
    SOURCE_RECORD_ARCHIVED = "source_record_archived"
    TARGET_RECORD_ARCHIVED = "target_record_archived"
    SOURCE_MODULE_ARCHIVED = "source_module_archived"
    TARGET_MODULE_ARCHIVED = "target_module_archived"


class RelationshipSortField(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class RelationshipCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field_id: UUID
    source_record_id: UUID
    target_record_id: UUID


class RelationshipAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_record_id: UUID | None


class RelationshipListRequest(StandardListRequest[RelationshipSortField]):
    model_config = ConfigDict(extra="forbid")

    field_id: UUID | None = None
    source_record_id: UUID | None = None
    target_record_id: UUID | None = None
    incident_record_id: UUID | None = None
    source_module_id: UUID | None = None
    target_module_id: UUID | None = None
    availability: RelationshipAvailability = RelationshipAvailability.AVAILABLE


class RelationshipResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: UUID
    field_id: UUID
    source_record_id: UUID
    target_record_id: UUID
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None
    visibility: RelationshipVisibility
    hidden_reasons: list[RelationshipHiddenReason] = Field(default_factory=list)


class RelationshipListResponse(StandardListResponse[RelationshipResponse]):
    pass


__all__ = [
    "RelationshipAssignment",
    "RelationshipAvailability",
    "RelationshipCreate",
    "RelationshipHiddenReason",
    "RelationshipListRequest",
    "RelationshipListResponse",
    "RelationshipResponse",
    "RelationshipSortField",
    "RelationshipVisibility",
]
