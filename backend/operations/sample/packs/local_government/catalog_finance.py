"""Treasury, and Budget and Accounting modules: assessment to collection, and obligation to
payment, with each certifying signature in the office that owns it (research §11)."""

from __future__ import annotations

from operations.sample.packs.local_government.catalog_fields import (
    EXPENSE_CLASSES,
    FUND_SOURCES,
    FUNDS,
    OFFICES,
    OOP_SOURCES,
    RECEIPT_MODES,
    RECEIPT_NATURES,
    RELEASE_MODES,
    _check,
    _choice,
    _field,
    _module,
    _peso,
)

TREASURY = (
    _module(
        "payment_orders",
        "Order of Payment",
        "treasury",
        "OOP",
        "Assessed on",
        ("Unpaid", "Partially paid", "Paid", "Reassessed", "Cancelled"),
        520,
        (
            _field("oop_no", "Order of payment number", "Text", "reference", required=True),
            _field("assessed_on", "Assessed on", "Date", "assessed_on", required=True),
            _choice("source", "Source", OOP_SOURCES, required=True, value_kind="oop_source"),
            _field("payor", "Payor", "Text", "payor", required=True),
            _peso("amount_due", "Amount due ₱", "amount_due", required=True),
            _peso("surcharge", "Surcharge and interest ₱", "surcharge"),
            _peso("balance", "Balance ₱", "oop_balance", required=True),
            _field("due_on", "Pay by", "Date", "due_on"),
            _field("assessed_by", "Assessed by", "User", "assessor", required=True),
            _field("fee_breakdown", "Fee breakdown", "Long text", "fee_breakdown"),
        ),
    ),
    _module(
        "official_receipts",
        "Official Receipt",
        "treasury",
        "OR",
        "Issued on",
        ("Issued", "Cancelled"),
        500,
        (
            _field("or_no", "OR number", "Text", "reference", required=True),
            _field("issued_on", "Issued on", "Date", "issued_on", required=True),
            _field("payor", "Payor", "Text", "payor", required=True),
            _peso("amount", "Amount ₱", "receipt_amount", required=True),
            _choice(
                "mode", "Mode of payment", RECEIPT_MODES, required=True, value_kind="receipt_mode"
            ),  # fmt: skip
            _choice(
                "nature",
                "Nature of collection",
                RECEIPT_NATURES,
                required=True,
                value_kind="receipt_nature",
            ),  # fmt: skip
            _field("oop_reference", "Order of payment number", "Text", "cross_reference"),
            _field("collector", "Collector", "User", "collector", required=True),
        ),
    ),
    _module(
        "deposit_reports",
        "Collection Deposit Report",
        "treasury",
        "CDR",
        "Report date",
        ("Draft", "Submitted", "Deposited", "Reconciled", "Discrepancy"),
        240,
        (
            _field("report_date", "Report date", "Date", "daily_date", required=True),
            _field("collector", "Collector", "User", "collector", required=True),
            _field("or_from", "OR from", "Text", "or_from", required=True),
            _field("or_to", "OR to", "Text", "or_to", required=True),
            _peso("total_collected", "Total collected ₱", "total_collected", required=True),
            _peso("deposited_amount", "Deposited ₱", "deposited_amount"),
            _field("deposit_date", "Deposit date", "Date", "deposit_date"),
        ),
    ),
    _module(
        "payment_releases",
        "Payment Release",
        "treasury",
        "CHK",
        "Prepared on",
        ("Prepared", "Signed", "Released", "Cleared", "Stale", "Cancelled"),
        250,
        (
            _field("check_no", "Check or ADA number", "Text", "reference", required=True),
            _field("prepared_on", "Prepared on", "Date", "prepared_on", required=True),
            _field("payee", "Payee", "Text", "payee", required=True),
            _peso("net_amount", "Net amount ₱", "release_amount", required=True),
            _choice("mode", "Mode", RELEASE_MODES, required=True, value_kind="release_mode"),
            _check("funds_certified", "Funds available certified"),
            _field("released_on", "Released on", "Date", "released_on"),
            _field("released_by", "Released by", "User", "disbursing", required=True),
        ),
    ),
)

BUDGET = (
    _module(
        "appropriations",
        "Appropriation",
        "budget_accounting",
        "AP",
        "Allotment released",
        ("Enacted", "Proposed", "Reenacted", "Closed"),
        110,
        (
            _field("account_code", "Account code", "Text", "account_code", required=True),
            _field("allotted_on", "Allotment released", "Date", "allotted_on"),
            _field(
                "fiscal_year",
                "Fiscal year",
                "Integer",
                "fiscal_year",
                required=True,
                minimum=2024,
                maximum=2030,
            ),  # fmt: skip
            _choice("office", "Office", OFFICES, required=True, value_kind="appropriation_office"),
            _choice(
                "expense_class",
                "Expense class",
                EXPENSE_CLASSES,
                required=True,
                value_kind="expense_class",
            ),  # fmt: skip
            _peso("appropriated_amount", "Appropriated ₱", "appropriated_amount", required=True),
            _peso("allotted_amount", "Allotted to date ₱", "allotted_amount"),
            _choice("fund_source", "Source", FUND_SOURCES, value_kind="fund_source"),
        ),
    ),
    _module(
        "obligation_requests",
        "Obligation Request",
        "budget_accounting",
        "OBR",
        "Filed on",
        (
            "Filed",
            "Certified",
            "Obligated",
            "Returned, insufficient allotment",
            "Returned, wrong account code",
            "Cancelled",
        ),  # fmt: skip
        280,
        (
            _field("obr_no", "ObR number", "Text", "reference", required=True),
            _field("filed_on", "Filed on", "Date", "filed_on", required=True),
            _choice(
                "requesting_office",
                "Requesting office",
                OFFICES,
                required=True,
                value_kind="requesting_office",
            ),  # fmt: skip
            _field("payee", "Payee", "Text", "payee", required=True),
            _field("particulars", "Particulars", "Long text", "particulars", required=True),
            _peso("amount", "Amount ₱", "obr_amount", required=True),
            _field("budget_officer", "Budget officer", "User", "budget_officer"),
        ),
    ),
    _module(
        "disbursement_vouchers",
        "Disbursement Voucher",
        "budget_accounting",
        "DV",
        "Received on",
        (
            "Received",
            "Pre-audited",
            "Certified by accountant",
            "Funds certified",
            "Approved for payment",
            "Paid",
            "Returned for incomplete documents",
            "Disallowed in pre-audit",
            "Cancelled",
        ),  # fmt: skip
        265,
        (
            _field("dv_no", "DV number", "Text", "reference", required=True),
            _field("received_on", "Received on", "Date", "received_on", required=True),
            _field("payee", "Payee", "Text", "payee", required=True),
            _field("particulars", "Particulars", "Long text", "particulars", required=True),
            _peso("gross_amount", "Gross amount ₱", "gross_amount", required=True),
            _peso("tax_withheld", "Tax withheld ₱", "tax_withheld"),
            _peso("net_amount", "Net amount ₱", "net_amount", required=True),
            _choice("fund", "Fund", FUNDS, required=True, value_kind="fund"),
            _field(
                "claim_certified_by", "Claim certified by", "Text", "claim_certifier", required=True
            ),  # fmt: skip
            _field("journal_entry_no", "Journal entry number", "Text", "journal_entry"),
            _field(
                "days_pending", "Days pending", "Integer", "days_pending", minimum=0, maximum=90
            ),  # fmt: skip
            _field("accountant", "Pre-audited by", "User", "accountant"),
        ),
    ),
)
