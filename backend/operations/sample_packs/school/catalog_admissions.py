"""School admissions module definitions."""

from __future__ import annotations

from operations.sample_packs.school.catalog_fields import (
    SCHOOL_YEARS,
    YEAR_GROUPS,
    _choice,
    _field,
    _module,
)

MODULES = (
    _module(
        "admission_inquiries",
        "Admission Inquiry",
        "admissions",
        "INQ",
        "Inquiry date",
        ("New", "Contacted", "Toured", "Applied", "Not interested", "No response"),
        220,
        (
            _field("inquiry_no", "Inquiry number", "Text", "reference", required=True),
            _field("child_name", "Child name", "Text", "person_name", required=True),
            _choice("entry_grade", "Entry year group", YEAR_GROUPS, required=True),
            _choice("entry_year", "Entry school year", SCHOOL_YEARS, required=True),
            _field("parent_email", "Parent email", "Email", "email", required=True),
            _field("inquiry_date", "Inquiry date", "Date", "date", required=True),
            _choice(
                "source",
                "Source",
                ("Website", "Referral", "Open day", "Walk-in", "Sibling", "Fair"),
            ),
        ),
    ),
    _module(
        "applications",
        "Application",
        "admissions",
        "APP",
        "Submitted on",
        (
            "Started",
            "Submitted",
            "Complete",
            "Testing and interview",
            "Decision released",
            "Enrolment in process",
            "Enrolled",
            "Withdrawn",
            "Declined offer",
        ),
        80,
        (
            _field("application_no", "Application number", "Text", "reference", required=True),
            _field("applicant_name", "Applicant name", "Text", "person_name", required=True),
            _field(
                "student_required",
                "Student record needed",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _choice("entry_grade", "Entry year group", YEAR_GROUPS, required=True),
            _choice("entry_year", "Entry school year", SCHOOL_YEARS, required=True),
            _field("parent_email", "Parent email", "Email", "email", required=True),
            _field("submitted_on", "Submitted", "Date", "submitted_date", required=True),
            _field("entrance_test_on", "Entrance assessment", "Date", "related_date"),
            _field(
                "entrance_score",
                "Entrance assessment score",
                "Number",
                "score",
                minimum=0,
                maximum=100,
            ),
            _field("interview_at", "Interview", "Date/Time", "related_datetime"),
            _field(
                "documents_complete",
                "Documents complete",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _choice("decision", "Decision", ("Accepted", "Waitlisted", "Declined", "Deferred")),
        ),
    ),
)
