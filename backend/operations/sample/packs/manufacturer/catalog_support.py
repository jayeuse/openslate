"""Maintenance and Finance modules (research §4). Customer Payment is added so the named
scenario has a child record (plan decision); the research has no payment module."""

from __future__ import annotations

from operations.sample.packs.manufacturer.catalog_fields import (
    CRITICALITY,
    FAILURE_CODES,
    INVOICE_TYPES,
    MWO_PRIORITIES,
    MWO_TYPES,
    PAYMENT_METHODS,
    _check,
    _choice,
    _field,
    _flag,
    _module,
    _money,
    _optional_choice,
)

MAINTENANCE = (
    _module(
        "equipment",
        "Equipment",
        "maintenance",
        "EQ",
        "Last preventive maintenance",
        ("In service", "Down", "Out of service", "Retired"),
        70,
        (
            _field("asset_tag", "Asset tag", "Text", "asset_tag", required=True),
            _choice("criticality", "Criticality", CRITICALITY, value_kind="criticality"),
            _field("make_model", "Manufacturer model", "Text", "make_model"),
            _field("install_year", "Install year", "Integer", "install_year", minimum=1985,
                   maximum=2030),  # fmt: skip
            _field("runtime_hours", "Runtime hours", "Number", "runtime_hours", minimum=0),
            _field("last_pm", "Last preventive maintenance", "Date", "last_pm"),
        ),
    ),
    _module(
        "maintenance_work_orders",
        "Maintenance Work Order",
        "maintenance",
        "MWO",
        "Requested on",
        ("Requested", "Approved", "Scheduled", "In progress", "Waiting parts", "Completed",
         "Closed", "Cancelled"),  # fmt: skip
        236,
        (
            _field("mwo_no", "MWO no", "Text", "reference", required=True),
            _field("requested_on", "Requested on", "Date", "requested_on", required=True),
            _choice("wo_type", "Type", MWO_TYPES, required=True, value_kind="mwo_type"),
            _choice("priority", "Priority", MWO_PRIORITIES, value_kind="mwo_priority"),
            _field("task", "Problem or task", "Long text", "task", required=True),
            _field("scheduled_on", "Scheduled date", "Date", "scheduled_on"),
            _field("labor_hours", "Labor hours", "Number", "labor_hours", minimum=0),
            _optional_choice("failure_code", "Failure code", FAILURE_CODES, "failure_code"),
            _money("parts_cost", "Parts cost $", "parts_cost"),
            _field("technician", "Technician", "User", "technician"),
            _check("sanitation_signoff", "Sanitation sign-off"),
            _flag("parts_review", "Parts review"),
        ),
    ),
)

FINANCE = (
    _module(
        "supplier_invoices",
        "Supplier Invoice",
        "finance",
        "SINV",
        "Invoice date",
        ("Received", "Matched", "Exception", "Approved", "Paid", "Disputed"),
        165,
        (
            _field("invoice_no", "Invoice no", "Text", "supplier_invoice_no", required=True),
            _field("invoice_date", "Invoice date", "Date", "supplier_invoice_date",
                   required=True),  # fmt: skip
            _money("amount", "Amount $", "supplier_invoice_amount", required=True),
            _check("three_way_match", "3-way match OK"),
            _field("price_variance", "Price variance $", "Number", "variance", step=0.01),
            _field("due_date", "Due date", "Date", "supplier_due"),
            _field("ap_clerk", "AP clerk", "User", "ap_clerk"),
            _flag("match_exception", "Match exception review"),
        ),
    ),
    _module(
        "customer_invoices",
        "Customer Invoice",
        "finance",
        "INV",
        "Invoice date",
        ("Draft", "Issued", "Partially paid", "Paid", "Overdue", "Disputed", "Credited"),
        310,
        (
            _field("invoice_no", "Invoice no", "Text", "reference", required=True),
            _field("invoice_date", "Invoice date", "Date", "invoice_date", required=True),
            _choice("invoice_type", "Invoice type", INVOICE_TYPES, required=True,
                    value_kind="invoice_type"),  # fmt: skip
            _money("amount", "Amount $", "invoice_amount", required=True),
            _money("balance", "Balance $", "invoice_balance", required=True),
            _field("due_date", "Due date", "Date", "invoice_due"),
        ),
    ),
    _module(
        "customer_payments",
        "Customer Payment",
        "finance",
        "PMT",
        "Payment date",
        ("Applied", "Cleared"),
        260,
        (
            _field("payment_ref", "Payment reference", "Text", "reference", required=True),
            _field("payment_date", "Payment date", "Date", "payment_date", required=True),
            _money("amount", "Amount $", "payment_amount", required=True),
            _choice("method", "Method", PAYMENT_METHODS, required=True, value_kind="method"),
            _field("remit_invoice", "Remittance invoice no", "Text", "cross_reference"),
        ),
    ),
)
