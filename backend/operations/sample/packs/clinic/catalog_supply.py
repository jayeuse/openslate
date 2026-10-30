"""Pharmacy, Revenue Cycle, Operations and Quality modules."""

from __future__ import annotations

from operations.sample.packs.clinic.catalog_fields import (
    CARC_CODES,
    CREDENTIAL_BANDS,
    CREDENTIAL_TYPES,
    DOSAGE_FORMS,
    EXPIRY_BANDS,
    HARM_LEVELS,
    INCIDENT_TYPES,
    LOT_LOCATIONS,
    _check,
    _choice,
    _field,
    _flag,
    _module,
    _optional_choice,
)

PHARMACY = (
    _module(
        "dispenses",
        "Dispense",
        "pharmacy",
        "DSP",
        "Dispensed on",
        ("Preparation", "In progress", "Completed", "On hold", "Declined", "Cancelled",
         "Stopped", "Entered in error"),  # fmt: skip
        289,
        (
            _field("dispense_no", "Dispense number", "Text", "reference", required=True),
            _field("dispensed_on", "Dispensed on", "Date", "child_date", required=True),
            _field("lot_reference", "Lot number", "Text", "cross_reference", required=True),
            _field("quantity", "Quantity", "Integer", "rx_quantity", required=True, minimum=1,
                   maximum=360),  # fmt: skip
            _field("days_supply", "Days supply", "Integer", "days_supply", minimum=1,
                   maximum=90),  # fmt: skip
            _check("counselled", "Counselled"),
            _field("dispensed_by", "Dispensed by", "User", "owner", required=True),
            _field("verified_by", "Verified by", "User", "validator"),
        ),
    ),
    _module(
        "pharmacy_items",
        "Pharmacy Item",
        "pharmacy",
        "ITM",
        "",
        ("Active", "Inactive", "Discontinued"),
        140,
        (
            _field("item_code", "Item code", "Text", "reference", required=True),
            _field("generic_name", "Generic name", "Text", "generic_name", required=True),
            _field("strength", "Strength", "Text", "strength", required=True),
            _choice("form", "Form", DOSAGE_FORMS, value_kind="dosage_form"),
            _field("pack_price", "Pack price $", "Number", "pack_price", required=True,
                   minimum=0),  # fmt: skip
            _field("reorder_level", "Reorder level", "Integer", "reorder_level", minimum=0),
            _check("cold_chain", "Cold chain"),
        ),
    ),
    _module(
        "stock_lots",
        "Stock Lot",
        "pharmacy",
        "LOT",
        "Received on",
        ("Available", "Quarantined", "Expired", "Recalled", "Depleted"),
        210,
        (
            _field("lot_no", "Lot number", "Text", "lot_no", required=True),
            _field("received_on", "Received on", "Date", "received_on", required=True),
            _field("expiry", "Expiry (month/year)", "Text", "expiry_month", required=True),
            _choice("expiry_band", "Expiry band", EXPIRY_BANDS, value_kind="expiry_band"),
            _field("qty_on_hand", "Qty on hand", "Integer", "qty_on_hand", required=True,
                   minimum=0),  # fmt: skip
            _field("unit_cost", "Unit cost $", "Number", "unit_cost", minimum=0),
            _choice("location", "Location", LOT_LOCATIONS, value_kind="lot_location"),
            _flag("reorder_required", "Reorder needed"),
        ),
    ),
    _module(
        "temperature_logs",
        "Temperature Log",
        "pharmacy",
        "TMP",
        "Check date",
        ("In range", "Excursion", "Excursion resolved"),
        256,
        (
            _field("check_date", "Check date", "Date", "daily_date", required=True),
            _field("checked_at", "Checked at", "Date/Time", "check_time", required=True),
            _choice("shift", "Check", ("AM", "PM"), value_kind="shift"),
            _field("current_c", "Current °C", "Number", "current_temperature", required=True,
                   minimum=-10, maximum=25, step=0.1),  # fmt: skip
            _field("min_c", "Min °C", "Number", "min_temperature", minimum=-10, maximum=25,
                   step=0.1),  # fmt: skip
            _field("max_c", "Max °C", "Number", "max_temperature", minimum=-10, maximum=25,
                   step=0.1),  # fmt: skip
            _field("checked_by", "Checked by", "User", "owner", required=True),
            _flag("incident_required", "Incident report needed"),
        ),
    ),
)

