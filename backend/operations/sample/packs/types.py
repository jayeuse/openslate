"""Shared types used by the sample-data engine and organization packs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SampleProfile = Literal["small", "standard", "large"]
ActorKey = str
JsonValue = str | int | float | bool | None
FieldType = Literal[
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
    "User",
]
OMIT = object()


@dataclass(frozen=True)
class FieldSpec:
    key: str
    name: str
    type: FieldType
    value_kind: str
    required: bool = False
    options: tuple[str, ...] = ()
    default_value: JsonValue = None
    has_default: bool = False
    minimum: int | float | None = None
    maximum: int | float | None = None
    step: int | float | None = None


@dataclass(frozen=True)
class ModuleSpec:
    key: str
    name: str
    department: ActorKey
    prefix: str
    date_name: str
    statuses: tuple[str, ...]
    standard_count: int
    fields: tuple[FieldSpec, ...]


@dataclass(frozen=True)
class RelationshipSpec:
    key: str
    name: str
    source: str
    target: str
    cardinality: Literal["one-to-one", "one-to-many", "many-to-many"]


@dataclass(frozen=True)
class PersonSpec:
    key: str
    email: str
    username: str
    name: str
    title: str
    role: str
    status: str
    groups: tuple[str, ...] = ()
    actor: str | None = None
    sponsor: str | None = None


@dataclass(frozen=True)
class RejectionCase:
    key: str
    actor_key: str
    needs: tuple[str, ...]
    expected_status: int
    expected_detail: str
    operation: str = "create-record"
    template_record_id: str | None = None
    invalid_field_action: str | None = None
    field_key: str | None = None
    field_value: JsonValue = None
    relationship_key: str | None = None
    source_record_id: str | None = None
    target_record_id: str | None = None
    group_key: str | None = None
    board_key: str | None = None
    post_key: str | None = None
    fallback_description: str | None = None
