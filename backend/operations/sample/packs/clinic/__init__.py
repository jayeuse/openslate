"""The US outpatient Clinic organization pack consumed by the shared offline planner."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from operations.sample.packs.clinic import (
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


def _parent_indices(
    _pack: OrganizationPack, key: str, target: int, counts: Mapping[str, int]
) -> tuple[int, ...]:
    return links.parent_indices(key, target, counts)


def _reference_parents(
    _pack: OrganizationPack, module: str, field: str, index: int, counts: Mapping[str, int]
) -> tuple[tuple[str, int], ...]:
    return links.reference_parents(module, field, index, counts)


def _activity_date(
    _pack: OrganizationPack,
    module: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> date:
    return dates.activity_date(module, index, seed, anchor, counts)


def _related_datetime(
    _pack: OrganizationPack,
    module: str,
    field: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> str:
    return dates.related_datetime(module, field, index, seed, anchor, counts)


def _equipment_name(index: int) -> str:
    return text.equipment_name(index)


PACK = OrganizationPack(
    identity=PackIdentity(
        key="clinic",
        workspace_name="Lakeshore Family Health Center",
        locale="en-US",
        timezone="America/Chicago",
        currency_symbol="$",
        currency_code="USD",
        email_domain=people.INTERNAL_DOMAIN,
        uuid_namespace="openslate:lakeshore-clinic:v1",
        span="one quarter of outpatient care, including the start of flu season",
        sampling_scope=(
            "clinical records are a 3% sample of visits; lab QC, fridge logs, maintenance "
            "and credentials are full volume"
        ),
    ),
    catalog=PackCatalog(
        departments=catalog._DEPARTMENTS,
        modules=catalog._MODULES,
        relationships=catalog._RELATIONSHIPS,
        counts_by_profile=catalog.PROFILE_COUNTS,
        special_statuses=catalog.SPECIAL_STATUSES,
    ),
    actors=PackActors(
        team_roster=people.TEAM_ROSTER,
        team_titles=people.TEAM_TITLES,
        team_keys=people.TEAM_KEYS,
        internal_domain=people.INTERNAL_DOMAIN,
        guest_domains=people.GUEST_DOMAINS,
        department_keys=people.DEPARTMENT_KEYS,
        required_module_keys=people.MODULE_KEYS,
        team_groups=people.TEAM_GROUPS,
        group_access=people.GROUP_ACCESS,
        people=people.PEOPLE,
    ),
    generators=PackGenerators(
        field_value=generation._field_value,
        build_triggers=triggers.build_triggers,
        trigger_keys=triggers.TRIGGER_KEYS,
        named_scenarios=generation.NAMED_SCENARIOS,
    ),
    links=PackLinks(
        reference_fields=links.REFERENCE_FIELDS,
        parent_indices=_parent_indices,
        reference_parents=_reference_parents,
        after_history={
            "claims:000001": ("encounters:000005",),
            "purchase_requests:000001": ("stock_lots:000005",),
            "maintenance_work_orders:000001": ("equipment:000005",),
        },
        after_flags={"incident_reports:000001": ("temperature_logs:000001",)},
    ),
    dates=PackDates(activity_date=_activity_date, related_datetime=_related_datetime),
    history=PackHistory(
        status_paths=history.STATUS_PATHS,
        protected_records=history.PROTECTED_RECORDS,
        target_share=history.TARGET_SHARE,
        reassigned_share=history.REASSIGNED_SHARE,
        field_paths={
            "encounters:000005": {"claim_required": (False,)},
            "stock_lots:000005": {"qty_on_hand": (40, 15), "reorder_required": (False,)},
            "equipment:000005": {"work_order_required": (False,)},
        },
    ),
    rejections=PackRejections(
        activity_cases=rejections.ACTIVITY_CASES,
        closing_cases=rejections.CLOSING_CASES,
        invalid_option_key=rejections.INVALID_OPTION_KEY,
        invalid_field_key=rejections.INVALID_FIELD_KEY,
    ),
    blueprint=PackBlueprint(
        plan_heading="Lakeshore Family Health Center data plan (read-only)",
        initial_design_label="Lakeshore Clinic Initial Design",
        published_design_label="Lakeshore Clinic Operations",
        record_created_trigger_keys=triggers.RECORD_CREATED_KEYS,
        patch_trigger_keys=triggers.PATCH_KEYS,
        schedule_trigger_keys=triggers.SCHEDULE_KEYS,
        trigger_mutation=trigger_rules._trigger_mutation,
    ),
    text=PackText(
        trade_phrases=vocabulary.TRADE_PHRASES,
        customer_name=text.customer_name,
        supplier_name=text.supplier_name,
        equipment_name=_equipment_name,
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
            "identities": len(people.PEOPLE),
            "built_in_account_roles_preserved": 3,
            "groups": len(people.GROUP_ACCESS),
            "boards": 11,
            "posts": 88,
            "events": 132,
            "reminders": 22,
            "attachments": 11,
            "kanban_stages": 31,
            "kanban_labels": 21,
            "kanban_cards": 84,
            "kanban_checklist_items": 7,
            "views": 21,
            "dashboards": 7,
            "dashboard_widgets": 47,
            "reports": 14,
        },
        data=content_data.content_spec(),
    ),
    phases=phase_data.PHASES,
)
