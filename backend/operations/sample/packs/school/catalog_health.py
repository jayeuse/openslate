"""School health module definitions."""

from __future__ import annotations

from operations.sample.packs.school.catalog_fields import _choice, _field, _module

MODULES = (
    _module(
        "clinic_visits",
        "Clinic Visit",
        "health",
        "CLN",
        "Visit date",
        ("Open", "Disposed", "Parent informed", "Closed"),
        290,
        (
            _field("student_reference", "Student number", "Text", "cross_reference", required=True),
            _field("time_in", "Time in", "Date/Time", "datetime", required=True),
            _choice(
                "complaint",
                "Complaint",
                (
                    "Headache",
                    "Fever",
                    "Stomach ache",
                    "Diarrhoea",
                    "Vomiting",
                    "Toothache",
                    "Menstrual cramps",
                    "Asthma symptoms",
                    "Allergic rash",
                    "Sprained ankle",
                    "Nosebleed",
                    "Minor cut",
                    "Dizziness",
                    "Eye irritation",
                    "Sore throat",
                ),
                required=True,
            ),
            _field("assessment_notes", "Assessment notes", "Long text", "health_note"),
            _field(
                "temperature_c", "Temperature °C", "Number", "temperature", minimum=35, maximum=42
            ),
            _choice(
                "intervention",
                "Intervention",
                (
                    "Rest",
                    "First aid",
                    "Ice pack",
                    "Medication recorded",
                    "Parent called",
                    "Observation",
                ),
            ),
            _field("medication_given", "Medication recorded", "Text", "health_note"),
            _choice(
                "disposition",
                "Disposition",
                ("Returned to class", "Sent home", "Referred to clinician", "Emergency services"),
                required=True,
            ),
            _field(
                "injury_on_site",
                "Injury on site",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _field(
                "hazard_involved",
                "Hazard involved",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _field(
                "attendance_required",
                "Attendance follow-up needed",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _field("nurse", "School nurse", "User", "owner", required=True),
        ),
    ),
    _module(
        "health_alerts",
        "Health Alert",
        "health",
        "HAL",
        "Review date",
        ("Pending documents", "Active", "Expired", "Archived"),
        100,
        (
            _field("student_reference", "Student number", "Text", "cross_reference", required=True),
            _choice(
                "condition",
                "Condition",
                (
                    "Severe allergy",
                    "Asthma",
                    "Type 1 diabetes",
                    "Seizure disorder",
                    "Cardiac condition",
                    "Medication held by school",
                    "Other",
                ),
                required=True,
            ),
            _choice(
                "severity", "Severity", ("Life-threatening", "Moderate", "Monitor"), required=True
            ),
            _field(
                "staff_instruction",
                "Staff-facing instruction",
                "Text",
                "health_note",
                required=True,
            ),
            _field(
                "care_plan_on_file",
                "Care plan on file",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _field("review_date", "Review date", "Date", "date"),
        ),
    ),
)
