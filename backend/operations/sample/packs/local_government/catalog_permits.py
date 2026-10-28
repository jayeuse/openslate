"""Business Permits and Licensing, and Building Official modules (research §4)."""

from __future__ import annotations

from operations.sample.packs.local_government.catalog_fields import (
    APPLICATION_TYPES,
    BARANGAYS,
    BUILDING_INSPECTION_TYPES,
    BUSINESS_INSPECTION_TYPES,
    COMPLEXITY,
    LINES_OF_BUSINESS,
    NOTICE_TYPES,
    ORG_TYPES,
    SCOPES,
    SLA_FLAGS,
    VIOLATIONS,
    _check,
    _choice,
    _field,
    _flag,
    _module,
    _peso,
)

BUSINESS = (
    _module(
        "business_establishments",
        "Business Establishment",
        "bplo",
        "BIN",
        "Last renewed",
        ("Active", "Delinquent", "Under notice", "Closed by order", "Retired"),
        300,
        (
            _field("bin", "Business ID number", "Text", "reference", required=True),
            _field("last_renewed", "Last renewed", "Date", "last_renewed"),
            _field("trade_name", "Trade name", "Text", "trade_name"),
            _field("taxpayer", "Owner or taxpayer", "Text", "taxpayer", required=True),
            _choice(
                "org_type", "Organization type", ORG_TYPES, required=True, value_kind="org_type"
            ),  # fmt: skip
            _choice(
                "line_of_business",
                "Line of business",
                LINES_OF_BUSINESS,
                required=True,
                value_kind="line_of_business",
            ),  # fmt: skip
            _choice("barangay", "Barangay", BARANGAYS, required=True, value_kind="barangay"),
            _field("address", "Address", "Text", "street_address", required=True),
            _field("employees", "Employees", "Integer", "employees", minimum=0, maximum=2_000),
            _field(
                "year_started",
                "Year started",
                "Integer",
                "year_started",
                minimum=1950,
                maximum=2030,
            ),  # fmt: skip
            _field("email", "Email", "Email", "email"),
            _field("mobile", "Mobile", "Text", "phone"),
        ),
    ),
    _module(
        "permit_applications",
        "Business Permit Application",
        "bplo",
        "BP",
        "Filed on",
        (
            "Filed",
            "Verified",
            "Assessed",
            "Paid",
            "Approved",
            "Released",
            "Returned for compliance",
            "Disapproved",
            "Withdrawn",
        ),  # fmt: skip
        360,
        (
            _field("application_no", "Application number", "Text", "reference", required=True),
            _field("filed_on", "Filed on", "Date", "filed_on", required=True),
            _choice(
                "application_type",
                "Type",
                APPLICATION_TYPES,
                required=True,
                value_kind="application_type",
            ),  # fmt: skip
            _field(
                "tax_year",
                "Tax year",
                "Integer",
                "tax_year",
                required=True,
                minimum=2024,
                maximum=2030,
            ),  # fmt: skip
            _field(
                "declared_gross",
                "Declared gross sales or capital ₱",
                "Number",
                "declared_gross",
                required=True,
                minimum=0,
                step=0.01,
            ),  # fmt: skip
            _field(
                "days_pending", "Days pending", "Integer", "days_pending", minimum=0, maximum=90
            ),  # fmt: skip
            _choice("sla_flag", "Service time", SLA_FLAGS, value_kind="sla_flag"),
            _field("evaluator", "Evaluator", "User", "evaluator"),
            _field("permit_no", "Permit number", "Text", "permit_no"),
            _field("released_on", "Released on", "Date", "released_on"),
            _flag("oop_required", "Order of payment needed"),
        ),
    ),
    _module(
        "business_inspections",
        "Business Inspection",
        "bplo",
        "JIT",
        "Inspected on",
        (
            "Scheduled",
            "Complied",
            "With findings",
            "Failed",
            "Not found or closed",
            "Cancelled",
        ),  # fmt: skip
        110,
        (
            _field("inspection_no", "Inspection number", "Text", "reference", required=True),
            _field("inspected_on", "Inspected on", "Date", "inspected_on", required=True),
            _choice(
                "inspection_type",
                "Type",
                BUSINESS_INSPECTION_TYPES,
                required=True,
                value_kind="business_inspection_type",
            ),  # fmt: skip
            _field("agencies", "Agencies present", "Text", "agencies"),
            _field("findings", "Findings", "Long text", "business_findings"),
            _field("comply_by", "Comply by", "Date", "comply_by"),
            _field("lead_inspector", "Lead inspector", "User", "inspector", required=True),
            _flag("notice_required", "Notice needed"),
        ),
    ),
    _module(
        "enforcement_notices",
        "Enforcement Notice",
        "bplo",
        "EN",
        "Issued on",
        ("Draft", "Served", "Complied", "Escalated", "Lifted", "Cancelled"),
        30,
        (
            _field("notice_no", "Notice number", "Text", "reference", required=True),
            _field("issued_on", "Issued on", "Date", "issued_on", required=True),
            _choice(
                "notice_type", "Type", NOTICE_TYPES, required=True, value_kind="notice_type"
            ),  # fmt: skip
            _choice("violation", "Violation", VIOLATIONS, required=True, value_kind="violation"),
            _field(
                "compliance_days",
                "Days to comply",
                "Integer",
                "compliance_days",
                minimum=1,
                maximum=60,
            ),  # fmt: skip
            _field("served_by", "Served by", "User", "inspector"),
        ),
    ),
)

