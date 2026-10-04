"""Eight supported School flag rules, with the weekly schedule disabled."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.blueprint import _option_id
from operations.sample.catalog import _doc_id
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import JsonValue

RECORD_CREATED_KEYS = (
    "attendance-unexplained-parent-contact",
    "clinic-sent-home-attendance",
    "academic-alert-parent-contact",
)
PATCH_KEYS = (
    "application-enrolled-student-required",
    "attendance-five-day-guidance-required",
    "fee-assessment-past-due-collection-required",
    "student-enrolled-fee-required",
)
SCHEDULE_KEYS = ("weekly-maintenance-review",)
TRIGGER_KEYS = (*RECORD_CREATED_KEYS, *PATCH_KEYS, *SCHEDULE_KEYS)


def _ref(
    module_key: str,
    fields: Mapping[str, Mapping[str, str]],
    field_key: str,
    module_ids: Mapping[str, str],
) -> dict[str, str]:
    return {"moduleId": module_ids[module_key], "fieldId": fields[module_key][field_key]}


def _condition(
    seed: int,
    organization: OrganizationPack,
    module_key: str,
    field_key: str,
    operator: str,
    value: JsonValue,
    fields: Mapping[str, Mapping[str, str]],
    module_ids: Mapping[str, str],
) -> dict[str, object]:
    return {
        "id": _doc_id(
            seed, "condition", f"{module_key}:{field_key}:{operator}:{value}", organization
        ),
        "field": _ref(module_key, fields, field_key, module_ids),
        "operator": operator,
        "value": {"kind": "literal", "value": value},
    }


def _rule(
    seed: int,
    organization: OrganizationPack,
    key: str,
    name: str,
    module_key: str,
    event: dict[str, object],
    conditions: list[dict[str, object]],
    target: str,
    fields: Mapping[str, Mapping[str, str]],
    module_ids: Mapping[str, str],
    *,
    enabled: bool = True,
) -> dict[str, object]:
    return {
        "id": _doc_id(seed, "trigger", key, organization),
        "name": name,
        "enabled": enabled,
        "priority": len(key),
        "trigger": event,
        "conditionGroup": {"operator": "all", "conditions": conditions},
        "actions": [
            {
                "id": _doc_id(seed, "action", key, organization),
                "kind": "set-field",
                "target": _ref(module_key, fields, target, module_ids),
                "value": {"kind": "literal", "value": True},
            }
        ],
    }


def build_triggers(
    organization: OrganizationPack,
    seed: int,
    module_ids: Mapping[str, str],
    field_ids: Mapping[str, Mapping[str, str]],
) -> list[dict[str, object]]:
    def status(module: str, value: str) -> str:
        return _option_id(seed, module, "status", value, organization)

    def choice(module: str, field: str, value: str) -> str:
        return _option_id(seed, module, field, value, organization)

    def event(kind: str, module: str, **values: object) -> dict[str, object]:
        return {"kind": kind, "moduleId": module_ids[module], **values}

    application = "applications"
    student = "students"
    attendance = "attendance_exceptions"
    clinic = "clinic_visits"
    alert = "academic_alerts"
    assessment = "fee_assessments"
    maintenance = "maintenance_requests"

    return [
        _rule(
            seed,
            organization,
            RECORD_CREATED_KEYS[0],
            "Prepare an attendance contact",
            attendance,
            event("record-created", attendance),
            [
                _condition(
                    seed,
                    organization,
                    attendance,
                    "attendance_code",
                    "=",
                    choice(attendance, "attendance_code", "N — Reason not yet established"),
                    field_ids,
                    module_ids,
                )
            ],
            "parent_contact_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            RECORD_CREATED_KEYS[1],
            "Prepare a sent-home attendance record",
            clinic,
            event("record-created", clinic),
            [
                _condition(
                    seed,
                    organization,
                    clinic,
                    "disposition",
                    "=",
                    choice(clinic, "disposition", "Sent home"),
                    field_ids,
                    module_ids,
                )
            ],
            "attendance_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            RECORD_CREATED_KEYS[2],
            "Prepare an academic alert contact",
            alert,
            event("record-created", alert),
            [],
            "parent_contact_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            PATCH_KEYS[0],
            "Prepare an enrolled pupil record",
            application,
            event(
                "field-changed",
                application,
                fieldId=field_ids[application]["status"],
            ),
            [
                _condition(
                    seed,
                    organization,
                    application,
                    "status",
                    "=",
                    status(application, "Enrolled"),
                    field_ids,
                    module_ids,
                )
            ],
            "student_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            PATCH_KEYS[1],
            "Flag five-day attendance follow-up",
            attendance,
            event(
                "threshold-crossed",
                attendance,
                fieldId=field_ids[attendance]["consecutive_days_absent"],
                operator=">=",
                value={"kind": "literal", "value": 5},
            ),
            [
                _condition(
                    seed,
                    organization,
                    attendance,
                    "consecutive_days_absent",
                    ">=",
                    5,
                    field_ids,
                    module_ids,
                )
            ],
            "guidance_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            PATCH_KEYS[2],
            "Prepare a past-due fee follow-up",
            assessment,
            event(
                "field-changed",
                assessment,
                fieldId=field_ids[assessment]["status"],
            ),
            [
                _condition(
                    seed,
                    organization,
                    assessment,
                    "status",
                    "=",
                    status(assessment, "Past due"),
                    field_ids,
                    module_ids,
                )
            ],
            "collection_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            PATCH_KEYS[3],
            "Prepare an enrolled pupil fee assessment",
            student,
            event("field-changed", student, fieldId=field_ids[student]["status"]),
            [
                _condition(
                    seed,
                    organization,
                    student,
                    "status",
                    "=",
                    status(student, "Enrolled"),
                    field_ids,
                    module_ids,
                )
            ],
            "fee_required",
            field_ids,
            module_ids,
        ),
        _rule(
            seed,
            organization,
            SCHEDULE_KEYS[0],
            "Review preventive maintenance weekly",
            maintenance,
            event("schedule", maintenance, frequency="weekly", time="06:30", weekday=1),
            [
                _condition(
                    seed,
                    organization,
                    maintenance,
                    "category",
                    "=",
                    choice(maintenance, "category", "Preventive"),
                    field_ids,
                    module_ids,
                )
            ],
            "review_required",
            field_ids,
            module_ids,
            enabled=False,
        ),
    ]
