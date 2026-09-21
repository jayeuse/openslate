"""Strict portable-document and HTTP schemas for the Sandbox design workspace."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.systems.sandbox.designs.date_values import date_in_range, valid_date, valid_datetime
from app.systems.sandbox.numeric import numeric_matches_step

ID = Annotated[str, Field(min_length=1, max_length=1_000)]
Name = Annotated[str, Field(min_length=1, max_length=80)]
VersionLabel = Annotated[str, Field(min_length=1, max_length=80)]
Text = Annotated[str, Field(max_length=1_000)]
FiniteNumber = Annotated[float, Field(ge=-100_000, le=100_000, allow_inf_nan=False)]
TypedValue = str | int | float | bool | None


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class TextFieldConfig(StrictModel):
    kind: Literal["text", "long-text", "email", "url"]
    default_value: Text = Field(default="", alias="defaultValue")
    max_length: int | None = Field(default=None, ge=1, le=1_000, alias="maxLength")


class NumberFieldConfig(StrictModel):
    kind: Literal["number", "integer"]
    default_value: float | None = Field(default=None, allow_inf_nan=False, alias="defaultValue")
    minimum: float | None = Field(default=None, allow_inf_nan=False, alias="min")
    maximum: float | None = Field(default=None, allow_inf_nan=False, alias="max")
    step: float | None = Field(default=None, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _valid_range(self) -> NumberFieldConfig:
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("min cannot exceed max")
        if self.kind == "integer" and any(
            value is not None and not float(value).is_integer()
            for value in (self.default_value, self.minimum, self.maximum, self.step)
        ):
            raise ValueError("integer field constraints must be whole numbers")
        return self


class DateFieldConfig(StrictModel):
    kind: Literal["date", "datetime"]
    default_value: str | None = Field(default=None, max_length=64, alias="defaultValue")
    earliest: str | None = Field(default=None, max_length=64)
    latest: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _valid_range(self) -> DateFieldConfig:
        valid = valid_date if self.kind == "date" else valid_datetime
        for value in (self.default_value, self.earliest, self.latest):
            if value is not None and not valid(value):
                raise ValueError(f"{self.kind} values must use valid ISO syntax")
        datetime_values = self.kind == "datetime"
        if (
            self.earliest is not None
            and self.latest is not None
            and not date_in_range(
                self.earliest, None, self.latest, datetime_values=datetime_values
            )
        ):
            raise ValueError("earliest cannot exceed latest")
        if self.default_value is not None and not date_in_range(
            self.default_value,
            self.earliest,
            self.latest,
            datetime_values=datetime_values,
        ):
            raise ValueError("defaultValue must be within the earliest and latest limits")
        return self


class CheckboxFieldConfig(StrictModel):
    kind: Literal["checkbox"]
    default_value: bool = Field(default=False, alias="defaultValue")


class SelectFieldConfig(StrictModel):
    kind: Literal["select"]
    default_value: str | None = Field(default=None, max_length=100, alias="defaultValue")
    options: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(max_length=100)

    @model_validator(mode="after")
    def _default_is_option(self) -> SelectFieldConfig:
        if self.default_value is not None and self.default_value not in self.options:
            raise ValueError("select defaultValue must be an option")
        if len(self.options) != len(set(self.options)):
            raise ValueError("select options must be unique")
        return self


FieldConfig = Annotated[
    TextFieldConfig | NumberFieldConfig | DateFieldConfig | CheckboxFieldConfig | SelectFieldConfig,
    Field(discriminator="kind"),
]


def _field_default_is_valid(config: FieldConfig) -> bool:
    value = config.default_value
    if value is None:
        return True
    if isinstance(config, TextFieldConfig):
        if not isinstance(value, str) or (
            config.max_length is not None and len(value) > config.max_length
        ):
            return False
        if config.kind == "email":
            return not value or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) is not None
        if config.kind == "url":
            parsed = urlparse(value)
            return not value or (parsed.scheme in {"http", "https"} and bool(parsed.netloc))
        return True
    if isinstance(config, NumberFieldConfig):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        numeric_value = float(value)
        if config.minimum is not None and numeric_value < config.minimum:
            return False
        if config.maximum is not None and numeric_value > config.maximum:
            return False
        step = config.step if config.step is not None else (1 if config.kind == "integer" else None)
        if step is None:
            return True
        return numeric_matches_step(numeric_value, config.minimum or 0, step)
    if isinstance(config, DateFieldConfig):
        return isinstance(value, str) and date_in_range(
            value,
            config.earliest,
            config.latest,
            datetime_values=config.kind == "datetime",
        )
    if isinstance(config, CheckboxFieldConfig):
        return isinstance(value, bool)
    return (
        isinstance(config, SelectFieldConfig) and isinstance(value, str) and value in config.options
    )


class DesignField(StrictModel):
    id: ID
    name: Name
    type: Literal[
        "Text",
        "Long text",
        "Number",
        "Integer",
        "Date",
        "Date/Time",
        "Checkbox",
        "Select",
        "Email",
        "URL",
    ]
    required: bool = False
    closed: bool = False
    description: Text | None = None
    config: FieldConfig

    @model_validator(mode="after")
    def _matching_config(self) -> DesignField:
        expected_kind = {
            "Text": "text",
            "Long text": "long-text",
            "Number": "number",
            "Integer": "integer",
            "Date": "date",
            "Date/Time": "datetime",
            "Checkbox": "checkbox",
            "Select": "select",
            "Email": "email",
            "URL": "url",
        }[self.type]
        if expected_kind != self.config.kind:
            raise ValueError("field type must match config kind")
        if not _field_default_is_valid(self.config):
            raise ValueError("field config defaultValue does not match its field")
        return self


class DepartmentDocument(StrictModel):
    id: ID
    name: Name
    closed: bool = False


class ModuleDocument(StrictModel):
    id: ID
    department_id: ID = Field(alias="departmentId")
    name: Name
    closed: bool = False
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


AutomationValue = Annotated[LiteralValue | FieldReferenceValue, Field(discriminator="kind")]


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
    value: AutomationValue


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


AutomationTrigger = Annotated[
    RecordCreatedTrigger | FieldChangedTrigger | ThresholdCrossedTrigger | ScheduleTrigger,
    Field(discriminator="kind"),
]


class AutomationCondition(StrictModel):
    id: ID
    field: FieldReference
    operator: Literal[">", ">=", "<", "<=", "=", "!="]
    value: AutomationValue


class ConditionGroup(StrictModel):
    operator: Literal["all", "any"]
    conditions: list[AutomationCondition] = Field(max_length=20)


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
    value: AutomationValue


class CreateRecordValue(StrictModel):
    field_id: ID = Field(alias="fieldId")
    value: AutomationValue


class CreateRecordAction(StrictModel):
    id: ID
    kind: Literal["create-record"]
    module_id: ID = Field(alias="moduleId")
    values: list[CreateRecordValue] = Field(max_length=5_000)


AutomationAction = Annotated[
    NotificationAction
    | ChannelMessageAction
    | AssignTaskAction
    | SetFieldAction
    | CreateRecordAction,
    Field(discriminator="kind"),
]


class AutomationDocument(StrictModel):
    id: ID
    name: Name
    enabled: bool = True
    priority: int = Field(default=0, ge=-10_000, le=10_000)
    trigger: AutomationTrigger
    condition_group: ConditionGroup = Field(alias="conditionGroup")
    actions: list[AutomationAction] = Field(min_length=1, max_length=20)


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
    automations: list[AutomationDocument] = Field(default_factory=list, max_length=500)
    scenarios: list[ScenarioDocument] = Field(default_factory=list, max_length=500)


class SandboxDocument(SandboxSnapshot):
    kind: Literal["openslate-sandbox"]
    schema_version: Literal[2] = Field(alias="schemaVersion")


class PortableVersion(StrictModel):
    id: ID
    label: VersionLabel
    kind: Literal["checkpoint", "published", "imported"]
    document: SandboxSnapshot
    published: bool
    date: Annotated[str, Field(min_length=1, max_length=64)]
    note: Text | None = None


class PortableBundle(SandboxDocument):
    versions: list[PortableVersion] | None = Field(default=None, max_length=50)


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
