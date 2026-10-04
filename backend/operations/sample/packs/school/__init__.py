"""The UK School organization pack consumed by the shared offline planner."""

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
from operations.sample.packs.school import (
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


PACK = OrganizationPack(
    identity=PackIdentity(
        key="school",
        workspace_name="Willowmere Day School",
        locale="en-GB",
        timezone="Europe/London",
        currency_symbol="£",
        email_domain=people.INTERNAL_DOMAIN,
        uuid_namespace="openslate:willowmere-school:v1",
        span="one grading period; 10 teaching weeks",
        sampling_scope="attendance exceptions and school operations; no individual scores",
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
            "students:000001": ("applications:000005",),
            "fee_assessments:000001": ("students:000001",),
            "guidance_cases:000001": ("attendance_exceptions:000005",),
            "collection_cases:000001": ("fee_assessments:000005",),
        },
        after_flags={
            "parent_contacts:000001": ("attendance_exceptions:000001",),
            "parent_contacts:000002": ("academic_alerts:000001",),
            "attendance_exceptions:000006": ("clinic_visits:000001",),
        },
    ),
    dates=PackDates(activity_date=_activity_date, related_datetime=_related_datetime),
    history=PackHistory(
        status_paths=history.STATUS_PATHS,
        protected_records=history.PROTECTED_RECORDS,
        target_share=history.TARGET_SHARE,
        reassigned_share=history.REASSIGNED_SHARE,
        field_paths={
            "applications:000005": {"student_required": (False,)},
            "students:000001": {"fee_required": (False,)},
            "attendance_exceptions:000001": {"parent_contact_required": (False,)},
            "attendance_exceptions:000005": {
                "consecutive_days_absent": (3, 5),
                "guidance_required": (False,),
            },
            "academic_alerts:000001": {"parent_contact_required": (False,)},
            "clinic_visits:000001": {"attendance_required": (False,)},
            "fee_assessments:000005": {"collection_required": (False,)},
        },
    ),
    rejections=PackRejections(
        activity_cases=rejections.ACTIVITY_CASES,
        closing_cases=rejections.CLOSING_CASES,
        invalid_option_key=rejections.INVALID_OPTION_KEY,
        invalid_field_key=rejections.INVALID_FIELD_KEY,
    ),
    blueprint=PackBlueprint(
        plan_heading="Willowmere School data plan (read-only)",
        initial_design_label="Willowmere School Initial Design",
        published_design_label="Willowmere School Operations",
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
    content=PackContent(
        supporting_counts={
            "identities": len(people.PEOPLE),
            "built_in_account_roles_preserved": 3,
            "groups": len(people.GROUP_ACCESS),
            "boards": 11,
            "widgets": 44,
            "posts": 88,
            "events": 132,
            "reminders": 22,
            "attachments": 0,
            "views": 42,
            "dashboards": 7,
            "dashboard_widgets": 28,
            "reports": 12,
        },
        data=content_data.content_spec(),
    ),
    phases=phase_data.PHASES,
)
