from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from app.systems.sandbox.publications.preflight import (
    module_schema_blockers,
    structure_name_blockers,
)
from app.systems.sandbox.publications.rules import _trigger_blockers
from operations.sample_blueprint import (
    NamedCalculationCheck,
    NamedFieldCheck,
    NamedRelationshipCheck,
    NamedScenario,
    _option_id,
)
from operations.sample_catalog import FieldSpec, ModuleSpec, RelationshipSpec
from operations.sample_episodes import plan_sessions
from operations.sample_history import plan_history
from operations.sample_named_scenarios import named_scenario_issues
from operations.sample_packs.content_types import ContentSpec
from operations.sample_packs.interface import (
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
from operations.sample_packs.types import OMIT, JsonValue, PersonSpec, RejectionCase
from operations.sample_scenario import build_dataset
from operations.seed_sample_data import build_plan_summary


def _id(pack: OrganizationPack, seed: int, kind: str, key: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"{pack.identity.uuid_namespace}:{seed}:{kind}:{key}"))


def _content_spec() -> ContentSpec:
    def empty_text(*_args: object) -> str:
        return ""

    return ContentSpec(
        department_groups={},
        leads={},
        projects=(),
        project_groups=(),
        required_modules=(),
        company_source_department="",
        required_records={},
        amounts=(),
        scenario_total=Decimal(0),
        scenario_paid=Decimal(0),
        scenario_balance=Decimal(0),
        board_links=(),
        post_states=(),
        posts_per_board=0,
        events_per_board=0,
        event_titles=(),
        event_details={},
        event_locations=(),
        reminders=(),
        layouts=(),
        posts={},
        board_descriptions={},
        layout_names={},
        post_text=lambda *_args: ("", ""),
        revised_post=lambda *_args: ("", ""),
        project_board=lambda *_args: ("", ""),
        view_name=empty_text,
        dashboard_name=empty_text,
        report_names=lambda *_args: ("", ""),
    )


def _tiny_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    _counts: dict[str, int],
) -> JsonValue | object:
    if field.value_kind == "title":
        return f"{module.name} {index + 1}"
    if field.value_kind == "reference":
        return f"{module.prefix}-{index + 1:04d}"
    if field.value_kind == "status":
        return _option_id(seed, module.key, field.key, "Active", organization)
    if field.value_kind == "date":
        return anchor.isoformat()
    if field.value_kind == "owner":
        return "@user:internal_ops_lead"
    if field.value_kind == "notes":
        return "Routine operational update"
    if field.value_kind == "boolean":
        return True if field.key == "flag" else OMIT
    return None


def _tiny_triggers(
    organization: OrganizationPack,
    seed: int,
    module_ids: dict[str, str],
    field_ids: dict[str, dict[str, str]],
) -> list[dict[str, object]]:
    return [
        {
            "id": _id(organization, seed, "trigger", "flag-request"),
            "name": "Flag request",
            "enabled": True,
            "priority": 1,
            "trigger": {"kind": "record-created", "moduleId": module_ids["requests"]},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": _id(organization, seed, "action", "flag-request"),
                    "kind": "set-field",
                    "target": {
                        "moduleId": module_ids["requests"],
                        "fieldId": field_ids["requests"]["flag"],
                    },
                    "value": {"kind": "literal", "value": True},
                }
            ],
        }
    ]


_COMMON_FIELDS = (
    FieldSpec("name", "Name", "Text", "title", required=True),
    FieldSpec("reference", "Reference", "Text", "reference"),
    FieldSpec(
        "status",
        "Status",
        "Select",
        "status",
        options=("Open", "Active"),
        default_value="Open",
        has_default=True,
    ),
    FieldSpec("activity_date", "Opened on", "Date", "date"),
    FieldSpec("owner", "Assigned to", "User", "owner"),
    FieldSpec("notes", "Notes", "Long text", "notes", default_value="", has_default=True),
)

