"""School departments, Sandbox modules, relationships, and size profiles."""

from __future__ import annotations

from operations.sample.packs.school.catalog_academic import MODULES as _ACADEMIC
from operations.sample.packs.school.catalog_admissions import MODULES as _ADMISSIONS
from operations.sample.packs.school.catalog_facilities import MODULES as _FACILITIES
from operations.sample.packs.school.catalog_fields import TERMS, YEAR_GROUPS
from operations.sample.packs.school.catalog_finance import MODULES as _FINANCE
from operations.sample.packs.school.catalog_health import MODULES as _HEALTH
from operations.sample.packs.school.catalog_hr import MODULES as _HR
from operations.sample.packs.school.catalog_student_affairs import MODULES as _STUDENT_AFFAIRS
from operations.sample.packs.types import RelationshipSpec, SampleProfile

__all__ = ["TERMS", "YEAR_GROUPS"]

_DEPARTMENTS = (
    ("admissions", "Admissions"),
    ("academic", "Academic Office"),
    ("student_affairs", "Student Affairs"),
    ("health", "Health Services"),
    ("finance", "Finance"),
    ("facilities", "Facilities & Operations"),
    ("hr", "Human Resources"),
)


_MODULES = (
    *_ADMISSIONS,
    *_ACADEMIC,
    *_STUDENT_AFFAIRS,
    *_HEALTH,
    *_FINANCE,
    *_FACILITIES,
    *_HR,
)

_RELATIONSHIPS = (
    RelationshipSpec(
        "inquiry_applications", "Applications", "admission_inquiries", "applications", "one-to-many"
    ),
    RelationshipSpec(
        "student_roster", "Class roster", "students", "class_sections", "many-to-many"
    ),
    RelationshipSpec(
        "course_sections", "Class sections", "courses", "class_sections", "one-to-many"
    ),
    RelationshipSpec(
        "section_assessments", "Assessments", "class_sections", "assessments", "one-to-many"
    ),
    RelationshipSpec(
        "section_report_cards",
        "Report card batch",
        "class_sections",
        "report_card_batches",
        "one-to-one",
    ),
    RelationshipSpec(
        "section_academic_alerts",
        "Academic alerts",
        "class_sections",
        "academic_alerts",
        "one-to-many",
    ),
    RelationshipSpec(
        "section_grade_changes",
        "Grade changes",
        "class_sections",
        "grade_change_requests",
        "one-to-many",
    ),
    RelationshipSpec(
        "student_attendance",
        "Attendance exceptions",
        "students",
        "attendance_exceptions",
        "one-to-many",
    ),
    RelationshipSpec(
        "student_academic_alerts", "Academic alerts", "students", "academic_alerts", "one-to-many"
    ),
    RelationshipSpec(
        "student_grade_changes", "Grade changes", "students", "grade_change_requests", "one-to-many"
    ),
    RelationshipSpec(
        "behaviour_guidance",
        "Guidance cases",
        "behaviour_incidents",
        "guidance_cases",
        "one-to-many",
    ),
    RelationshipSpec("fee_payments", "Payments", "fee_assessments", "payments", "one-to-many"),
    RelationshipSpec(
        "assessment_adjustments", "Adjustments", "fee_assessments", "fee_adjustments", "one-to-many"
    ),
    RelationshipSpec(
        "fee_collections", "Collection cases", "fee_assessments", "collection_cases", "one-to-many"
    ),
    RelationshipSpec(
        "room_maintenance", "Maintenance requests", "rooms", "maintenance_requests", "one-to-many"
    ),
    # Links to records in another department. The referencing record is the source and is
    # created after the record it names, so it is the child end.
    RelationshipSpec(
        "attendance_clinic_visit",
        "Clinic visit",
        "attendance_exceptions",
        "clinic_visits",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "student_application",
        "Application",
        "students",
        "applications",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "section_room", "Room", "class_sections", "rooms", "many-to-many", child="source"
    ),
    RelationshipSpec("activity_room", "Room", "activities", "rooms", "one-to-one", child="source"),
    RelationshipSpec(
        "behaviour_student",
        "Student",
        "behaviour_incidents",
        "students",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "guidance_student", "Student", "guidance_cases", "students", "many-to-many", child="source"
    ),
    RelationshipSpec(
        "guidance_attendance",
        "Attendance",
        "guidance_cases",
        "attendance_exceptions",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "parent_contact_student",
        "Student",
        "parent_contacts",
        "students",
        "many-to-many",
        child="source",
    ),
    RelationshipSpec(
        "parent_contact_attendance",
        "Attendance",
        "parent_contacts",
        "attendance_exceptions",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "parent_contact_academic_alert",
        "Academic alert",
        "parent_contacts",
        "academic_alerts",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "clinic_visit_student",
        "Student",
        "clinic_visits",
        "students",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "health_alert_student",
        "Student",
        "health_alerts",
        "students",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "fee_assessment_student",
        "Student",
        "fee_assessments",
        "students",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "fee_adjustment_student",
        "Student",
        "fee_adjustments",
        "students",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "collection_student",
        "Student",
        "collection_cases",
        "students",
        "many-to-many",
        child="source",
    ),
)

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, (count + 4) // 5) for key, count in _STANDARD_COUNTS.items()},
    "standard": dict(_STANDARD_COUNTS),
    "large": {key: count * 4 for key, count in _STANDARD_COUNTS.items()},
}
SPECIAL_STATUSES: dict[str, dict[int, str]] = {}
