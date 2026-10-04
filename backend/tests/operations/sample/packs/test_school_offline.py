"""Required offline pack admission; no instance, provider or database access."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date
from functools import cache
from uuid import NAMESPACE_URL, UUID, uuid5

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.fields.validation import validate_record_data
from app.systems.sandbox.publications.preflight import (
    module_schema_blockers,
    structure_name_blockers,
)
from app.systems.sandbox.publications.rules import (
    _field_type,
    _trigger_blockers,
    operational_config,
)
from app.systems.sandbox.records.router import _apply_creation_defaults
from operations.sample.blueprint import _option_id
from operations.sample.episodes import plan_sessions, record_parents
from operations.sample.history import plan_history
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.scenario import build_dataset
from operations.seed_sample_data import build_plan_summary
from tests.operations.sample.packs.test_school_access import _LEVEL_RANK, _module_level
from tests.operations.sample.packs.test_school_consistency import pupil_codes
from tests.operations.sample.packs.test_school_content import _content_text
from tests.operations.sample.test_sample_text import MARKERS, RESERVED_DOMAIN

ANCHOR = date(2026, 9, 30)


@cache
def _school(profile="small"):
    return build_dataset(profile, seed=42, anchor_date=ANCHOR, organization=get_pack("school"))


@pytest.mark.parametrize("key", pack_keys())
def test_registered_pack_has_no_design_or_publication_blocker(key):
    dataset = build_dataset("small", seed=42, anchor_date=ANCHOR, organization=get_pack(key))
    document = SandboxDocument.model_validate(dataset.document)
    assert validate_document(document) == []
    assert structure_name_blockers(document) == []
    assert module_schema_blockers(document) == []
    assert all(_trigger_blockers(document, trigger) == [] for trigger in document.triggers)


def test_school_small_plan_is_complete_deterministic_and_authorized():
    dataset = _school()
    pack = dataset.organization
    assert len(dataset.records) == 1_241 == sum(dataset.module_counts.values())
    assert all(count > 0 for count in dataset.module_counts.values())
    assert Counter(record.module_key for record in dataset.records) == dataset.module_counts
    plan = plan_sessions(dataset)
    assert plan == plan_sessions(
        build_dataset("small", seed=42, anchor_date=ANCHOR, organization=pack)
    )
    histories = plan_history(dataset)
    modules = {module.key: module for module in pack.catalog.modules}
    records = {record.logical_id: record for record in dataset.records}
    created = set()
    completed = set()
    parents = record_parents(dataset)
    cases = {case.key: case for case in pack.rejections.activity_cases}
    for session in plan:
        if session.kind == "reject":
            assert set(cases[session.case_key].needs) <= created
            continue
        department = modules[session.module_key].department
        assert (
            _LEVEL_RANK[_module_level(pack, session.creator_key, department, session.module_key)]
            >= 2
        )
        if session.kind == "create":
            for logical_id in session.record_ids:
                assert records[logical_id].creator_key == session.creator_key
                assert set(parents[logical_id]) <= created
                assert set(pack.links.after_history.get(logical_id, ())) <= completed
                created.add(logical_id)
        else:
            for logical_id, index in session.steps:
                assert logical_id in created
                assert histories[logical_id].steps[index].updater_key == session.creator_key
                if index + 1 == len(histories[logical_id].steps):
                    completed.add(logical_id)
    assert created == set(records)
    assert completed == {key for key, history in histories.items() if history.steps}
    for record in dataset.records:
        assert (
            _LEVEL_RANK[
                _module_level(pack, record.assignee_key, record.actor_key, record.module_key)
            ]
            >= 2
        )
    summary = build_plan_summary(dataset)
    assert summary["operational_records"] == 1_241
    assert summary["automation_count"] == summary["test_vector_count"] == 8
    assert summary["planned_rejections"] == 16


def test_school_cross_department_links_start_at_the_referencing_record_and_roster_is_many_to_many():
    dataset = _school("standard")
    modules = {module.key: module for module in dataset.organization.catalog.modules}
    for relationship in dataset.organization.catalog.relationships:
        same_department = (
            modules[relationship.source].department == modules[relationship.target].department
        )
        # A link to another department's record starts at the record that names it.
        assert relationship.child == ("target" if same_department else "source")
        assert "fee_items" not in {relationship.source, relationship.target}
    roster_id = dataset.relationship_ids["student_roster"]
    roster = [edge for edge in dataset.edges if edge.relationship_id == roster_id]
    assert len(roster) == 5_838
    assert len({(edge.source_record_id, edge.target_record_id) for edge in roster}) == len(roster)
    by_student = Counter(edge.source_record_id for edge in roster)
    assert set(by_student.values()) == {7}
    assert len(by_student) == 834


@pytest.mark.parametrize("profile", ("small", "standard"))
def test_school_payloads_and_histories_pass_real_operational_field_validation(profile):
    dataset = _school(profile)
    document = SandboxDocument.model_validate(dataset.document)
    fields = {
        module.id: [
            Field(
                id=UUID(field.id),
                module_id=UUID(module.id),
                name=field.name,
                type=_field_type(field),
                required=field.required,
                config=operational_config(field),
            )
            for field in module.fields
        ]
        for module in document.design.modules
    }
    people = {
        person.key for person in dataset.organization.actors.people if person.status == "active"
    }
    histories = plan_history(dataset)
    failures = []
    for record in dataset.records:
        values = dict(record.data)
        history = histories.get(record.logical_id)
        if history:
            values[dataset.field_ids[record.module_key]["status"]] = _option_id(
                dataset.seed,
                record.module_key,
                "status",
                history.initial_status,
                dataset.organization,
            )
            values.update(
                {
                    dataset.field_ids[record.module_key][key]: value
                    for key, value in history.initial_values.items()
                }
            )
        states = [dict(values)]
        if history:
            for step in history.steps:
                values[dataset.field_ids[record.module_key]["status"]] = _option_id(
                    dataset.seed, record.module_key, "status", step.status, dataset.organization
                )
                values.update(
                    {
                        dataset.field_ids[record.module_key][key]: value
                        for key, value in step.values.items()
                    }
                )
                states.append(dict(values))
        for state in states:
            for key, value in state.items():
                if isinstance(value, str) and value.startswith("@user:"):
                    actor = value.removeprefix("@user:")
                    assert actor in people
                    state[key] = str(uuid5(NAMESPACE_URL, actor))
            try:
                module_fields = fields[dataset.module_ids[record.module_key]]
                validate_record_data(_apply_creation_defaults(state, module_fields), module_fields)
            except ValueError as error:
                failures.append((record.logical_id, str(error)))
    assert failures == []


def test_all_school_generated_text_passes_the_marker_rule():
    dataset = _school("standard")
    pack = dataset.organization
    values = [
        value
        for record in dataset.records
        for value in record.data.values()
        if isinstance(value, str)
    ]
    values += _content_text(pack)
    values += [
        value
        for person in pack.actors.people
        for value in (person.email, person.username, person.name, person.title)
    ]
    values += [name for _key, name in pack.catalog.departments]
    values += [
        value
        for module in pack.catalog.modules
        for value in (
            module.name,
            *(field.name for field in module.fields),
            *(label for field in module.fields for label in field.options),
        )
    ]
    document = SandboxDocument.model_validate(dataset.document)
    values += [trigger.name for trigger in document.triggers]
    offenders = []
    for value in values:
        cleaned = RESERVED_DOMAIN.sub(" ", value)
        for phrase in pack.text.trade_phrases:
            cleaned = re.sub(re.escape(phrase), " ", cleaned, flags=re.IGNORECASE)
        if MARKERS.search(cleaned):
            offenders.append(value)
    assert offenders == []


def test_school_fee_ledger_and_named_part_payment_are_consistent():
    dataset = _school("standard")
    records = {record.logical_id: record for record in dataset.records}

    def value(logical_id, field):
        record = records[logical_id]
        return record.data[dataset.field_ids[record.module_key][field]]

    paid = defaultdict(int)
    for edge in dataset.edges:
        if edge.relationship_id == dataset.relationship_ids["fee_payments"]:
            paid[edge.source_record_id] += value(edge.target_record_id, "amount")
    for record in dataset.records:
        if record.module_key == "fee_assessments":
            logical_id = record.logical_id
            assert value(logical_id, "gross_fees") - value(
                logical_id, "adjustments_total"
            ) == value(logical_id, "net_due")
            assert value(logical_id, "net_due") - paid[logical_id] == value(logical_id, "balance")
    assert value("fee_assessments:000001", "net_due") == 4_200
    assert value("payments:000001", "amount") == 1_600
    assert value("fee_assessments:000001", "balance") == 2_600


def test_school_counter_and_followups_have_real_human_history_dependencies():
    dataset = _school()
    histories = plan_history(dataset)
    attendance = histories["attendance_exceptions:000005"]
    assert attendance.initial_values["consecutive_days_absent"] == 3
    assert attendance.initial_values["guidance_required"] is False
    assert any(step.values.get("consecutive_days_absent") == 5 for step in attendance.steps)
    assert dataset.organization.links.after_history == {
        "students:000001": ("applications:000005",),
        "fee_assessments:000001": ("students:000001",),
        "guidance_cases:000001": ("attendance_exceptions:000005",),
        "collection_cases:000001": ("fee_assessments:000005",),
    }


def test_master_data_modules_keep_their_date_free_research_schema():
    pack = get_pack("school")
    for module in pack.catalog.modules:
        if module.key in {"courses", "rooms", "activities", "fee_items"}:
            assert not [field for field in module.fields if field.type in {"Date", "Date/Time"}]


@pytest.mark.parametrize("profile", ("small", "standard"))
def test_linked_pupil_records_keep_the_same_pupil_reference(profile):
    dataset = _school(profile)
    codes = pupil_codes(dataset)
    relationships = {
        dataset.relationship_ids[item.key]: item
        for item in dataset.organization.catalog.relationships
    }
    failures = []
    checked = Counter()
    for edge in dataset.edges:
        relationship = relationships[edge.relationship_id]
        same_pupil = (
            relationship.source == "students"
            and relationship.target
            in {"attendance_exceptions", "academic_alerts", "grade_change_requests"}
        ) or relationship.key in {"behaviour_guidance", "assessment_adjustments", "fee_collections"}
        if not same_pupil:
            continue
        checked[relationship.key] += 1
        if codes[edge.source_record_id] != codes[edge.target_record_id]:
            failures.append((relationship.key, edge.source_record_id, edge.target_record_id))
    assert failures == []
    assert set(checked) == {
        "student_attendance",
        "student_academic_alerts",
        "student_grade_changes",
        "behaviour_guidance",
        "assessment_adjustments",
        "fee_collections",
    }


@pytest.mark.parametrize("profile", ("small", "standard", "large"))
def test_academic_alerts_and_grade_changes_use_the_pupils_registered_class(profile):
    dataset = _school(profile)
    roster_id = dataset.relationship_ids["student_roster"]
    roster = {
        (edge.source_record_id, edge.target_record_id)
        for edge in dataset.edges
        if edge.relationship_id == roster_id
    }
    failures = []
    for student_key, section_key in (
        ("student_academic_alerts", "section_academic_alerts"),
        ("student_grade_changes", "section_grade_changes"),
    ):
        students = {
            edge.target_record_id: edge.source_record_id
            for edge in dataset.edges
            if edge.relationship_id == dataset.relationship_ids[student_key]
        }
        sections = {
            edge.target_record_id: edge.source_record_id
            for edge in dataset.edges
            if edge.relationship_id == dataset.relationship_ids[section_key]
        }
        for record, student in students.items():
            if (student, sections[record]) not in roster:
                failures.append((record, student, sections[record]))
    assert failures == []