_TINY_PACK = OrganizationPack(
    identity=PackIdentity(
        "tiny-office",
        "Northside Service Office",
        "en-GB",
        "Europe/London",
        "£",
        "northside.example",
        "openslate:tiny-office:v1",
        span="one working week",
        sampling_scope="complete request roster",
    ),
    catalog=PackCatalog(
        departments=(("ops", "Operations"),),
        modules=(
            ModuleSpec(
                "requests",
                "Service Request",
                "ops",
                "REQ",
                "Opened on",
                ("Open", "Active"),
                2,
                (*_COMMON_FIELDS, FieldSpec("flag", "Needs review", "Checkbox", "boolean")),
            ),
            ModuleSpec(
                "updates",
                "Request Update",
                "ops",
                "UPD",
                "Updated on",
                ("Open", "Active"),
                2,
                _COMMON_FIELDS,
            ),
        ),
        relationships=(
            RelationshipSpec("request_updates", "Updates", "requests", "updates", "one-to-many"),
        ),
        counts_by_profile={
            profile: {"requests": 2, "updates": 2} for profile in ("small", "standard", "large")
        },
        special_statuses={},
    ),
    actors=PackActors(
        team_roster={"ops": ("Avery Quinn",)},
        team_titles={"ops": ("Operations Lead",)},
        team_keys={"ops": ("internal_ops_lead",)},
        internal_domain="northside.example",
        guest_domains=("auditor.example",),
        department_keys=("ops",),
        required_module_keys=("requests", "updates"),
        team_groups={"ops": "operations-team"},
        group_access={
            "operations-team": (("ops", None, "write"),),
            "guest-readers": (("ops", None, "read"),),
        },
        people=(
            PersonSpec(
                "internal_ops_lead",
                "avery.quinn@northside.example",
                "avery_quinn",
                "Avery Quinn",
                "Operations Lead",
                "member",
                "active",
                ("operations-team",),
                "ops",
            ),
            PersonSpec(
                "guest_01",
                "riley.chen@auditor.example",
                "riley_chen",
                "Riley Chen",
                "External Reviewer",
                "guest",
                "active",
                ("guest-readers",),
            ),
        ),
    ),
    generators=PackGenerators(
        field_value=_tiny_value,
        build_triggers=_tiny_triggers,
        trigger_keys=("flag-request",),
        named_scenarios=(),
    ),
    links=PackLinks(
        reference_fields=(),
        parent_indices=lambda _pack, _key, target, counts: (target % counts["requests"],),
        reference_parents=lambda *_args: (),
    ),
    dates=PackDates(
        activity_date=lambda _pack, _module, _index, _seed, anchor, _counts: anchor,
        related_datetime=lambda _pack, _module, _field, _index, _seed, anchor, _counts: (
            f"{anchor.isoformat()}T09:00+00:00"
        ),
    ),
    history=PackHistory(
        status_paths={"requests": {"Active": ("Open",)}, "updates": {"Active": ("Open",)}},
        protected_records=frozenset(),
        target_share=1.0,
        reassigned_share=0.0,
    ),
    rejections=PackRejections(
        activity_cases=(
            RejectionCase("guest_read_only", "guest_01", ("requests:000001",), 403, "Forbidden"),
        ),
        closing_cases=(),
        invalid_option_key="tiny-office:not-an-option",
        invalid_field_key="tiny-office:never-a-field",
    ),
    blueprint=PackBlueprint(
        plan_heading="Tiny office sample-data plan (read-only)",
        initial_design_label="Initial design",
        published_design_label="Published organization",
        record_created_trigger_keys=("flag-request",),
        patch_trigger_keys=(),
        schedule_trigger_keys=(),
        trigger_mutation=lambda _dataset, _key: ("requests:000001", "flag", False),
    ),
    text=PackText(
        trade_phrases=("sample phrase",),
        customer_name=lambda *_args: "Northside Customer",
        supplier_name=lambda *_args: "Northside Supplier",
        equipment_name=lambda *_args: "Pallet Lift",
        product_name=lambda *_args: "Safety Gloves",
        warehouse_name=lambda *_args: "Northside Warehouse",
        site_place=lambda *_args: "Northside",
        site_name=lambda *_args: "Northside Office",
        record_title=lambda *_args: "Northside Record",
        note_text=lambda *_args: "Routine operational update",
        email_value=lambda *_args: "team@northside.example",
        phone_value=lambda *_args: "+44 20 0000 0000",
        serial_value=lambda *_args: "NS-0001",
        reference_code=lambda *_args: "NS-0001",
        url_value=lambda *_args: "https://northside.example",
    ),
    content=PackContent(supporting_counts={"identities": 2, "groups": 2}, data=_content_spec()),
)


