"""The Philippine FMCG distributor organization pack consumed by the shared offline planner."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from operations.sample.packs.fmcg_distributor import (
    catalog,
    content_data,
    dates,
    generation,
    history,
    links,
    parents,
    people,
    phase_data,
    realism,
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

# Kanban cards on each department Board at Small (spec R9: 12, 24 or 60 by profile).
SMALL_CARDS_PER_BOARD = 12
# OpenView items the shared planner builds from the published structure; the pack test
# checks them against the plan.
DASHBOARD_WIDGETS = 49
REPORTS = 13


def _parent_indices(
    _pack: OrganizationPack, key: str, target: int, counts: Mapping[str, int]
) -> tuple[int, ...]:
    return parents.parent_indices(key, target, counts)


def _reference_parents(
    _pack: OrganizationPack, module: str, field: str, index: int, counts: Mapping[str, int]
) -> tuple[tuple[str, int], ...]:
    return parents.reference_parents(module, field, index, counts)


def _activity_date(_pack: OrganizationPack, module: str, index: int, seed: int, anchor: date,
                   counts: Mapping[str, int]) -> date:  # fmt: skip
    return dates.activity_date(module, index, seed, anchor, counts)


def _related_datetime(_pack: OrganizationPack, module: str, field: str, index: int, seed: int,
                      anchor: date, counts: Mapping[str, int]) -> str:  # fmt: skip
    return dates.related_datetime(module, field, index, seed, anchor, counts)


def _supporting_counts() -> dict[str, int]:
    content = content_data.content_spec()
    departments = [key for key, _name in catalog._DEPARTMENTS]
    kanban = content_data.KANBAN
    others = [key for key in departments if f"department:{key}" != kanban.board]
    boards = 1 + len(departments) + len(content.projects)
    return {
        "identities": len(people.PEOPLE),
        "built_in_account_roles_preserved": 3,
        "groups": len(people.GROUP_ACCESS),
        "boards": boards,
        "posts": boards * content.posts_per_board,
        "events": boards * content.events_per_board,
        "reminders": 2 * boards,
        "attachments": len(content.board_files),
        "kanban_stages": len(kanban.stages) + sum(len(realism.BOARD_STAGES[key])
                                                  for key in others),
        "kanban_labels": len(kanban.labels) + 3 * len(others),
        "kanban_cards": SMALL_CARDS_PER_BOARD * len(departments),
        "kanban_checklist_items": sum(len(card.checklist) for card in kanban.cards),
        "views": len(content.layouts) * len(departments),
        "dashboards": len(departments),
        "dashboard_widgets": DASHBOARD_WIDGETS,
        "reports": REPORTS,
    }  # fmt: skip


PACK = OrganizationPack(
    identity=PackIdentity(
        key="fmcg_distributor",
        workspace_name="Silangan Consumer Distributors, Inc.",
        locale="en-PH",
        timezone="Asia/Manila",
        currency_symbol="₱",
        currency_code="PHP",
        email_domain=people.INTERNAL_DOMAIN,
        uuid_namespace="openslate:silangan-fmcg:v1",
        span="one quarter of route-to-market distribution, from purchase order to collection",
        sampling_scope=(
            "store visits, orders, invoices and collections are about a 1:50 sample of the "
            "front line; purchasing, stock and claims are a 1:2 to 1:6 sample; principals, "
            "beats and vehicles are full volume"
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
            "principal_claims:000001": (f"goods_receipts:{links.DISCREPANCY_RECEIPT + 1:06d}",),
            "collection_followups:000001": (f"sales_invoices:{links.FOLLOWED_INVOICE + 1:06d}",),
        },
    ),
    dates=PackDates(activity_date=_activity_date, related_datetime=_related_datetime),
    history=PackHistory(
        status_paths=history.STATUS_PATHS,
        protected_records=history.PROTECTED_RECORDS,
        target_share=history.TARGET_SHARE,
        reassigned_share=history.REASSIGNED_SHARE,
        field_paths={
            f"goods_receipts:{links.DISCREPANCY_RECEIPT + 1:06d}": {"claim_required": (False,)},
            f"sales_invoices:{links.FOLLOWED_INVOICE + 1:06d}": {
                "days_past_due": (18, 33),
                "followup_required": (False,),
            },
        },
    ),
    rejections=PackRejections(
        activity_cases=rejections.ACTIVITY_CASES,
        closing_cases=rejections.CLOSING_CASES,
        invalid_option_key=rejections.INVALID_OPTION_KEY,
        invalid_field_key=rejections.INVALID_FIELD_KEY,
    ),
    blueprint=PackBlueprint(
        plan_heading="Silangan Consumer Distributors data plan (read-only)",
        initial_design_label="Silangan Distributors Initial Design",
        published_design_label="Silangan Distributors Operations",
        record_created_trigger_keys=triggers.RECORD_CREATED_KEYS,
        patch_trigger_keys=triggers.PATCH_KEYS,
        schedule_trigger_keys=triggers.SCHEDULE_KEYS,
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
    content=PackContent(supporting_counts=_supporting_counts(), data=content_data.content_spec()),
    phases=phase_data.PHASES,
)
