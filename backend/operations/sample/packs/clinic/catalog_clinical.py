"""Clinical Services and Laboratory modules: visits, orders, prescriptions and results."""

from __future__ import annotations

from operations.sample.packs.clinic.catalog_fields import (
    DISPOSITIONS,
    EM_CODES,
    ORDER_CATEGORIES,
    PAYER_CLASSES,
    PERFORMERS,
    PRIORITIES,
    QC_RULES,
    REJECTION_REASONS,
    RESULT_FLAGS,
    SPECIMEN_TYPES,
    VISIT_TYPES,
    _check,
    _choice,
    _field,
    _flag,
    _module,
    _optional_choice,
)

CLINICAL = (
    _module(
        "encounters",
        "Encounter",
        "clinical",
        "ENC",
        "Visit date",
        ("Planned", "Arrived", "Triaged", "In progress", "Finished", "Cancelled",
         "Entered in error"),  # fmt: skip
        536,
        (
            _field("encounter_no", "Encounter number", "Text", "reference", required=True),
            _field("visit_date", "Visit date", "Date", "visit_date", required=True),
            _field("started_at", "Started", "Date/Time", "visit_start", required=True),
            _choice("billing_class", "Billing class", PAYER_CLASSES, required=True,
                    value_kind="billing_class"),  # fmt: skip
            _choice("visit_type", "Visit type", VISIT_TYPES, value_kind="visit_type"),
            _field("chief_complaint", "Chief complaint", "Text", "chief_complaint",
                   required=True),  # fmt: skip
            _field("diagnosis", "Primary diagnosis (ICD-10)", "Text", "diagnosis"),
            _choice("em_code", "Visit level (E/M)", EM_CODES, value_kind="em_code"),
            _field("bp_systolic", "BP systolic", "Integer", "bp_systolic", minimum=60,
                   maximum=240),  # fmt: skip
            _field("bp_diastolic", "BP diastolic", "Integer", "bp_diastolic", minimum=30,
                   maximum=140),  # fmt: skip
            _field("temperature_f", "Temperature °F", "Number", "temperature", minimum=93,
                   maximum=107, step=0.1),  # fmt: skip
            _choice("disposition", "Disposition", DISPOSITIONS, value_kind="disposition"),
            _field("provider", "Provider", "User", "provider", required=True),
            _flag("claim_required", "Ready to claim"),
        ),
    ),
    _module(
        "orders",
        "Order",
        "clinical",
        "ORD",
        "Ordered on",
        ("Draft", "Active", "Completed", "On hold", "Revoked", "Entered in error"),
        295,
        (
            _field("order_no", "Order number", "Text", "reference", required=True),
            _field("ordered_on", "Ordered on", "Date", "child_date", required=True),
            _choice("category", "Category", ORDER_CATEGORIES, required=True,
                    value_kind="order_category"),  # fmt: skip
            _field("service", "Ordered service", "Text", "order_service", required=True),
            _choice("priority", "Priority", PRIORITIES, required=True, value_kind="priority"),
            _field("reason", "Reason (ICD-10)", "Text", "diagnosis"),
            _check("fasting", "Fasting required"),
            _choice("performer", "Performed by", PERFORMERS, value_kind="performer"),
            _field("requester", "Requester", "User", "provider", required=True),
        ),
    ),
    _module(
        "prescriptions",
        "Prescription",
        "clinical",
        "RX",
        "Prescribed on",
        ("Draft", "Active", "Completed", "On hold", "Cancelled", "Stopped", "Entered in error"),
        482,
        (
            _field("rx_no", "Prescription number", "Text", "reference", required=True),
            _field("prescribed_on", "Prescribed on", "Date", "child_date", required=True),
            _field("medication", "Medication", "Text", "medication", required=True),
            _field("quantity", "Quantity", "Integer", "rx_quantity", required=True, minimum=1,
                   maximum=360),  # fmt: skip
            _field("refills", "Refills", "Integer", "refills", minimum=0, maximum=11),
            _choice("fill_at", "Fill at", ("In-house dispensary", "Outside pharmacy"),
                    value_kind="fill_at"),  # fmt: skip
            _field("prescriber", "Prescriber", "User", "provider", required=True),
        ),
    ),
)

LABORATORY = (
    _module(
        "specimens",
        "Specimen",
        "laboratory",
        "ACC",
        "Collected on",
        ("Awaiting collection", "Collected", "Received", "Available", "Unsatisfactory",
         "Unavailable", "Entered in error"),  # fmt: skip
        200,
        (
            _field("accession_no", "Accession number", "Text", "reference", required=True),
            _field("collected_on", "Collected on", "Date", "child_date", required=True),
            _field("collected_at", "Collected at", "Date/Time", "child_time"),
            _choice("specimen_type", "Specimen type", SPECIMEN_TYPES, required=True,
                    value_kind="specimen_type"),  # fmt: skip
            _field("collector", "Collected by", "User", "owner"),
            _check("fasting", "Fasting"),
            _optional_choice("rejection_reason", "Rejection reason", REJECTION_REASONS,
                             "rejection_reason"),  # fmt: skip
        ),
    ),
    _module(
        "lab_results",
        "Lab Result",
        "laboratory",
        "RPT",
        "Resulted on",
        ("Registered", "Preliminary", "Final", "Amended", "Corrected", "Cancelled",
         "Entered in error"),  # fmt: skip
        247,
        (
            _field("report_no", "Report number", "Text", "reference", required=True),
            _field("resulted_on", "Resulted on", "Date", "child_date", required=True),
            _field("analyte", "Analyte", "Text", "analyte", required=True),
            _field("result_value", "Result", "Text", "result_value", required=True),
            _field("units", "Units", "Text", "units"),
            _field("reference_range", "Reference range", "Text", "reference_range"),
            _choice("flag", "Flag", RESULT_FLAGS, value_kind="result_flag"),
            _field("performed_by", "Performed by", "User", "owner", required=True),
            _field("validated_by", "Validated by", "User", "validator"),
            _flag("callback_required", "Call-back needed"),
        ),
    ),
    _module(
        "lab_qc_runs",
        "Lab QC Run",
        "laboratory",
        "QC",
        "Run date",
        ("Pending", "Passed", "Failed", "Repeated and passed"),
        192,
        (
            _field("run_date", "Run date", "Date", "daily_date", required=True),
            _choice("level", "Control level", ("Level 1", "Level 2", "Level 3"),
                    value_kind="qc_level"),  # fmt: skip
            _field("analyte", "Analyte", "Text", "qc_analyte"),
            _choice("rule_violated", "Westgard rule", QC_RULES, value_kind="qc_rule"),
            _field("corrective_action", "Corrective action", "Long text", "qc_note"),
            _field("performed_by", "Performed by", "User", "owner", required=True),
        ),
    ),
)
