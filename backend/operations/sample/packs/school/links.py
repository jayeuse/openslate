"""School links within a department and visible codes across departments."""

from __future__ import annotations

from collections.abc import Mapping

REFERENCE_FIELDS = (
    ("attendance_exceptions", "student_reference"),
    ("attendance_exceptions", "clinic_reference"),
    ("students", "application_reference"),
    ("class_sections", "room_reference"),
    ("academic_alerts", "student_reference"),
    ("grade_change_requests", "student_reference"),
    ("behaviour_incidents", "student_reference"),
    ("guidance_cases", "student_reference"),
    ("guidance_cases", "attendance_reference"),
    ("parent_contacts", "student_reference"),
    ("parent_contacts", "attendance_reference"),
    ("parent_contacts", "academic_alert_reference"),
    ("clinic_visits", "student_reference"),
    ("health_alerts", "student_reference"),
    ("fee_assessments", "student_reference"),
    ("payments", "fee_assessment_reference"),
    ("fee_adjustments", "student_reference"),
    ("collection_cases", "student_reference"),
    ("activities", "room_reference"),
)

_SOURCE_MODULES = {
    "inquiry_applications": "admission_inquiries",
    "course_sections": "courses",
    "section_assessments": "class_sections",
    "section_academic_alerts": "class_sections",
    "section_grade_changes": "class_sections",
    "student_attendance": "students",
    "student_academic_alerts": "students",
    "student_grade_changes": "students",
    "behaviour_guidance": "behaviour_incidents",
    "fee_payments": "fee_assessments",
    "assessment_adjustments": "fee_assessments",
    "fee_collections": "fee_assessments",
    "room_maintenance": "rooms",
}


def parent_indices(
    key: str,
    target: int,
    counts: Mapping[str, int],
) -> tuple[int, ...]:
    """Find source indexes for one target record, respecting link cardinality."""
    if key == "student_roster":
        sections = counts["class_sections"]
        students = counts["students"]
        edges = students * 7
        start = target * edges // sections
        stop = (target + 1) * edges // sections
        return tuple(index % students for index in range(start, stop))
    if key == "section_report_cards":
        return (min(target, counts["class_sections"] - 1),)
    if key in {"section_academic_alerts", "section_grade_changes"}:
        # Invert the roster's range allocation for this pupil's selected membership.
        pupil = target % counts["students"]
        position = pupil + (target % 7) * counts["students"]
        section = ((position + 1) * counts["class_sections"] - 1) // (counts["students"] * 7)
        return (section,)
    if key == "student_attendance" and target == 5:
        return (0,)
    if key == "behaviour_guidance" and target == 0:
        return (4 % counts["behaviour_incidents"],)
    if key == "fee_collections" and target == 0:
        return (4 % counts["fee_assessments"],)
    if key == "fee_payments":
        assessment_index = (
            0
            if target == 0
            else target
            if target < counts["fee_assessments"]
            else (target - counts["fee_assessments"] + 1)
        )
        return (assessment_index % counts["fee_assessments"],)
    source = _SOURCE_MODULES.get(key)
    if source is None:
        raise ValueError("Unknown School relationship")
    return (target % counts[source],)


def reference_parents(
    module_key: str,
    field_key: str,
    index: int,
    counts: Mapping[str, int],
) -> tuple[tuple[str, int], ...]:
    """Return cross-department records named by a field's visible code."""
    if module_key == "attendance_exceptions" and field_key == "student_reference" and index == 5:
        return (("students", 0),)
    if module_key == "parent_contacts" and field_key == "student_reference" and index in {0, 1}:
        return (("students", 0),)
    if module_key == "guidance_cases" and field_key == "student_reference" and index == 0:
        return (("students", 4 % counts["students"]),)
    if (module_key, field_key) == ("collection_cases", "student_reference") and index == 0:
        return (("students", 4 % counts["students"]),)
    if field_key == "student_reference" and module_key != "students":
        return (("students", index % counts["students"]),)
    if (module_key, field_key) == ("students", "application_reference"):
        return (("applications", 4),) if index == 0 else ()
    if (module_key, field_key) == ("guidance_cases", "attendance_reference"):
        return (("attendance_exceptions", 4),) if index == 0 else ()
    if (module_key, field_key) == ("attendance_exceptions", "clinic_reference"):
        return (("clinic_visits", 0),) if index == 5 else ()
    if (module_key, field_key) == ("parent_contacts", "attendance_reference"):
        return (("attendance_exceptions", 0),) if index == 0 else ()
    if (module_key, field_key) == ("parent_contacts", "academic_alert_reference"):
        return (("academic_alerts", 0),) if index == 1 else ()
    if (module_key, field_key) == ("class_sections", "room_reference"):
        return (("rooms", index % counts["rooms"]),)
    if (module_key, field_key) == ("activities", "room_reference"):
        return (("rooms", (index * 3) % counts["rooms"]),)
    if (module_key, field_key) == ("payments", "fee_assessment_reference"):
        return (("fee_assessments", parent_indices("fee_payments", index, counts)[0]),)
    if (module_key, field_key) in REFERENCE_FIELDS:
        return ()
    raise ValueError("Unknown School reference field")
