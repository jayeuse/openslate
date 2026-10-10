"""Strict portable-document and HTTP schemas for the Sandbox design workspace."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Final, Literal
from uuid import UUID

from pydantic import Field, model_validator
from pydantic_core import PydanticCustomError

from app.systems.sandbox.designs.field_schemas import (
    ID as ID,
)
from app.systems.sandbox.designs.field_schemas import (
    CheckboxFieldConfig as CheckboxFieldConfig,
)
from app.systems.sandbox.designs.field_schemas import (
    DateFieldConfig as DateFieldConfig,
)
from app.systems.sandbox.designs.field_schemas import (
    DesignField as DesignField,
)
from app.systems.sandbox.designs.field_schemas import (
    FieldConfig as FieldConfig,
)
from app.systems.sandbox.designs.field_schemas import (
    FiniteNumber,
    Name,
    Text,
    TypedValue,
    VersionLabel,
)
from app.systems.sandbox.designs.field_schemas import (
    NumberFieldConfig as NumberFieldConfig,
)
from app.systems.sandbox.designs.field_schemas import (
    SelectFieldConfig as SelectFieldConfig,
)
from app.systems.sandbox.designs.field_schemas import (
    SelectOption as SelectOption,
)
from app.systems.sandbox.designs.field_schemas import (
    StrictModel as StrictModel,
)
from app.systems.sandbox.designs.field_schemas import (
    TextFieldConfig as TextFieldConfig,
)
from app.systems.sandbox.designs.field_schemas import (
    UserFieldConfig as UserFieldConfig,
)

DOCUMENT_SCHEMA_VERSION: Final = 4
OLDER_FORMAT_MESSAGE: Final = "This design uses an older format and cannot be opened."


class SandboxBindingResponse(StrictModel):
    kind: Literal["department", "module", "field", "relationship", "trigger"]
    sandbox_id: ID
    parent_sandbox_id: ID | None
    live_id: UUID
    is_deleted: bool


class SandboxBindingsResponse(StrictModel):
    document_revision: int = Field(ge=1)
    items: list[SandboxBindingResponse]


class DepartmentDocument(StrictModel):
    id: ID
    name: Name
    closed: bool = False


class ModuleDocument(StrictModel):
    id: ID
    department_id: ID = Field(alias="departmentId")
    name: Name
    closed: bool = False
    title_field_id: ID | None = Field(default=None, alias="titleFieldId")
    fields: list[DesignField] = Field(default_factory=list, max_length=5_000)


class FieldMapping(StrictModel):
    source_field_id: ID = Field(alias="sourceFieldId")
    target_field_id: ID = Field(alias="targetFieldId")


class RelationshipDocument(StrictModel):
    id: ID
    name: Name
    source_module_id: ID = Field(alias="sourceModuleId")
    target_module_id: ID = Field(alias="targetModuleId")
    cardinality: Literal["one-to-one", "one-to-many", "many-to-many"]
    field_mappings: list[FieldMapping] = Field(
        default_factory=list, max_length=1_000, alias="fieldMappings"
    )


class LayoutBox(StrictModel):
    x: FiniteNumber
    y: FiniteNumber
    width: Annotated[float, Field(gt=0, le=100_000)]
    height: Annotated[float, Field(gt=0, le=100_000)]


class FieldReference(StrictModel):
    module_id: ID = Field(alias="moduleId")
    field_id: ID = Field(alias="fieldId")
    relationship_id: ID | None = Field(default=None, alias="relationshipId")


class LiteralValue(StrictModel):
    kind: Literal["literal"]
    value: TypedValue


class FieldReferenceValue(FieldReference):
    kind: Literal["field-reference"]


TriggerValue = Annotated[LiteralValue | FieldReferenceValue, Field(discriminator="kind")]


class RecordCreatedTrigger(StrictModel):
    kind: Literal["record-created"]
    module_id: ID = Field(alias="moduleId")


class FieldChangedTrigger(StrictModel):
    kind: Literal["field-changed"]
    module_id: ID = Field(alias="moduleId")
    field_id: ID = Field(alias="fieldId")


class ThresholdCrossedTrigger(StrictModel):
    kind: Literal["threshold-crossed"]
    module_id: ID = Field(alias="moduleId")
    field_id: ID = Field(alias="fieldId")
    operator: Literal[">", ">=", "<", "<=", "=", "!="]
    value: TriggerValue


class ScheduleTrigger(StrictModel):
    kind: Literal["schedule"]
    module_id: ID = Field(alias="moduleId")
    frequency: Literal["daily", "weekly"]
    time: Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
    weekday: Annotated[int, Field(ge=1, le=7)] | None = None

    @model_validator(mode="after")
    def _weekly_requires_weekday(self) -> ScheduleTrigger:
        if self.frequency == "weekly" and self.weekday is None:
            raise ValueError("weekly schedules require weekday")
        return self


TriggerEvent = Annotated[
    RecordCreatedTrigger | FieldChangedTrigger | ThresholdCrossedTrigger | ScheduleTrigger,
    Field(discriminator="kind"),
]


class TriggerCondition(StrictModel):
    id: ID
    field: FieldReference
    operator: Literal[">", ">=", "<", "<=", "=", "!="]
    value: TriggerValue


class ConditionGroup(StrictModel):
    operator: Literal["all", "any"]
    conditions: list[TriggerCondition] = Field(max_length=20)


class NotificationAction(StrictModel):
    id: ID
    kind: Literal["notification"]
    message: Text


class ChannelMessageAction(StrictModel):
    id: ID
    kind: Literal["channel-message"]
    channel: Text


class AssignTaskAction(StrictModel):
    id: ID
    kind: Literal["assign-task"]
    assignee: Text


class SetFieldAction(StrictModel):
    id: ID
    kind: Literal["set-field"]
    target: FieldReference
    value: TriggerValue


class CreateRecordValue(StrictModel):
    field_id: ID = Field(alias="fieldId")
    value: TriggerValue


class CreateRecordAction(StrictModel):
    id: ID
    kind: Literal["create-record"]
    module_id: ID = Field(alias="moduleId")
    values: list[CreateRecordValue] = Field(max_length=5_000)


TriggerAction = Annotated[
    NotificationAction
    | ChannelMessageAction
    | AssignTaskAction
    | SetFieldAction
    | CreateRecordAction,
    Field(discriminator="kind"),
]


class TriggerDocument(StrictModel):
    id: ID
    name: Name
    enabled: bool = True
    priority: int = Field(default=0, ge=-10_000, le=10_000)
    trigger: TriggerEvent
    condition_group: ConditionGroup = Field(alias="conditionGroup")
    actions: list[TriggerAction] = Field(min_length=1, max_length=20)


class ScenarioRecord(StrictModel):
    id: ID
    module_id: ID = Field(alias="moduleId")
    values: dict[ID, TypedValue] = Field(default_factory=dict, max_length=5_000)


class ScenarioLink(StrictModel):
    relationship_id: ID = Field(alias="relationshipId")
    source_record_id: ID = Field(alias="sourceRecordId")
    target_record_id: ID = Field(alias="targetRecordId")


class ScenarioDocument(StrictModel):
    id: ID
    name: Name
    records: list[ScenarioRecord] = Field(default_factory=list, max_length=5_000)
    links: list[ScenarioLink] = Field(default_factory=list, max_length=5_000)


class DesignDocument(StrictModel):
    departments: list[DepartmentDocument] = Field(default_factory=list, max_length=100)
    modules: list[ModuleDocument] = Field(default_factory=list, max_length=500)
    relationships: list[RelationshipDocument] = Field(default_factory=list, max_length=1_000)
    layout: dict[ID, LayoutBox] = Field(default_factory=dict, max_length=600)

    @model_validator(mode="after")
    def _total_field_limit(self) -> DesignDocument:
        if sum(len(module.fields) for module in self.modules) > 5_000:
            raise ValueError("design may contain at most 5000 fields")
        return self


class SandboxSnapshot(StrictModel):
    design: DesignDocument
    triggers: list[TriggerDocument] = Field(default_factory=list, max_length=500)
    scenarios: list[ScenarioDocument] = Field(default_factory=list, max_length=500)


class SandboxDocument(SandboxSnapshot):
    kind: Literal["openslate-sandbox"]
    schema_version: Literal[4] = Field(alias="schemaVersion")

    @model_validator(mode="before")
    @classmethod
    def _refuse_older_format(cls, data: Any) -> Any:
        if isinstance(data, dict):
            version = data.get("schemaVersion", data.get("schema_version"))
            if (
                isinstance(version, int)
                and not isinstance(version, bool)
                and version < DOCUMENT_SCHEMA_VERSION
            ):
                raise PydanticCustomError("sandbox_document_older_format", OLDER_FORMAT_MESSAGE)
        return data


class PortableVersion(StrictModel):
    id: ID
    label: VersionLabel
    kind: Literal["checkpoint", "published", "imported"]
    document: SandboxSnapshot
    published: bool
    date: Annotated[str, Field(min_length=1, max_length=64)]
    note: Text | None = None


class PortableBundle(SandboxDocument):
    versions: list[PortableVersion] | None = None


class DocumentReplaceRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")
    document: SandboxDocument


class VersionCreateRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")
    kind: Literal["checkpoint"] = "checkpoint"
    label: VersionLabel
    note: Text | None = None


class VersionMetadataUpdateRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")
    label: VersionLabel | None = None
    note: Text | None = None

    @model_validator(mode="after")
    def _has_update(self) -> VersionMetadataUpdateRequest:
        if not ({"label", "note"} & self.model_fields_set):
            raise ValueError("label or note is required")
        return self


class VersionMutationRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")


class ImportRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")
    bundle: PortableBundle


class ValidationIssue(StrictModel):
    code: str
    message: str
    target_id: str | None = Field(default=None, alias="targetId")


class DocumentResponse(StrictModel):
    document: SandboxDocument
    revision: int
    content_hash: str = Field(alias="contentHash")
    byte_count: int = Field(alias="byteCount")
    issues: list[ValidationIssue]
    latest_published_version: PublishedDocumentVersion | None = Field(
        default=None, alias="latestPublishedVersion"
    )
    published_hash: str | None = Field(default=None, alias="publishedHash")
    has_unpublished_changes: bool = Field(default=True, alias="hasUnpublishedChanges")


class PublishedDocumentVersion(StrictModel):
    id: UUID
    sequence: int
    label: VersionLabel
    created_at: datetime = Field(alias="createdAt")


class VersionResponse(StrictModel):
    id: UUID
    sequence: int
    kind: str
    label: VersionLabel
    note: str | None
    source_document_revision: int = Field(alias="sourceDocumentRevision")
    source_version_id: UUID | None = Field(alias="sourceVersionId")
    content_hash: str = Field(alias="contentHash")
    byte_count: int = Field(alias="byteCount")
    metadata_revision: int = Field(alias="metadataRevision")
    created_at: datetime = Field(alias="createdAt")
    performed_by: UUID | None = Field(alias="performedBy")
    is_deleted: bool = Field(alias="isDeleted")
    deleted_at: datetime | None = Field(alias="deletedAt")


class VersionDetailResponse(VersionResponse):
    document: SandboxDocument


class VersionListResponse(StrictModel):
    items: list[VersionResponse]
    limit: int
    offset: int
    count: int
    total: int
    has_more: bool = Field(alias="hasMore")
    mutable_count: int = Field(ge=0, alias="mutableCount")
    version_cap: int = Field(ge=1, alias="versionCap")


class VersionPruneResponse(StrictModel):
    deleted_count: int = Field(ge=0, alias="deletedCount")
