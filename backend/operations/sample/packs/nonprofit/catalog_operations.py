"""Finance, Procurement and Logistics, and Volunteer Engagement modules."""

from __future__ import annotations

from operations.sample.packs.nonprofit.catalog_fields import (
    DELIVERY_SITES,
    DISBURSEMENT_TYPES,
    EXPENSE_CATEGORIES,
    PROCUREMENT_METHODS,
    RECEIPT_TYPES,
    RESTRICTION_CLASSES,
    SKILLS,
    SUPPLIER_CATEGORIES,
    _check,
    _choice,
    _field,
    _flag,
    _module,
    _peso,
)

FINANCE = (
    _module(
        "funds",
        "Fund",
        "finance",
        "FND",
        "Opened on",
        ("Open", "Active", "Fully spent", "Closed", "Frozen"),
        18,
        (
            _field("fund_code", "Fund code", "Text", "reference", required=True),
            _field("opened_on", "Opened on", "Date", "date"),
            _choice("restriction_class", "Restriction class", RESTRICTION_CLASSES, required=True),
            _choice("source", "Source", ("Grant", "Appeal", "Corporate", "General")),
            _field("budget", "Budget ₱", "Number", "budget", minimum=0),
            _field("spent", "Spent ₱", "Number", "budget", minimum=0),
            _field("available", "Available ₱", "Number", "budget", minimum=0),
            _field("expiry", "Expires (month/year)", "Text", "month_year"),
        ),
    ),
    _module(
        "cash_advances",
        "Cash Advance",
        "finance",
        "CA",
        "Requested on",
        ("Requested", "Approved", "Released", "Partially liquidated", "Fully liquidated",
         "Closed", "Rejected", "Overdue", "Refund due"),  # fmt: skip
        110,
        (
            _field("advance_no", "Advance no.", "Text", "reference", required=True),
            _field("requested_on", "Requested on", "Date", "date", required=True),
            _field("released_on", "Released on", "Date", "date"),
            _field("liquidation_due", "Liquidation due", "Date", "date"),
            _field("purpose", "Purpose", "Long text", "purpose", required=True),
            _field("custodian", "Custodian", "User", "programs_user", required=True),
            _peso("amount_released", "Amount released ₱", "amount", required=True),
            _peso("amount_liquidated", "Amount liquidated ₱", "amount"),
            _peso("balance", "Unliquidated balance ₱", "amount"),
            _field("approved_by", "Approved by", "User", "programs_user"),
            _flag("ready_to_close", "Ready to close"),
        ),
    ),
    _module(
        "expense_lines",
        "Expense Line",
        "finance",
        "EXP",
        "Receipt date",
        ("Submitted", "Checked", "Approved", "Posted", "Returned", "Disallowed"),
        400,
        (
            _field("expense_date", "Receipt date", "Date", "date", required=True),
            _field("payee", "Payee", "Text", "payee"),
            _peso("amount", "Amount ₱", "amount", required=True),
            _choice("category", "Category", EXPENSE_CATEGORIES, required=True),
            _choice("receipt_type", "Receipt type", RECEIPT_TYPES),
            _field("receipt_no", "Receipt no.", "Text", "receipt_no"),
            _field("checked_by", "Checked by", "User", "team_user"),
        ),
    ),
    _module(
        "disbursements",
        "Disbursement",
        "finance",
        "DV",
        "Voucher date",
        ("Draft", "For approval", "Approved", "Released", "Cleared", "On hold", "Voided"),
        190,
        (
            _field("voucher_no", "Voucher no.", "Text", "reference", required=True),
            _field("voucher_date", "Voucher date", "Date", "date", required=True),
            _field("payee", "Payee", "Text", "payee", required=True),
            _peso("amount", "Amount ₱", "amount", required=True),
            _choice("disbursement_type", "Type", DISBURSEMENT_TYPES, required=True),
            _choice("method", "Method", ("Bank transfer", "Check", "Cash", "Mobile money")),
            _field("prepared_by", "Prepared by", "User", "team_user"),
            _field("approved_by", "Approved by", "User", "lead_user"),
            _flag("payment_run", "In the Friday payment run"),
        ),
    ),
)

PROCUREMENT = (
    _module(
        "suppliers",
        "Supplier",
        "procurement",
        "SUP",
        "Last evaluated",
        ("Prospective", "Accredited", "Active", "Suspended", "Excluded"),
        45,
        (
            _field("last_evaluated", "Last evaluated", "Date", "date"),
            _choice("category", "Category", SUPPLIER_CATEGORIES, required=True),
            _field("tin", "TIN", "Text", "tin"),
            _field("contact_email", "Contact email", "Email", "email"),
            _field("phone", "Phone", "Text", "phone"),
            _choice("exclusion_check", "Exclusion check", ("Clear", "Not checked", "Flagged")),
        ),
    ),
    _module(
        "purchase_requests",
        "Purchase Request",
        "procurement",
        "PR",
        "Requested on",
        ("Draft", "Submitted", "Budget checked", "Approved", "Sourcing", "PO issued",
         "Completed", "Returned", "Rejected", "Cancelled"),  # fmt: skip
        100,
        (
            _field("pr_no", "PR no.", "Text", "reference", required=True),
            _field("requested_on", "Requested on", "Date", "date", required=True),
            _field("needed_by", "Needed by", "Date", "date"),
            _field("estimated_cost", "Estimated cost ₱", "Number", "cost", required=True,
                   minimum=0),  # fmt: skip
            _choice("method", "Method", PROCUREMENT_METHODS),
            _field("quotes_received", "Quotes received", "Integer", "count", minimum=0,
                   maximum=12),  # fmt: skip
            _field("requested_by", "Requested by", "User", "programs_user", required=True),
            _field("approved_by", "Approved by", "User", "programs_user"),
            _field("justification", "Justification", "Long text", "justification"),
            _flag("three_quotes", "Three quotes needed"),
        ),
    ),
    _module(
        "purchase_orders",
        "Purchase Order",
        "procurement",
        "PO",
        "Issued on",
        ("Draft", "Issued", "Partially received", "Received", "Invoiced", "Paid", "Closed",
         "Cancelled"),  # fmt: skip
        70,
        (
            _field("po_no", "PO no.", "Text", "reference", required=True),
            _field("issued_on", "Issued on", "Date", "date", required=True),
            _field("delivery_due", "Delivery due", "Date", "date"),
            _peso("amount", "Amount ₱", "amount", required=True),
            _choice("delivery_site", "Deliver to", DELIVERY_SITES),
            _field("received_by", "Received by", "User", "team_user"),
            _field("receiving_notes", "Receiving notes", "Long text", "receiving_notes"),
        ),
    ),
)

VOLUNTEERS = (
    _module(
        "volunteers",
        "Volunteer",
        "volunteer_engagement",
        "VOL",
        "Last active on",
        ("Applied", "Screening", "Active", "Inactive", "Declined", "Offboarded"),
        180,
        (
            _field("last_active_on", "Last active on", "Date", "date"),
            _field("email", "Email", "Email", "email"),
            _field("mobile", "Mobile", "Text", "phone"),
            _choice("skill", "Main skill", SKILLS),
            _choice("background_check", "Background check",
                    ("Cleared", "Not required", "Pending", "Expired")),  # fmt: skip
            _check("code_of_conduct", "Code of conduct signed"),
            _field("volunteer_since", "Volunteer since (year)", "Integer", "year",
                   minimum=1990, maximum=2099),  # fmt: skip
            _field("coordinator", "Coordinator", "User", "team_user"),
        ),
    ),
)
