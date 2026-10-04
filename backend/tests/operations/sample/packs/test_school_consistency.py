"""School plans agree with their real roster and Board verification contracts."""

import re
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.fields.validation import validate_field_value
from app.systems.sandbox.publications.rules import _field_type, operational_config
from operations.sample.packs import get_pack
from operations.sample.population.board_entries import validate_board_scenarios
from operations.sample.scenario import build_dataset


def test_school_named_fee_records_pass_real_board_amount_validation() -> None:
    pack = get_pack("school")
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30), organization=pack)
    document = SandboxDocument.model_validate(dataset.document)
    module_keys = {value: key for key, value in dataset.module_ids.items()}
    fields: dict[str, list[dict[str, Any]]] = {
        module_keys[module.id]: [field.model_dump() for field in module.fields]
        for module in document.design.modules
    }
    records = {
        record.logical_id: {
            "id": str(uuid5(NAMESPACE_URL, record.logical_id)),
            "module_key": record.module_key,
            "data": record.data,
        }
        for record in dataset.records
    }

    result = validate_board_scenarios(records, fields, organization=pack)

    assert result["assessment_total"] == Decimal(4_200)
    assert result["payment_amount"] == Decimal(1_600)
    assert result["assessment_total"] - result["payment_amount"] == Decimal(2_600)
    assert result["record_ids"] == {
        logical_id: records[logical_id]["id"] for logical_id in pack.content.data.required_records
    }


@pytest.mark.parametrize("profile", ("small", "standard", "large"))
def test_school_class_headcounts_and_capacity_match_actual_admitted_rosters(profile) -> None:
    dataset = build_dataset(
        profile, seed=42, anchor_date=date(2026, 9, 30), organization=get_pack("school")
    )
    roster_id = dataset.relationship_ids["student_roster"]
    headcounts = Counter(
        edge.target_record_id for edge in dataset.edges if edge.relationship_id == roster_id
    )
    document = SandboxDocument.model_validate(dataset.document)
    module = next(
        item for item in document.design.modules if item.id == dataset.module_ids["class_sections"]
    )
    fields = {
        field.id: Field(
            id=UUID(field.id),
            module_id=UUID(module.id),
            name=field.name,
            type=_field_type(field),
            required=field.required,
            config=operational_config(field),
        )
        for field in module.fields
    }
    enrolled_id = dataset.field_ids["class_sections"]["enrolled_count"]
    capacity_id = dataset.field_ids["class_sections"]["capacity"]
    discrepancies = []
    validation_failures = []
    for record in dataset.records:
        if record.module_key != "class_sections":
            continue
        enrolled = record.data[enrolled_id]
        capacity = record.data[capacity_id]
        if enrolled != headcounts[record.logical_id] or capacity < headcounts[record.logical_id]:
            discrepancies.append(
                (record.logical_id, enrolled, capacity, headcounts[record.logical_id])
            )
        for field_id in (enrolled_id, capacity_id):
            try:
                validate_field_value(fields[field_id], record.data[field_id])
            except ValueError as error:
                validation_failures.append((record.logical_id, str(error)))

    assert discrepancies == []
    assert validation_failures == []


def pupil_codes(dataset: Any) -> dict[str, str]:
    """Each pupil record's student number: its own, its typed code, or its linked student's."""
    records = {record.logical_id: record for record in dataset.records}

    def field(logical_id: str, key: str) -> Any:
        record = records[logical_id]
        return record.data.get(dataset.field_ids[record.module_key][key])

    codes = {
        record.logical_id: field(record.logical_id, "student_no")
        for record in dataset.records
        if record.module_key == "students"
    }
    codes.update(
        (record.logical_id, field(record.logical_id, "student_reference"))
        for record in dataset.records
        if "student_reference" in dataset.field_ids[record.module_key]
    )
    student_links = {
        dataset.relationship_ids[spec.key]
        for spec in dataset.organization.catalog.relationships
        if spec.child == "source" and spec.target == "students"
    }
    for edge in dataset.edges:
        if edge.relationship_id in student_links:
            codes[edge.source_record_id] = codes[edge.target_record_id]
    return codes


def test_school_pupil_titles_agree_with_their_student_number_or_student_link() -> None:
    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack("school")
    )
    records = {record.logical_id: record for record in dataset.records}
    codes = pupil_codes(dataset)
    mismatches = []
    for logical_id, code in codes.items():
        record = records[logical_id]
        if record.module_key == "students":
            continue
        title = record.data[dataset.field_ids[record.module_key]["name"]]
        if not code or code not in title:
            mismatches.append((logical_id, code, title))

    assert mismatches == []
    assert {logical_id.split(":")[0] for logical_id in codes} >= {
        "attendance_exceptions",
        "behaviour_incidents",
        "guidance_cases",
        "parent_contacts",
        "clinic_visits",
        "health_alerts",
        "fee_assessments",
        "fee_adjustments",
        "collection_cases",
    }


@pytest.mark.parametrize("anchor", (date(2026, 9, 30), date(2026, 4, 15)))
def test_school_attendance_titles_only_state_their_actual_activity_date(anchor) -> None:
    dataset = build_dataset("small", seed=42, anchor_date=anchor, organization=get_pack("school"))
    fields = dataset.field_ids["attendance_exceptions"]
    wrong_dates = []
    for record in dataset.records:
        if record.module_key != "attendance_exceptions":
            continue
        title = str(record.data[fields["name"]])
        title_date = re.search(r"\bon (\d{1,2} [A-Za-z]+)\b", title)
        if title_date:
            actual = date.fromisoformat(str(record.data[fields["activity_date"]]))
            stated = datetime.strptime(f"{title_date[1]} {actual.year}", "%d %B %Y")
            if (stated.month, stated.day) != (actual.month, actual.day):
                wrong_dates.append((record.logical_id, title, actual))

    assert wrong_dates == []


@pytest.mark.parametrize("seed", (17, 42))
def test_school_enrolment_chain_keeps_the_same_child_name_and_year_group(seed) -> None:
    dataset = build_dataset(
        "small", seed=seed, anchor_date=date(2026, 9, 30), organization=get_pack("school")
    )
    records = {record.logical_id: record for record in dataset.records}
    document = SandboxDocument.model_validate(dataset.document)
    fields = {field.id: field for module in document.design.modules for field in module.fields}

    def value(logical_id, key):
        record = records[logical_id]
        return record.data[dataset.field_ids[record.module_key][key]]

    def selected_label(logical_id, key):
        record = records[logical_id]
        field_id = dataset.field_ids[record.module_key][key]
        config = fields[field_id].model_dump()["config"]
        return next(
            option["label"]
            for option in config["options"]
            if option["id"] == value(logical_id, key)
        )

    pupil_name = f"{value('students:000001', 'first_name')} {value('students:000001', 'last_name')}"
    application = "applications:000005"
    inquiry = next(
        edge.source_record_id
        for edge in dataset.edges
        if edge.relationship_id == dataset.relationship_ids["inquiry_applications"]
        and edge.target_record_id == application
    )
    assert value(application, "applicant_name") == pupil_name
    assert value(inquiry, "child_name") == pupil_name
    year_group = selected_label("students:000001", "year_group")
    assert selected_label(application, "entry_grade") == year_group
    assert selected_label(inquiry, "entry_grade") == year_group
    for logical_id in (application, inquiry, "students:000001"):
        assert pupil_name in value(logical_id, "name")
        assert year_group in value(logical_id, "name")