BUILDING = (
    _module(
        "building_permits",
        "Building Permit Application",
        "building_official",
        "OBO",
        "Filed on",
        (
            "Received",
            "Site inspected",
            "Under evaluation",
            "For payment",
            "Paid",
            "Permit issued",
            "Under construction",
            "Completed",
            "Returned for compliance",
            "Disapproved",
            "Deemed approved",
            "Expired",
        ),  # fmt: skip
        110,
        (
            _field("application_no", "Application number", "Text", "reference", required=True),
            _field("filed_on", "Filed on", "Date", "filed_on", required=True),
            _field("project_title", "Project title", "Text", "building_project", required=True),
            _choice("scope", "Scope of work", SCOPES, required=True, value_kind="scope"),
            _choice(
                "complexity", "Complexity", COMPLEXITY, required=True, value_kind="complexity"
            ),  # fmt: skip
            _peso("estimated_cost", "Estimated cost ₱", "estimated_cost", required=True),
            _choice("barangay", "Barangay", BARANGAYS, required=True, value_kind="barangay"),
            _field(
                "days_pending", "Days pending", "Integer", "days_pending", minimum=0, maximum=90
            ),  # fmt: skip
            _choice("sla_flag", "Service time", SLA_FLAGS, value_kind="sla_flag"),
            _field("evaluator", "Evaluator", "User", "evaluator"),
            _field("permit_no", "Permit number", "Text", "permit_no"),
        ),
    ),
    _module(
        "building_inspections",
        "Building Inspection",
        "building_official",
        "BI",
        "Scheduled on",
        (
            "Scheduled",
            "Passed",
            "Passed with notes",
            "Failed, correction required",
            "Re-inspection scheduled",
            "Stop-work issued",
            "Cancelled",
        ),  # fmt: skip
        220,
        (
            _field("inspection_no", "Inspection number", "Text", "reference", required=True),
            _field("scheduled_on", "Scheduled on", "Date", "scheduled_on", required=True),
            _choice(
                "inspection_type",
                "Type",
                BUILDING_INSPECTION_TYPES,
                required=True,
                value_kind="building_inspection_type",
            ),  # fmt: skip
            _field("findings", "Findings", "Long text", "building_findings"),
            _field("inspector", "Inspector", "User", "inspector", required=True),
            _field("photo_link", "Photo folder", "URL", "url"),
            _check("reinspection_needed", "Re-inspection needed"),
        ),
    ),
)
