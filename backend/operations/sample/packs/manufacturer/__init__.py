"""The US sauce and condiments plant pack consumed by the shared offline planner."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

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
from operations.sample.packs.manufacturer import (
    catalog,
    content_data,
    dates,
    generation,
    history,
    people,
    phase_data,
    realism,
    rejections,
    relations,
    text,
    trigger_rules,
    triggers,
    vocabulary,
)
from operations.sample.packs.manufacturer import plan_base as base


def _parent_indices(
    _pack: OrganizationPack, key: str, child: int, counts: Mapping[str, int]
) -> tuple[int, ...]:
    return relations.parent_indices(key, child, counts)


def _reference_parents(
    _pack: OrganizationPack, module: str, field: str, index: int, counts: Mapping[str, int]
) -> tuple[tuple[str, int], ...]:
    return relations.reference_parents(module, field, index, counts)


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


def _customer_name(index: int, _seed: int) -> str:
    return base.customer_name(index)


def _equipment_name(index: int) -> str:
    return vocabulary.LINE_EQUIPMENT[index % len(vocabulary.LINE_EQUIPMENT)][0]


def _product_name(index: int, _seed: int) -> str:
    return base.product_name(index)


def _warehouse_name(index: int, _seed: int) -> str:
    return ("Finished goods warehouse", "Raw material warehouse")[index % 2]


def _site_place(index: int, _seed: int) -> str:
    return vocabulary.CUSTOMER_PLACES[index % len(vocabulary.CUSTOMER_PLACES)]


def _site_name(index: int, seed: int, _counts: Mapping[str, int]) -> str:
    return f"{_site_place(index, seed)} distribution center"


def _serial_value(index: int, _seed: int) -> str:
    return f"SN-{48_210 + index * 7}"


_DEPARTMENTS = len(catalog._DEPARTMENTS)
_KANBAN = content_data.KANBAN
_BOARDS = 1 + _DEPARTMENTS + len(content_data.PROJECTS)
_OTHER_BOARDS = [key for key in people.DEPARTMENT_KEYS if f"department:{key}" != _KANBAN.board]
_SMALL_CARDS = 12  # Cards on each department Board at the Small profile (spec R9).

PACK = OrganizationPack(
    identity=PackIdentity(
        key="manufacturer",
        workspace_name="Tillmore Kettle Foods",
        locale="en-US",
        timezone="America/Chicago",
        currency_symbol="$",
        currency_code="USD",
        email_domain=people.INTERNAL_DOMAIN,
        uuid_namespace="openslate:tillmore-kettle-foods:v1",
        span=(
            "six weeks of plant work at full volume, with one month-end close and the start "
            "of the holiday peak"
        ),
        sampling_scope=(
            "orders, batches, lots, shift reports and food safety logs are near full plant "
            "volume for the six weeks; customers, products, materials and suppliers are the "
            "active subset; pH, Brix and viscosity are fields on the batch record"
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
        reference_fields=(("customer_payments", "remit_invoice"),),
        parent_indices=_parent_indices,
        reference_parents=_reference_parents,
        # The planned human steps after a create rule flags a record (plan rule 5).
        after_flags={
            "ncrs:000001": ("material_lots:000001",),
            "capas:000001": ("ncrs:000002",),
            "maintenance_work_orders:000001": ("downtime_events:000001",),
        },
    ),
    dates=PackDates(activity_date=_activity_date, related_datetime=_related_datetime),
    history=PackHistory(
        status_paths=history.STATUS_PATHS,
        protected_records=history.PROTECTED_RECORDS,
        target_share=history.TARGET_SHARE,
        reassigned_share=history.REASSIGNED_SHARE,
    ),
    rejections=PackRejections(
        activity_cases=rejections.ACTIVITY_CASES,
        closing_cases=rejections.CLOSING_CASES,
        invalid_option_key=rejections.INVALID_OPTION_KEY,
        invalid_field_key=rejections.INVALID_FIELD_KEY,
    ),
    blueprint=PackBlueprint(
        plan_heading="Tillmore Kettle Foods data plan (read-only)",
        initial_design_label="Tillmore Plant Initial Design",
        published_design_label="Tillmore Plant Operations",
        record_created_trigger_keys=triggers.RECORD_CREATED_KEYS,
        patch_trigger_keys=triggers.PATCH_KEYS,
        schedule_trigger_keys=triggers.SCHEDULE_KEYS,
        trigger_mutation=trigger_rules._trigger_mutation,
    ),
    text=PackText(
        trade_phrases=vocabulary.TRADE_PHRASES,
        customer_name=_customer_name,
        supplier_name=base.supplier_name,
        equipment_name=_equipment_name,
        product_name=_product_name,
        warehouse_name=_warehouse_name,
        site_place=_site_place,
        site_name=_site_name,
        record_title=text.record_title,
        note_text=text.note_text,
        email_value=text.email_value,
        phone_value=text.phone_value,
        serial_value=_serial_value,
        reference_code=text.reference_code,
        url_value=text.url_value,
    ),
    content=PackContent(
        supporting_counts={
            "identities": len(people.PEOPLE),
            "built_in_account_roles_preserved": 3,
            "groups": len(people.GROUP_ACCESS),
            "boards": _BOARDS,
            "posts": _BOARDS * content_data.POSTS_PER_BOARD,
            "events": _BOARDS * content_data.EVENTS_PER_BOARD,
            "reminders": _BOARDS * 2,  # The first two events of each Board remind people.
            "attachments": len(content_data.BOARD_FILES),
            "kanban_stages": len(_KANBAN.stages)
            + sum(len(realism.BOARD_STAGES[key]) for key in _OTHER_BOARDS),
            "kanban_labels": len(_KANBAN.labels) + 3 * len(_OTHER_BOARDS),
            "kanban_cards": _SMALL_CARDS * _DEPARTMENTS,
            "kanban_checklist_items": sum(len(card.checklist) for card in _KANBAN.cards),
            "views": len(content_data.LAYOUTS) * _DEPARTMENTS,
            "dashboards": _DEPARTMENTS,
            # Seven Overview widgets and two report sources on every department (spec R8).
            "dashboard_widgets": 7 * _DEPARTMENTS,
            "reports": 2 * _DEPARTMENTS,
        },
        data=content_data.content_spec(),
    ),
    phases=phase_data.PHASES,
)
