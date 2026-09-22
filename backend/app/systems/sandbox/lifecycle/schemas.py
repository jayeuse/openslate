from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class LifecycleTargetType(StrEnum):
    DEPARTMENT = "department"
    MODULE = "module"
    FIELD = "field"
    RECORD = "record"
    FILE = "file"


class LifecycleOperation(StrEnum):
    CLOSE = "close"
    REOPEN = "reopen"
    PURGE = "purge"


class LifecycleBlockerCode(StrEnum):
    CLOSED_ANCESTOR = "closed_ancestor"
    MODULE_NAME_CONFLICT = "module_name_conflict"
    FIELD_NAME_CONFLICT = "field_name_conflict"
    FIELD_POSITION_CONFLICT = "field_position_conflict"
    SCHEMA_INVALID = "schema_invalid"
    RECORD_DATA_INVALID = "record_data_invalid"
    RECORD_CLOSE_UNSUPPORTED = "record_close_unsupported"
    PURGE_EXTERNAL_SCHEMA_DEPENDENCY = "purge_external_schema_dependency"
    PURGE_FILE_DEPENDENCY = "purge_file_dependency"
    PURGE_AUTOMATION_DEPENDENCY = "purge_automation_dependency"


class LifecycleRowState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_type: str
    entity_id: UUID
    is_deleted: bool
    deleted_at: datetime | None
    updated_at: datetime
    state_fingerprint: str = ""
    byte_count: int | None = None


class LifecycleEdgeState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edge_id: UUID
    field_id: UUID
    source_record_id: UUID
    target_record_id: UUID
    is_deleted: bool
    deleted_at: datetime | None
    updated_at: datetime
    available: bool
    state_fingerprint: str = ""


class LifecycleExternalImpact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    edge_id: UUID
    field_id: UUID
    external_record_id: UUID
    external_module_id: UUID
    external_module_name: str
    external_department_id: UUID
    external_department_name: str

    @property
    def external_module_label(self) -> str:
        return self.external_module_name

    @property
    def external_department_label(self) -> str:
        return self.external_department_name


class LifecycleKeyStrip(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_id: UUID
    module_id: UUID
    field_id: UUID
    key: str


class LifecycleBlocker(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: LifecycleBlockerCode
    entity_type: str
    entity_id: UUID
    detail: str
    conflicting_entity_type: str | None = None
    conflicting_entity_id: UUID | None = None
    field_id: UUID | None = None
    field_name: str | None = None
    module_id: UUID | None = None
    module_name: str | None = None
    department_id: UUID | None = None
    department_name: str | None = None


class LifecycleImpactResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target_type: LifecycleTargetType
    target_id: UUID
    operation: LifecycleOperation
    actor_id: UUID | None
    rows: list[LifecycleRowState] = Field(default_factory=list)
    external_impacts: list[LifecycleExternalImpact] = Field(default_factory=list)
    key_strips: list[LifecycleKeyStrip] = Field(default_factory=list)
    blockers: list[LifecycleBlocker] = Field(default_factory=list)
    impact_digest: str


class LifecycleClosePreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    impact: LifecycleImpactResponse
    token: str
    expires_at: datetime
    confirmation_name: str


class LifecyclePurgePreviewResponse(LifecycleClosePreviewResponse):
    pass


class LifecycleCloseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=128)
    confirmation_name: str = Field(min_length=1, max_length=150)
    password: str = Field(min_length=1, max_length=256)


class LifecyclePurgeRequest(LifecycleCloseRequest):
    pass


class LifecycleReopenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmed: bool


class LifecycleMutationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    impact: LifecycleImpactResponse
    operation_id: UUID | None


__all__ = [
    "LifecycleBlocker",
    "LifecycleBlockerCode",
    "LifecycleEdgeState",
    "LifecycleExternalImpact",
    "LifecycleKeyStrip",
    "LifecycleImpactResponse",
    "LifecycleClosePreviewResponse",
    "LifecyclePurgePreviewResponse",
    "LifecycleCloseRequest",
    "LifecyclePurgeRequest",
    "LifecycleMutationResponse",
    "LifecycleReopenRequest",
    "LifecycleOperation",
    "LifecycleRowState",
    "LifecycleTargetType",
    "LifecycleTarget",
]

LifecycleTarget = LifecycleTargetType
