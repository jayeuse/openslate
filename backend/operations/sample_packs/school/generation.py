"""Deterministic school record values, including linked fee-ledger examples."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date

from operations.sample_actors import assignee_key
from operations.sample_blueprint import (
    NamedCalculationCheck,
    NamedFieldCheck,
    NamedRelationshipCheck,
    NamedScenario,
    _option_id,
)
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.school import dates, text, vocabulary
from operations.sample_packs.school.catalog_fields import YEAR_GROUPS
from operations.sample_packs.school.links import parent_indices, reference_parents
from operations.sample_packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec

NAMED_SCENARIOS = (
    NamedScenario(
        key="fee-assessment-part-payment",
        name="Autumn statement part payment",
        record_ids=("fee_assessments:000001", "payments:000001"),
        expected={"net_due": 4_200, "payment_amount": 1_600, "balance": 2_600},
        field_checks=(
            NamedFieldCheck("fee_assessments:000001", "net_due", "net_due"),
            NamedFieldCheck("fee_assessments:000001", "balance", "balance"),
            NamedFieldCheck("payments:000001", "amount", "payment_amount"),
        ),
        relationship_checks=(
            NamedRelationshipCheck("fee_payments", "fee_assessments:000001", "payments:000001"),
        ),
        calculation_checks=(
            NamedCalculationCheck("balance", "subtract", ("net_due", "payment_amount")),
        ),
    ),
)


def _year_group_index(index: int, seed: int) -> int:
    return (index * 5 + seed) % len(YEAR_GROUPS)


def _assessment_totals(index: int) -> tuple[int, int, int]:
    if index == 0:
        return 5_000, 800, 4_200
    gross = 6_800 + (index * 197) % 6_000
    adjustments = (index * 73) % 1_200
    return gross, adjustments, gross - adjustments


def _payment_indexes(assessment_index: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    assessment_count = counts["fee_assessments"]
    payment_count = counts["payments"]
    indexes = [assessment_index] if assessment_index < payment_count else []
    extra_count = max(0, payment_count - assessment_count)
    if 1 <= assessment_index <= extra_count:
        indexes.append(assessment_count + assessment_index - 1)
    return tuple(indexes)


def _assessment_index_for_payment(payment_index: int, counts: Mapping[str, int]) -> int:
    assessment_count = counts["fee_assessments"]
    return (
        payment_index if payment_index < assessment_count else payment_index - assessment_count + 1
    )


def _paid_total(assessment_index: int, counts: Mapping[str, int]) -> int:
    _gross, _adjustments, net_due = _assessment_totals(assessment_index)
    if assessment_index == 0:
        return 1_600
    if assessment_index == 4:
        return net_due // 3
    remainder = assessment_index % 100
    if remainder < 32:
        return net_due
    if remainder < 82:
        return net_due // 2
    if remainder < 91:
        return net_due // 3
    return max(1, net_due // 4)


def _payment_amount(payment_index: int, counts: Mapping[str, int]) -> int:
    assessment_index = _assessment_index_for_payment(payment_index, counts)
    indexes = _payment_indexes(assessment_index, counts)
    total = _paid_total(assessment_index, counts)
    position = indexes.index(payment_index)
    if position == len(indexes) - 1:
        return total - total // len(indexes) * position
    return total // len(indexes)


def _status_label(module: ModuleSpec, index: int, seed: int) -> str:
    key = module.key
    if key == "applications":
        if index == 4:
            return "Enrolled"
        return module.statuses[index % 6]
    if key == "attendance_exceptions":
        if index == 0:
            return "Unexplained"
        if index == 5:
            return "Explained"
        return ("Verified", "Explained", "Unexplained", "Amended")[index % 100 // 25]
    if key == "students":
        if index == 0:
            return "Enrolled"
        if index == 1:
            return "Incoming"
    if key == "class_sections":
        return ("Posted", "Approved", "Submitted", "Returned for correction")[index % 100 // 25]
    if key == "fee_assessments":
        if index == 0:
            return "Partially paid"
        if index == 4:
            return "Past due"
        _gross, _adjustments, net_due = _assessment_totals(index)
        if _paid_total(index, {"fee_assessments": 1, "payments": 1}) == net_due:
            return "Paid"
        return "Past due" if index % 5 == 0 else "Partially paid"
    if key == "payments":
        return ("Reconciled", "Deposited", "Reconciled", "Recorded")[index % 4]
    if key == "report_card_batches":
        return ("Released", "Conference follow-up", "Principal sign-off", "Held")[index % 100 // 25]
    if key == "academic_alerts":
        if index == 0:
            return "Raised"
        return ("Resolved", "Intervention", "Parent notified", "Escalated to guidance")[index % 4]
    if key == "behaviour_incidents":
        return ("Closed", "Parent informed", "Action assigned", "Under investigation", "Unfounded")[
            index % 5
        ]
    if key == "clinic_visits":
        return ("Closed", "Parent informed", "Disposed")[index % 3]
    if key == "fee_adjustments":
        return ("Applied", "Approved", "Under review", "Declined", "Revoked")[index % 5]
    if key == "collection_cases":
        return ("Open", "Promise to pay", "Settled", "Broken promise", "Written off")[index % 5]
    if key == "maintenance_requests":
        return (
            "Closed",
            "Completed",
            "In progress",
            "Assigned",
            "On hold",
            "New",
            "Rejected",
            "Duplicate",
        )[index % 8]
    return module.statuses[(index * 7 + seed) % len(module.statuses)]


def _choice_label(field: FieldSpec, index: int, seed: int, anchor: date | None = None) -> str:
    if field.value_kind == "attendance_code":
        if index in {0, 4}:
            return "N — Reason not yet established"
        if index == 5:
            return "I — Illness"
        selected = field.options[(index + seed) % len(field.options)]
        if selected.startswith("N —") and index % 97 != 0:
            return "O — Other or unknown absence"
        return selected
    if field.key == "year_group":
        return YEAR_GROUPS[_year_group_index(index, seed)]
    if field.key == "entry_grade":
        return YEAR_GROUPS[(index * 7 + seed) % len(YEAR_GROUPS)]
    if field.key == "disposition" and index == 0:
        return "Sent home"
    if field.key in {"school_year", "entry_year"} and anchor is not None:
        current_year = anchor.year if anchor.month >= 9 else anchor.year - 1
        target_year = current_year + (field.key == "entry_year")
        return min(field.options, key=lambda label: abs(int(label[:4]) - target_year))
    return field.options[(index * 7 + seed) % len(field.options)]


def _reference_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    counts: Mapping[str, int],
) -> str | object:
    parents = (
        reference_parents(module.key, field.key, index, counts)
        if field.value_kind == "cross_reference"
        else ()
    )
    values = [text.reference_code(target, target_index, seed) for target, target_index in parents]
    if not values and field.value_kind == "reference":
        value = text.reference_code(module.key, index, seed)
        values = [value] if value is not None else []
    if not values and not field.required:
        return OMIT
    if not values or any(value is None for value in values):
        raise ValueError(f"School reference field {module.key}.{field.key} has no record code")
    return "; ".join(str(value) for value in values)


def _fee_assessment_value(field_key: str, index: int, counts: Mapping[str, int]) -> int:
    gross, adjustment, due = _assessment_totals(index)
    if field_key == "gross_fees":
        return gross
    if field_key == "adjustments_total":
        return adjustment
    if field_key == "net_due":
        return due
    paid = _paid_total(index, counts)
    return due - paid


def _student_name_part(index: int, seed: int, first: bool) -> str:
    names = vocabulary.FIRST_NAMES if first else vocabulary.LAST_NAMES
    multiplier = 7 if first else 13
    offset = seed if first else seed // 3
    return names[(index * multiplier + offset) % len(names)]


def _field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> JsonValue | object:
    rng = random.Random(f"{seed}:{module.key}:{index}:{field.key}:school")
    kind = field.value_kind
    if kind == "status":
        label = _status_label(module, index, seed)
        if label == field.default_value and index % 5 == 0:
            return OMIT
        return _option_id(seed, module.key, field.key, label, organization)
    if field.type == "Select":
        return _option_id(
            seed, module.key, field.key, _choice_label(field, index, seed, anchor), organization
        )
    if kind == "title":
        return text.record_title(module.key, index, seed, counts)
    if kind == "reference" or kind == "cross_reference":
        if kind == "reference" and field.key == "student_no":
            return text.reference_code("students", index, seed)
        return _reference_value(organization, module, field, index, seed, counts)
    if kind == "person_name":
        return text.person_name(module.key, index, seed)
    if kind == "first_name":
        return _student_name_part(index, seed, True)
    if kind == "last_name":
        return _student_name_part(index, seed, False)
    if kind == "upn":
        return f"A{index + 1:012d}"
    if kind == "owner":
        return f"@user:{assignee_key(module.key, module.department, index, seed, organization)}"
    if kind == "optional_owner":
        if index % 3 == 0:
            return OMIT
        return f"@user:{assignee_key(module.key, module.department, index, seed, organization)}"
    if kind == "email":
        return text.email_value(module.key, index, seed, counts)
    if kind == "phone":
        return text.phone_value(index, seed)
    if kind == "notes" or kind.endswith("_note"):
        if field.key == "notes" and index % 9 == 0:
            return ""
        return text.note_text(module.key, field.key, index, seed)
    if kind == "boolean":
        if field.key in {
            "student_required",
            "fee_required",
            "guidance_required",
            "parent_contact_required",
            "collection_required",
            "attendance_required",
            "review_required",
        }:
            return False
        return bool((index * 5 + seed) % 3 == 0)
    if kind in {
        "date",
        "related_date",
        "submitted_date",
        "assessment_set_date",
        "assessment_due_date",
        "birth_date",
        "next_due_date",
        "report_release_date",
        "completed_date",
        "payment_date",
        "leave_start",
        "leave_end",
        "promised_date",
    }:
        if kind == "birth_date":
            return dates.birth_date(index, _year_group_index(index, seed), seed, anchor).isoformat()
        if module.key == "attendance_exceptions" and field.key == "activity_date":
            attendance_field = next(item for item in module.fields if item.key == "attendance_code")
            if _choice_label(attendance_field, index, seed, anchor).startswith("N —"):
                return anchor.fromordinal(anchor.toordinal() - 1 - index % 3).isoformat()
        past_due = (
            module.key == "fee_assessments"
            and field.key == "next_due_date"
            and _status_label(module, index, seed) == "Past due"
        )
        return dates.related_date(
            module.key, field.key, index, seed, anchor, counts, past_due=past_due
        ).isoformat()
    if kind in {"datetime", "related_datetime", "arrival_datetime"}:
        if kind == "arrival_datetime":
            code = _choice_label(
                next(f for f in module.fields if f.key == "attendance_code"), index, seed, anchor
            )
            if not code.startswith(("L —", "U —")):
                return OMIT
        return dates.related_datetime(module.key, field.key, index, seed, anchor, counts)
    if kind in {
        "attendance_note",
        "school_note",
        "incident_note",
        "health_note",
        "confidential_note",
        "maintenance_note",
    }:
        return text.note_text(module.key, field.key, index, seed)
    if kind == "course_code":
        return text.reference_code("courses", index, seed)
    if kind == "course_title":
        return (
            vocabulary.SUBJECTS[index % len(vocabulary.SUBJECTS)]
            + " — "
            + YEAR_GROUPS[_year_group_index(index, seed)]
        )
    if kind == "year_group_span":
        first = _year_group_index(index, seed)
        return f"{YEAR_GROUPS[first]}–{YEAR_GROUPS[min(13, first + 2)]}"
    if kind == "section_code":
        return text.reference_code("class_sections", index, seed)
    if kind == "homeroom":
        year_group = YEAR_GROUPS[_year_group_index(index, seed)]
        form = vocabulary.FORM_NAMES[index % len(vocabulary.FORM_NAMES)]
        return f"{year_group} {form}"
    if kind == "room_code":
        return text.reference_code("rooms", index, seed)
    if kind == "fee_code":
        return text.reference_code("fee_items", index, seed)
    if kind == "fee_item":
        return vocabulary.FEE_ITEMS[index % len(vocabulary.FEE_ITEMS)]
    if kind == "receipt_no":
        return text.reference_code("payments", index, seed)
    if kind == "attendance_code":
        return _choice_label(field, index, seed, anchor)
    if kind in {"gross_fees", "adjustments_total", "net_due", "balance"}:
        return _fee_assessment_value(kind, index, counts)
    if kind == "payment_amount":
        return _payment_amount(index, counts)
    if kind == "fee_item_amount":
        return 250 + (index * 375) % 4_500
    if kind == "adjustment_value":
        return 5 + (index * 3) % 25
    if kind == "adjustment_amount":
        return 150 + (index * 191) % 3_500
    if kind == "amount_overdue":
        assessment_index = 4 if index == 0 else index % counts["fee_assessments"]
        return _fee_assessment_value("balance", assessment_index, counts)
    if kind in {
        "small_integer",
        "absence_counter",
        "class_size",
        "capacity",
        "credits",
        "score",
        "mark",
        "maximum_mark",
        "weight_percent",
        "temperature",
        "leave_days",
    }:
        if kind == "absence_counter":
            return 5 if index == 4 else 1 + index % 4
        if kind == "class_size":
            return len(parent_indices("student_roster", index, counts))
        if kind == "capacity":
            minimum = int(field.minimum or 0)
            maximum = int(field.maximum) if field.maximum is not None else minimum + 180
            capacity = minimum + (index * 7 + seed) % (maximum - minimum + 1)
            if module.key == "class_sections":
                return max(capacity, len(parent_indices("student_roster", index, counts)))
            return capacity
        if kind == "credits":
            return 0.5 + (index % 8) * 0.5
        if kind in {"score", "mark"}:
            return 42 + (index * 17) % 59
        if kind == "maximum_mark":
            return 60 + index % 41
        if kind == "weight_percent":
            return 10 + index % 81
        if kind == "temperature":
            return round(36.4 + (index % 15) / 10, 1)
        if kind == "leave_days":
            return float(1 + index % 8)
        if kind == "small_integer":
            minimum = int(field.minimum or 0)
            maximum = int(field.maximum) if field.maximum is not None else minimum + 4
            return minimum + index % (maximum - minimum + 1)
    if kind == "reference_number":
        return text.serial_value(index, seed)
    if kind == "url":
        return text.url_value(module.key, index, seed)
    if field.type == "Number":
        return float(field.minimum or 0) + rng.random() * 10
    if field.type == "Integer":
        return int(field.minimum or 0)
    if field.type == "Checkbox":
        return False
    if field.type == "Text":
        return text.record_title(module.key, index, seed, counts)
    raise ValueError(f"Unsupported School field generator {module.key}.{field.key}")
