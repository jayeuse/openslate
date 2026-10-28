"""Patient Access modules: registration, coverage, payers and scheduling."""

from __future__ import annotations

from operations.sample.packs.clinic.catalog_fields import (
    PAYER_CLASSES,
    VISIT_TYPES,
    _check,
    _choice,
    _field,
    _module,
    _optional_choice,
)

MODULES = (
    _module(
        "patients",
        "Patient",
        "patient_access",
        "MRN",
        "Last contact",
        ("Active", "Inactive", "Merged", "Entered in error"),
        462,
        (
            _field("mrn", "MRN", "Text", "mrn", required=True),
            _field("given_name", "Given name", "Text", "given_name", required=True),
            _field("family_name", "Family name", "Text", "family_name", required=True),
            _field("birth_date", "Date of birth", "Date", "birth_date", required=True),
            _choice("sex", "Sex", ("Female", "Male", "Other", "Unknown"), required=True,
                    value_kind="sex"),  # fmt: skip
            _field("last_contact", "Last contact", "Date", "last_contact"),
            _field("mobile", "Mobile", "Text", "phone"),
            _field("email", "Email", "Email", "email"),
            _field("city", "City", "Text", "city"),
            _choice("payer_class", "Payer class", PAYER_CLASSES, required=True,
                    value_kind="payer_class"),  # fmt: skip
            _check("sms_consent", "SMS reminders"),
        ),
    ),
    _module(
        "coverages",
        "Coverage",
        "patient_access",
        "COV",
        "Valid from",
        ("Active", "Draft", "Cancelled", "Entered in error"),
        360,
        (
            _field("member_id", "Member ID", "Text", "member_id", required=True),
            _field("valid_from", "Valid from", "Date", "valid_from", required=True),
            _field("valid_to", "Valid to", "Date", "valid_to"),
            _field("plan_name", "Plan", "Text", "plan_name"),
            _choice("relationship", "Relationship to subscriber",
                    ("Self", "Spouse", "Child", "Other")),  # fmt: skip
            _field("copay", "Copay $", "Number", "copay_amount", minimum=0),
            _choice("eligibility", "Eligibility",
                    ("Eligible", "Not checked", "Not eligible", "Needs prior authorization"),
                    value_kind="eligibility"),  # fmt: skip
        ),
    ),
    _module(
        "payers",
        "Payer",
        "patient_access",
        "PAY",
        "Contract start",
        ("Active", "Inactive"),
        12,
        (
            _choice("payer_type", "Payer type",
                    ("Commercial insurer", "HMO", "Medicare", "Medicaid managed care",
                     "Employer account"), required=True, value_kind="payer_type"),  # fmt: skip
            _field("payer_id", "Payer ID", "Text", "payer_id"),
            _field("contract_start", "Contract start", "Date", "contract_start"),
            _field("claims_portal", "Claims portal", "URL", "url"),
            _field("filing_limit_days", "Filing limit (days)", "Integer", "filing_limit",
                   minimum=30, maximum=730),  # fmt: skip
        ),
    ),
    _module(
        "appointments",
        "Appointment",
        "patient_access",
        "APT",
        "Visit date",
        ("Booked", "Arrived", "Checked in", "Fulfilled", "Cancelled", "No-show", "Waitlist",
         "Entered in error"),  # fmt: skip
        620,
        (
            _field("appointment_no", "Appointment number", "Text", "reference", required=True),
            _field("visit_date", "Visit date", "Date", "visit_date", required=True),
            _field("starts_at", "Start", "Date/Time", "visit_start", required=True),
            _field("duration_min", "Duration (min)", "Integer", "duration", minimum=5,
                   maximum=120),  # fmt: skip
            _choice("visit_type", "Visit type", VISIT_TYPES, required=True,
                    value_kind="visit_type"),  # fmt: skip
            _field("provider", "Provider", "User", "provider", required=True),
            _choice("booked_via", "Booked via", ("Phone", "Patient portal", "Walk-in", "Staff")),
            _choice("reminder", "Reminder",
                    ("Confirmed", "Not sent", "No answer", "Callback requested"),
                    value_kind="reminder"),  # fmt: skip
            _optional_choice("cancel_reason", "Cancel reason",
                             ("Patient request", "Cancelled under 24 hours",
                              "Provider unavailable", "Left without being seen",
                              "Duplicate booking"), "cancel_reason"),  # fmt: skip
        ),
    ),
)
