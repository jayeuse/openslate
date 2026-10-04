"""School relationship rules and the visible codes kept inside a department."""

from __future__ import annotations

from collections.abc import Mapping

# Typed codes that repeat a link the department already has as a relationship.
REFERENCE_FIELDS = (
    ("attendance_exceptions", "student_reference"),
    ("academic_alerts", "student_reference"),
    ("grade_change_requests", "student_reference"),
    ("payments", "fee_assessment_reference"),
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
    """Find the parent indexes one child record links to, respecting link cardinality.

    The child is the target, except for links to another department, where the child is
    the referencing source record.
    """
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
    if key in _STUDENT_LINKS:
        return (student_index(_STUDENT_LINKS[key], target, counts),)
    if key in _SINGLE_LINKS:
        child, parent = _SINGLE_LINKS[key]
        return (parent,) if target == child else ()
    if key == "section_room":
        return (target % counts["rooms"],)
    if key == "activity_room":
        return ((target * 3) % counts["rooms"],)
    source = _SOURCE_MODULES.get(key)
    if source is None:
        raise ValueError("Unknown School relationship")
    return (target % counts[source],)


# Links from another department's record to the student it is about: key -> source module.
_STUDENT_LINKS = {
    "behaviour_student": "behaviour_incidents",
    "guidance_student": "guidance_cases",
    "parent_contact_student": "parent_contacts",
    "clinic_visit_student": "clinic_visits",
    "health_alert_student": "health_alerts",
    "fee_assessment_student": "fee_assessments",
    "fee_adjustment_student": "fee_adjustments",
    "collection_student": "collection_cases",
}
# Links that only one named record has: key -> (source index, target index).
_SINGLE_LINKS = {
    "attendance_clinic_visit": (5, 0),
    "student_application": (0, 4),
    "guidance_attendance": (0, 4),
    "parent_contact_attendance": (0, 0),
    "parent_contact_academic_alert": (1, 0),
}


def student_index(module_key: str, index: int, counts: Mapping[str, int]) -> int:
    """The student a pupil record is about, shared by its title, link and visible code."""
    if module_key == "attendance_exceptions" and index == 5:
        return 0
    if module_key == "parent_contacts" and index in {0, 1}:
        return 0
    if module_key in {"guidance_cases", "collection_cases"} and index == 0:
        return 4 % counts["students"]
    return index % counts["students"]


def reference_parents(
    module_key: str,
    field_key: str,
    index: int,
    counts: Mapping[str, int],
) -> tuple[tuple[str, int], ...]:
    """Return the records in the same department that a field's visible code names."""
    if (module_key, field_key) == ("payments", "fee_assessment_reference"):
        return (("fee_assessments", parent_indices("fee_payments", index, counts)[0]),)
    if (module_key, field_key) in REFERENCE_FIELDS:
        return (("students", student_index(module_key, index, counts)),)
    raise ValueError("Unknown School reference field")