REVENUE = (
    _module(
        "claims",
        "Claim",
        "revenue_cycle",
        "CLM",
        "Service date",
        ("Draft", "Submitted", "Pending", "Paid", "Partially paid", "Denied",
         "Returned for correction", "Resubmitted", "Appealed", "Written off",
         "Entered in error"),  # fmt: skip
        375,
        (
            _field("claim_no", "Claim number", "Text", "reference", required=True),
            _field("service_date", "Service date", "Date", "child_date", required=True),
            _field("submitted_on", "Submitted on", "Date", "submitted_on"),
            _field("diagnosis_codes", "ICD-10 codes", "Text", "diagnosis", required=True),
            _field("procedure_codes", "Procedure codes", "Text", "procedure_codes"),
            _field("charge_total", "Charge total $", "Number", "charge_total", required=True,
                   minimum=0),  # fmt: skip
            _field("paid_total", "Paid to date $", "Number", "paid_total", minimum=0),
            _field("balance", "Balance $", "Number", "claim_balance", required=True, minimum=0),
            _field("resubmissions", "Resubmissions", "Integer", "resubmissions", minimum=0,
                   maximum=5),  # fmt: skip
            _flag("denial_queue", "In denials work queue"),
        ),
    ),
    _module(
        "claim_responses",
        "Claim Response",
        "revenue_cycle",
        "ERA",
        "Received on",
        ("Received", "Posted", "Disputed"),
        360,
        (
            _field("response_no", "Response number", "Text", "reference", required=True),
            _field("received_on", "Received on", "Date", "child_date", required=True),
            _choice("outcome", "Outcome", ("Complete", "Partial", "Error", "Queued"),
                    required=True, value_kind="response_outcome"),  # fmt: skip
            _choice("decision", "Decision",
                    ("Approved", "Partially approved", "Denied", "Returned for correction"),
                    required=True, value_kind="response_decision"),  # fmt: skip
            _field("allowed_amount", "Allowed amount $", "Number", "allowed_amount", minimum=0),
            _field("paid_amount", "Paid amount $", "Number", "response_paid", minimum=0),
            _field("patient_share", "Patient responsibility $", "Number", "patient_share",
                   minimum=0),  # fmt: skip
            _optional_choice("reason_code", "Reason code (CARC)", CARC_CODES, "carc"),
        ),
    ),
    _module(
        "payments",
        "Payment",
        "revenue_cycle",
        "RCPT",
        "Paid on",
        ("Posted", "Pending", "Refunded", "Voided"),
        552,
        (
            _field("receipt_no", "Receipt number", "Text", "reference", required=True),
            _field("paid_on", "Paid on", "Date", "child_date", required=True),
            _field("amount", "Amount $", "Number", "payment_amount", required=True, minimum=0),
            _choice("source", "Source", ("Patient", "Payer remittance"), required=True,
                    value_kind="payment_source"),  # fmt: skip
            _choice("method", "Method",
                    ("Card", "Cash", "Payer EFT", "Check", "Bank transfer", "Mobile wallet"),
                    value_kind="payment_method"),  # fmt: skip
            _field("claim_reference", "Claim number", "Text", "cross_reference"),
            _field("trace_no", "Trace number", "Text", "trace_no"),
            _field("received_by", "Received by", "User", "owner", required=True),
        ),
    ),
)

