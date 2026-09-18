import json
from datetime import datetime
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, JsonValue, field_validator

from app.common.listing import StandardListResponse
from app.systems.manage.audit.models import AuditAction, SecurityEventOutcome

_MAX_MAP_ITEMS = 20
_MAX_MAP_KEY_LENGTH = 50
_MAX_LABEL_VALUE_LENGTH = 100
_MAX_METADATA_BYTES = 4096
_MAX_METADATA_DEPTH = 4
_SENSITIVE_KEY_MARKERS = (
    "password",
    "token",
    "secret",
    "api_key",
    "credential",
    "private_key",
    "invite_link",
    "raw_provider_payload",
)


def _validate_key(key: str) -> None:
    if not 1 <= len(key) <= _MAX_MAP_KEY_LENGTH:
        raise ValueError("Keys must be between 1 and 50 characters")
    normalized = key.lower().replace("-", "_")
    if any(marker in normalized for marker in _SENSITIVE_KEY_MARKERS):
        raise ValueError("Sensitive keys are not permitted")


def _validate_json_value(value: JsonValue, *, depth: int) -> None:
    if depth > _MAX_METADATA_DEPTH:
        raise ValueError("Metadata nesting is too deep")
    if isinstance(value, dict):
        if len(value) > _MAX_MAP_ITEMS:
            raise ValueError("Metadata objects may contain at most 20 keys")
        for key, item in value.items():
            _validate_key(key)
            _validate_json_value(item, depth=depth + 1)
    elif isinstance(value, list):
        if len(value) > _MAX_MAP_ITEMS:
            raise ValueError("Metadata arrays may contain at most 20 items")
        for item in value:
            _validate_json_value(item, depth=depth + 1)


def _validate_labels(value: dict[str, str]) -> dict[str, str]:
    if len(value) > _MAX_MAP_ITEMS:
        raise ValueError("Labels may contain at most 20 keys")
    for key, item in value.items():
        _validate_key(key)
        if len(item) > _MAX_LABEL_VALUE_LENGTH:
            raise ValueError("Label values must be at most 100 characters")
    return value


def _validate_metadata(value: dict[str, JsonValue]) -> dict[str, JsonValue]:
    if len(value) > _MAX_MAP_ITEMS:
        raise ValueError("Metadata may contain at most 20 keys")
    for key, item in value.items():
        _validate_key(key)
        _validate_json_value(item, depth=1)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > _MAX_METADATA_BYTES:
        raise ValueError("Metadata must be at most 4096 bytes")
    return value


class AuditLogResponse(BaseModel):
    id: UUID
    created_at: datetime
    performed_by: UUID | None
    action: AuditAction
    entity_type: str
    entity_id: UUID | None
    before: dict[str, object] | None
    after: dict[str, object] | None
    request_id: UUID | None
    request_method: str | None
    request_path: str | None
    actor_label: str | None
    note: str | None

    model_config = ConfigDict(from_attributes=True)


class AuditLogListResponse(StandardListResponse[AuditLogResponse]):
    pass


class SecurityEventIngestRequest(BaseModel):
    event_type: str = Field(min_length=1, max_length=100)
    outcome: SecurityEventOutcome
    source: str = Field(min_length=1, max_length=100)
    operation_id: UUID
    occurred_at: datetime | None = None
    actor_id: UUID | None = None
    subject_id: UUID | None = None
    labels: dict[str, str] = Field(default_factory=dict)
    fingerprint: str | None = Field(default=None, max_length=128)
    reason: str | None = Field(default=None, max_length=500)
    request_id: UUID | None = None
    request_method: str | None = Field(default=None, max_length=10)
    request_path: str | None = Field(default=None, max_length=2048)
    metadata: dict[str, JsonValue] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")

    _validate_labels_field = field_validator("labels")(_validate_labels)
    _validate_metadata_field = field_validator("metadata")(_validate_metadata)


class SecurityEventResponse(BaseModel):
    id: UUID
    occurred_at: datetime
    event_type: str
    outcome: SecurityEventOutcome
    source: str
    operation_id: UUID
    actor_id: UUID | None
    subject_id: UUID | None
    labels: dict[str, str]
    fingerprint: str | None
    reason: str | None
    request_id: UUID | None
    request_method: str | None
    request_path: str | None
    metadata: dict[str, JsonValue] = Field(
        validation_alias=AliasChoices("event_metadata", "metadata"),
        serialization_alias="metadata",
    )

    model_config = ConfigDict(extra="forbid", from_attributes=True, populate_by_name=True)


class SecurityEventListResponse(StandardListResponse[SecurityEventResponse]):
    model_config = ConfigDict(extra="forbid")
