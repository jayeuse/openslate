"""The fixed typed contract shared by sample-data packs and the generic engine."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any

from operations.sample_packs.content_types import ContentSpec
from operations.sample_packs.phase_types import PackPhaseData
from operations.sample_packs.types import (
    FieldSpec,
    JsonValue,
    ModuleSpec,
    PersonSpec,
    RejectionCase,
    RelationshipSpec,
    SampleProfile,
)

if TYPE_CHECKING:
    from operations.sample_blueprint import NamedScenario

FieldValueGenerator = Callable[
    ["OrganizationPack", ModuleSpec, FieldSpec, int, int, date, Mapping[str, int]],
    JsonValue | object,
]
TriggerBuilder = Callable[
    ["OrganizationPack", int, Mapping[str, str], Mapping[str, Mapping[str, str]]],
    list[dict[str, object]],
]
ParentIndexGenerator = Callable[["OrganizationPack", str, int, Mapping[str, int]], tuple[int, ...]]
ReferenceParentGenerator = Callable[
    ["OrganizationPack", str, str, int, Mapping[str, int]], tuple[tuple[str, int], ...]
]
ActivityDateGenerator = Callable[["OrganizationPack", str, int, int, date, Mapping[str, int]], date]
RelatedDateTimeGenerator = Callable[
    ["OrganizationPack", str, str, int, int, date, Mapping[str, int]], str
]
TextGenerator = Callable[..., str]
ReferenceCodeGenerator = Callable[[str, int, int], str | None]


@dataclass(frozen=True)
class PackIdentity:
    key: str
    workspace_name: str
    locale: str
    timezone: str
    currency_symbol: str
    email_domain: str
    uuid_namespace: str
    span: str
    sampling_scope: str


@dataclass(frozen=True)
class PackCatalog:
    departments: tuple[tuple[str, str], ...]
    modules: tuple[ModuleSpec, ...]
    relationships: tuple[RelationshipSpec, ...]
    counts_by_profile: Mapping[SampleProfile, Mapping[str, int]]
    special_statuses: Mapping[str, Mapping[int, str]]
    legacy_counts_by_profile: Mapping[SampleProfile, Mapping[str, int]] | None = None


@dataclass(frozen=True)
class PackActors:
    team_roster: Mapping[str, tuple[str, ...]]
    team_titles: Mapping[str, tuple[str, ...]]
    team_keys: Mapping[str, tuple[str, ...]]
    internal_domain: str
    guest_domains: tuple[str, ...]
    department_keys: tuple[str, ...]
    required_module_keys: tuple[str, ...]
    team_groups: Mapping[str, str]
    group_access: Mapping[str, tuple[tuple[str, str | None, str], ...]]
    people: tuple[PersonSpec, ...]
    lead_weight: int = 1
    member_weight: int = 3
    session_sizes: tuple[int, ...] = (2, 3, 4, 5, 6)


@dataclass(frozen=True)
class PackGenerators:
    field_value: FieldValueGenerator
    build_triggers: TriggerBuilder
    trigger_keys: tuple[str, ...]
    named_scenarios: tuple[NamedScenario, ...]


@dataclass(frozen=True)
class PackLinks:
    reference_fields: tuple[tuple[str, str], ...]
    parent_indices: ParentIndexGenerator
    reference_parents: ReferenceParentGenerator
    after_history: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    after_flags: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class PackDates:
    activity_date: ActivityDateGenerator
    related_datetime: RelatedDateTimeGenerator


@dataclass(frozen=True)
class PackHistory:
    status_paths: Mapping[str, Mapping[str, tuple[str, ...]]]
    protected_records: frozenset[str]
    target_share: float
    reassigned_share: float
    field_paths: Mapping[str, Mapping[str, tuple[JsonValue, ...]]] = field(default_factory=dict)


@dataclass(frozen=True)
class PackRejections:
    activity_cases: tuple[RejectionCase, ...]
    closing_cases: tuple[RejectionCase, ...]
    invalid_option_key: str
    invalid_field_key: str


@dataclass(frozen=True)
class PackBlueprint:
    plan_heading: str
    initial_design_label: str
    published_design_label: str
    record_created_trigger_keys: tuple[str, ...]
    patch_trigger_keys: tuple[str, ...]
    schedule_trigger_keys: tuple[str, ...]
    trigger_mutation: Callable[[Any, str], tuple[str, str, Any]]


@dataclass(frozen=True)
class PackText:
    trade_phrases: tuple[str, ...]
    customer_name: TextGenerator
    supplier_name: TextGenerator
    equipment_name: TextGenerator
    product_name: TextGenerator
    warehouse_name: TextGenerator
    site_place: TextGenerator
    site_name: TextGenerator
    record_title: TextGenerator
    note_text: TextGenerator
    email_value: TextGenerator
    phone_value: TextGenerator
    serial_value: TextGenerator
    reference_code: ReferenceCodeGenerator
    url_value: TextGenerator


@dataclass(frozen=True)
class PackContent:
    supporting_counts: Mapping[str, int]
    data: ContentSpec


@dataclass(frozen=True)
class OrganizationPack:
    identity: PackIdentity
    catalog: PackCatalog
    actors: PackActors
    generators: PackGenerators
    links: PackLinks
    dates: PackDates
    history: PackHistory
    rejections: PackRejections
    blueprint: PackBlueprint
    text: PackText
    content: PackContent
    phases: PackPhaseData | None = None
