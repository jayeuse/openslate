"""Harbor Operations organization data and its typed engine interface."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from operations.sample.blueprint import (
    NamedCalculationCheck,
    NamedFieldCheck,
    NamedRelationshipCheck,
    NamedScenario,
)
from operations.sample.packs.content_types import ContentSpec
from operations.sample.packs.harbor import (
    catalog,
    content_data,
    dates,
    generation,
    history,
    links,
    people,
    phase_data,
    rejections,
    text,
    trigger_rules,
    triggers,
    vocabulary,
)
from operations.sample.packs.interface import (
    OrganizationPack,
    PackActors,
    PackBlueprint,
    PackCatalog,
    PackContent,
    PackDates,
    PackGenerators,
    PackHistory,
    PackIdentity,
    PackLinks,
    PackRejections,
    PackText,
)
from operations.sample.packs.types import FieldSpec, JsonValue, ModuleSpec

TRIGGER_KEYS = (
    "order-created-confirmation",
    "urgent-request-created",
    "quote-value-changed",
    "work-order-state-changed",
    "large-invoice-threshold",
    "large-movement-threshold",
    "daily-stock-review",
    "weekly-maintenance-review",
)

_NAMED_SCENARIOS = (
    NamedScenario(
        key="partially-paid-invoice",
        name="Harbor invoice partially settled",
        record_ids=(
            "invoices:000001",
            "payments:000001",
            "sales_orders:000001",
            "customers:000001",
        ),
        expected={"invoice_total": 12_000, "payments_total": 4_500, "outstanding": 7_500},
        field_checks=(
            NamedFieldCheck("invoices:000001", "total", "invoice_total"),
            NamedFieldCheck("payments:000001", "amount", "payments_total"),
        ),
        relationship_checks=(
            NamedRelationshipCheck("invoice_payments", "invoices:000001", "payments:000001"),
        ),
        calculation_checks=(
            NamedCalculationCheck("outstanding", "subtract", ("invoice_total", "payments_total")),
        ),
    ),
)


def _field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> JsonValue | object:
    return generation._field_value(organization, module, field, index, seed, anchor, dict(counts))


def _parent_indices(
    _organization: OrganizationPack,
    key: str,
    target: int,
    counts: Mapping[str, int],
) -> tuple[int, ...]:
    return links.parent_indices(key, target, counts)


def _reference_parents(
    _organization: OrganizationPack,
    module_key: str,
    field_key: str,
    index: int,
    counts: Mapping[str, int],
) -> tuple[tuple[str, int], ...]:
    return links.reference_parents(module_key, field_key, index, counts)


def _activity_date(
    _organization: OrganizationPack,
    module_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> date:
    return dates.activity_date(module_key, index, seed, anchor, counts)


def _related_datetime(
    _organization: OrganizationPack,
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> str:
    return dates.related_datetime(module_key, field_key, index, seed, anchor, counts)


_TEAM_KEYS = {
    team: (f"internal_{team}_lead", *(f"internal_{team}_{index:02d}" for index in range(2, 6)))
    for team in vocabulary.TEAM_ROSTER
}

PACK = OrganizationPack(
    identity=PackIdentity(
        key="harbor",
        workspace_name="Harbor Operations Group",
        locale="en-US",
        timezone="Asia/Manila",
        currency_symbol="₱",
        email_domain="harbor-ops.example",
        uuid_namespace="openslate:harbor-operations:v4",
        span="365-day history; 90-day outlook",
        sampling_scope="scaled operational records with supporting content",
    ),
    catalog=PackCatalog(
        departments=catalog._DEPARTMENTS,
        modules=catalog._MODULES,
        relationships=catalog._RELATIONSHIPS,
        counts_by_profile=catalog.PROFILE_COUNTS,
        special_statuses=catalog.SPECIAL_STATUSES,
        legacy_counts_by_profile=catalog.LEGACY_PROFILE_COUNTS,
    ),
    actors=PackActors(
        team_roster=vocabulary.TEAM_ROSTER,
        team_titles=vocabulary.TEAM_TITLES,
        team_keys=_TEAM_KEYS,
        internal_domain=vocabulary.INTERNAL_DOMAIN,
        guest_domains=vocabulary.GUEST_DOMAINS,
        department_keys=people.DEPARTMENT_KEYS,
        required_module_keys=people.MODULE_KEYS,
        team_groups=people.TEAM_GROUPS,
        group_access=people.GROUP_ACCESS,
        people=people.people(),
    ),
    generators=PackGenerators(
        field_value=_field_value,
        build_triggers=triggers.build_triggers,
        trigger_keys=TRIGGER_KEYS,
        named_scenarios=_NAMED_SCENARIOS,
    ),
    links=PackLinks(
        reference_fields=links.REFERENCE_FIELDS,
        parent_indices=_parent_indices,
        reference_parents=_reference_parents,
    ),
    dates=PackDates(
        activity_date=_activity_date,
        related_datetime=_related_datetime,
    ),
    history=PackHistory(
        status_paths=history.STATUS_PATHS,
        protected_records=history._PROTECTED,
        target_share=history._TARGET_SHARE,
        reassigned_share=history._REASSIGNED_SHARE,
    ),
    rejections=PackRejections(
        activity_cases=rejections.ACTIVITY_CASES,
        closing_cases=rejections.CLOSING_CASES,
        invalid_option_key=rejections.INVALID_OPTION_KEY,
        invalid_field_key=rejections.INVALID_FIELD_KEY,
    ),
    blueprint=PackBlueprint(
        plan_heading="Harbor Operations sample-data plan (read-only)",
        initial_design_label="Harbor Operations Initial Design",
        published_design_label="Harbor Operations Sample",
        record_created_trigger_keys=TRIGGER_KEYS[:2],
        patch_trigger_keys=TRIGGER_KEYS[2:6],
        schedule_trigger_keys=TRIGGER_KEYS[6:],
        trigger_mutation=trigger_rules._trigger_mutation,
    ),
    text=PackText(
        trade_phrases=vocabulary.TRADE_PHRASES,
        customer_name=text.customer_name,
        supplier_name=text.supplier_name,
        equipment_name=text.equipment_name,
        product_name=text.product_name,
        warehouse_name=text.warehouse_name,
        site_place=text.site_place,
        site_name=text.site_name,
        record_title=text.record_title,
        note_text=text.note_text,
        email_value=text.email_value,
        phone_value=text.phone_value,
        serial_value=text.serial_value,
        reference_code=text.reference_code,
        url_value=text.url_value,
    ),
    content=PackContent(
        supporting_counts={
            "identities": 44,
            "built_in_account_roles_preserved": 3,
            "groups": 9,
            "boards": 12,
            "posts": 96,
            "events": 144,
            "reminders": 24,
            "attachments": 11,
            "kanban_stages": 5,
            "kanban_labels": 3,
            "kanban_cards": 12,
            "kanban_checklist_items": 7,
            "views": 36,
            "dashboards": 6,
            "dashboard_widgets": 24,
            "reports": 12,
        },
        data=content_data.content_spec(),
    ),
    phases=phase_data.PHASES,
)

__all__ = ["ContentSpec", "PACK", "TRIGGER_KEYS"]