def test_a_second_pack_runs_through_the_shared_offline_planners() -> None:
    dataset = build_dataset("small", 17, date(2026, 9, 30), organization=_TINY_PACK)

    assert {module.key for module in _TINY_PACK.catalog.modules} == {"requests", "updates"}
    assert len(dataset.records) == 4
    assert len(dataset.edges) == 2
    assert all(record.actor_key == "ops" for record in dataset.records)
    assert set(dataset.department_ids) == {"ops"}
    assert set(dataset.module_ids) == {"requests", "updates"}

    sessions = plan_sessions(dataset)
    assert any(
        session.kind == "reject" and session.case_key == "guest_read_only" for session in sessions
    )
    histories = plan_history(dataset)
    assert set(histories) == {record.logical_id for record in dataset.records}

    summary = build_plan_summary(dataset)
    assert summary["operational_records"] == 4
    assert summary["relationship_edges"] == 2
    assert summary["planned_rejections"] == 1
    assert summary["supporting_counts"] == {"identities": 2, "groups": 2}

    document = SandboxDocument.model_validate(dataset.document)
    assert validate_document(document) == []
    assert structure_name_blockers(document) == []
    assert module_schema_blockers(document) == []
    assert all(not _trigger_blockers(document, trigger) for trigger in document.triggers)


def test_named_scenario_verifier_uses_pack_fields_links_and_calculations() -> None:
    dataset = build_dataset("small", 17, date(2026, 9, 30), organization=_TINY_PACK)
    scenario = NamedScenario(
        key="request-capacity",
        name="Request capacity",
        record_ids=("requests:000001", "updates:000001"),
        expected={"enabled": True, "capacity": 2, "used": 1, "remaining": 1},
        field_checks=(NamedFieldCheck("requests:000001", "flag", "enabled"),),
        relationship_checks=(
            NamedRelationshipCheck("request_updates", "requests:000001", "updates:000001"),
        ),
        calculation_checks=(NamedCalculationCheck("remaining", "subtract", ("capacity", "used")),),
    )
    dataset = replace(dataset, named_scenarios=(scenario,))
    record_ids = {logical_id: logical_id.replace(":", "-") for logical_id in scenario.record_ids}
    request_field = dataset.field_ids["requests"]["flag"]
    relationship_id = dataset.relationship_ids["request_updates"]
    records = {
        record_ids["requests:000001"]: {"data": {request_field: True}},
        record_ids["updates:000001"]: {"data": {}},
    }
    edges = {(relationship_id, record_ids["requests:000001"], record_ids["updates:000001"])}
    mappings = {"requests:flag": request_field}
    relationships = {"request_updates": relationship_id}

    assert named_scenario_issues(dataset, records, record_ids, mappings, relationships, edges) == []

    records[record_ids["requests:000001"]]["data"][request_field] = False
    broken_expected = replace(
        scenario,
        expected={"enabled": True, "capacity": 2, "used": 1, "remaining": 2},
    )
    dataset = replace(dataset, named_scenarios=(broken_expected,))
    assert named_scenario_issues(dataset, records, record_ids, mappings, relationships, set()) == [
        "named scenario request-capacity field enabled differs",
        "named scenario request-capacity relationship is missing",
        "named scenario request-capacity calculation remaining differs",
    ]


def test_harbor_pack_preserves_the_existing_workspace_identity() -> None:
    from operations.sample_packs.harbor import PACK

    assert (PACK.identity.workspace_name, PACK.identity.locale, PACK.identity.timezone) == (
        "Harbor Operations Group",
        "en-US",
        "Asia/Manila",
    )