OPERATIONS = (
    _module(
        "suppliers",
        "Supplier",
        "operations",
        "SUP",
        "Last reviewed",
        ("Active", "On hold", "Inactive"),
        24,
        (
            _choice("category", "Category",
                    ("Medical supplies", "Pharmaceuticals", "Lab reagents", "Equipment service",
                     "Office supplies"), value_kind="supplier_category"),  # fmt: skip
            _field("contact_email", "Contact email", "Email", "email"),
            _field("phone", "Phone", "Text", "phone"),
            _field("last_reviewed", "Last reviewed", "Date", "review_date"),
            _field("lead_time_days", "Lead time (days)", "Integer", "lead_time", minimum=1,
                   maximum=60),  # fmt: skip
            _check("licensed", "Licensed distributor"),
        ),
    ),
    _module(
        "purchase_requests",
        "Purchase Request",
        "operations",
        "PR",
        "Requested on",
        ("Draft", "Submitted", "Approved", "Converted to PO", "Rejected", "Cancelled"),
        70,
        (
            _field("pr_no", "Request number", "Text", "reference", required=True),
            _field("requested_on", "Requested on", "Date", "requested_on", required=True),
            _field("item", "Item", "Text", "supply_item", required=True),
            _field("quantity", "Quantity", "Integer", "supply_quantity", required=True,
                   minimum=1, maximum=5_000),  # fmt: skip
            _field("needed_by", "Needed by", "Date", "needed_by"),
            _choice("reason", "Reason", ("Reorder level", "New item", "Stock-out", "Project"),
                    value_kind="request_reason"),  # fmt: skip
            _field("requested_by", "Requested by", "User", "requester", required=True),
            _field("approver", "Approver", "User", "approver"),
        ),
    ),
    _module(
        "purchase_orders",
        "Purchase Order",
        "operations",
        "PO",
        "Order date",
        ("Draft", "Approved", "Sent", "Partially received", "Received", "Closed", "Cancelled"),
        52,
        (
            _field("po_no", "PO number", "Text", "reference", required=True),
            _field("order_date", "Order date", "Date", "order_date", required=True),
            _field("total", "Total $", "Number", "po_total", required=True, minimum=0),
            _field("expected_delivery", "Expected delivery", "Date", "expected_delivery"),
            _field("invoice_no", "Supplier invoice", "Text", "invoice_no"),
            _check("invoice_matched", "Invoice matched"),
            _field("approved_by", "Approved by", "User", "approver", required=True),
        ),
    ),
    _module(
        "equipment",
        "Equipment",
        "operations",
        "EQ",
        "Next PM due",
        ("In service", "Due for service", "Out of service", "Under repair", "Retired"),
        65,
        (
            _field("asset_tag", "Asset tag", "Text", "reference", required=True),
            _field("next_pm_due", "Next PM due", "Date", "next_pm_due"),
            _field("make_model", "Make and model", "Text", "make_model"),
            _field("serial_no", "Serial number", "Text", "serial"),
            _field("location", "Location", "Text", "equipment_location"),
            _check("calibration_required", "Calibration required"),
            _flag("work_order_required", "Work order needed"),
        ),
    ),
    _module(
        "maintenance_work_orders",
        "Maintenance Work Order",
        "operations",
        "WO",
        "Scheduled on",
        ("Open", "Scheduled", "In progress", "Completed", "Awaiting parts", "Cancelled"),
        85,
        (
            _field("wo_no", "Work order number", "Text", "reference", required=True),
            _field("scheduled_on", "Scheduled on", "Date", "child_date", required=True),
            _field("completed_on", "Completed on", "Date", "completed_on"),
            _choice("wo_type", "Type",
                    ("Preventive maintenance", "Calibration", "Corrective repair",
                     "Electrical safety check"), required=True, value_kind="wo_type"),  # fmt: skip
            _optional_choice("result", "Result", ("Pass", "Adjusted then pass", "Fail"),
                             "wo_result"),  # fmt: skip
            _field("technician", "Technician", "Text", "technician"),
            _field("cost", "Cost $", "Number", "wo_cost", minimum=0),
            _flag("review_required", "Weekly review"),
        ),
    ),
)

QUALITY = (
    _module(
        "incident_reports",
        "Incident Report",
        "quality",
        "IR",
        "Occurred on",
        ("Reported", "Under review", "Action plan", "Closed"),
        28,
        (
            _field("incident_no", "Incident number", "Text", "reference", required=True),
            _field("occurred_on", "Occurred on", "Date", "occurred_on", required=True),
            _choice("incident_type", "Type", INCIDENT_TYPES, required=True,
                    value_kind="incident_type"),  # fmt: skip
            _choice("harm", "Harm", HARM_LEVELS, required=True, value_kind="harm"),
            _field("location", "Location", "Text", "incident_location"),
            _field("summary", "Summary", "Long text", "incident_summary", required=True),
            _field("handler", "Handler", "User", "owner"),
            _flag("rca_required", "Root-cause analysis needed"),
        ),
    ),
    _module(
        "staff_credentials",
        "Staff Credential",
        "quality",
        "CRD",
        "Verified on",
        ("Pending verification", "Verified", "Expiring soon", "Renewed", "Expired", "Suspended",
         "Revoked"),  # fmt: skip
        160,
        (
            _choice("credential_type", "Credential type", CREDENTIAL_TYPES, required=True,
                    value_kind="credential_type"),  # fmt: skip
            _field("staff_member", "Staff member", "Text", "staff_member", required=True),
            _field("license_no", "License number", "Text", "license_no", required=True),
            _field("verified_on", "Verified on", "Date", "verified_on"),
            _field("expiry", "Expires (month/year)", "Text", "credential_expiry", required=True),
            _choice("expiry_band", "Expiry band", CREDENTIAL_BANDS,
                    value_kind="credential_band"),  # fmt: skip
            _check("source_verified", "Primary source verified"),
            _check("privileges_active", "Privileges active"),
        ),
    ),
)
