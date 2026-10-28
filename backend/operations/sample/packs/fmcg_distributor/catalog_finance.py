"""Credit and Collections, and Accounting and Claims modules."""

from __future__ import annotations

from operations.sample.packs.fmcg_distributor.catalog_fields import (
    AGING_BUCKETS,
    CLAIM_REJECTIONS,
    CLAIM_TYPES,
    CREDIT_REASONS,
    FOLLOW_UP_ACTIONS,
    MATCH_RESULTS,
    RECEIPT_METHODS,
    _choice,
    _field,
    _flag,
    _module,
    _optional_choice,
    _peso,
)

CREDIT = (
    _module(
        "sales_invoices",
        "Sales Invoice",
        "credit_collections",
        "SI",
        "Invoice date",
        ("Open", "Partially paid", "Paid", "Overdue", "Disputed", "Written off", "Voided"),
        555,
        (
            _field("invoice_no", "Invoice number", "Text", "reference", required=True),
            _field("invoice_date", "Invoice date", "Date", "invoice_date", required=True),
            _field("due_date", "Due date", "Date", "due_date", required=True),
            _choice("channel", "Channel", ("Pre-sell", "Van", "Key account"), required=True,
                    value_kind="invoice_channel"),  # fmt: skip
            _peso("amount", "Amount ₱", "invoice_amount", required=True),
            _peso("balance", "Balance ₱", "invoice_balance", required=True),
            _field("days_past_due", "Days past due", "Integer", "days_past_due", minimum=0),
            _choice("aging_bucket", "Aging bucket", AGING_BUCKETS, value_kind="aging_bucket"),
            _flag("followup_required", "Follow-up needed"),
        ),
    ),
    _module(
        "collection_receipts",
        "Collection Receipt",
        "credit_collections",
        "CR",
        "Receipt date",
        ("Recorded", "Remitted", "Deposited", "Cleared", "Bounced", "Voided"),
        455,
        (
            _field("receipt_no", "Receipt number", "Text", "reference", required=True),
            _field("receipt_date", "Receipt date", "Date", "receipt_date", required=True),
            _peso("amount", "Amount ₱", "receipt_amount", required=True),
            _choice("method", "Method", RECEIPT_METHODS, required=True,
                    value_kind="receipt_method"),  # fmt: skip
            _field("reference_no", "Cheque or reference number", "Text", "payment_reference"),
            _field("collected_by", "Collected by", "User", "collected_by", required=True),
        ),
    ),
    _module(
        "credit_reviews",
        "Credit Review",
        "credit_collections",
        "CRV",
        "Requested on",
        ("Submitted", "Under review", "Approved", "Approved with conditions", "Declined"),
        30,
        (
            _field("requested_on", "Requested on", "Date", "requested_on", required=True),
            _field("requested_by", "Requested by", "User", "credit_requester", required=True),
            _choice("review_type", "Review type",
                    ("New account", "Limit increase", "Periodic review", "Reinstatement"),
                    required=True, value_kind="review_type"),  # fmt: skip
            _peso("requested_limit", "Requested limit ₱", "credit_limit"),
            _peso("approved_limit", "Approved limit ₱", "approved_limit"),
            _choice("terms_requested", "Terms requested", ("7 days", "15 days", "30 days"),
                    value_kind="terms_requested"),  # fmt: skip
            _optional_choice("decline_reason", "Decline or hold reason", CREDIT_REASONS,
                             "decline_reason"),  # fmt: skip
        ),
    ),
    _module(
        "collection_followups",
        "Collection Follow-up",
        "credit_collections",
        "CF",
        "Follow-up date",
        ("Open", "Promise to pay", "Paid", "Escalated", "Closed – uncollectible"),
        70,
        (
            _field("followup_date", "Follow-up date", "Date", "followup_date", required=True),
            _choice("action", "Action", FOLLOW_UP_ACTIONS, required=True,
                    value_kind="followup_action"),  # fmt: skip
            _field("promise_date", "Promise-to-pay date", "Date", "promise_date"),
        ),
    ),
)

ACCOUNTING = (
    _module(
        "principal_invoices",
        "Principal Invoice",
        "accounting",
        "PINV",
        "Invoice date",
        ("Received", "Matching", "On hold – variance", "Approved for payment", "Paid",
         "Disputed"),  # fmt: skip
        60,
        (
            _field("principal_invoice_no", "Principal invoice number", "Text",
                   "principal_invoice_no", required=True),  # fmt: skip
            _field("invoice_date", "Invoice date", "Date", "ap_invoice_date", required=True),
            _field("due_date", "Due date", "Date", "ap_due_date"),
            _peso("amount", "Amount ₱", "ap_amount", required=True),
            _optional_choice("match_result", "Match result", MATCH_RESULTS, "match_result"),
        ),
    ),
    _module(
        "principal_claims",
        "Principal Claim",
        "accounting",
        "CLM",
        "Filed on",
        ("Draft", "Submitted", "Under principal review", "Approved", "Partially approved",
         "Rejected", "Settled – credit note", "Settled – offset", "Written off"),  # fmt: skip
        48,
        (
            _field("claim_no", "Claim number", "Text", "reference", required=True),
            _field("filed_on", "Filed on", "Date", "filed_on", required=True),
            _choice("claim_type", "Claim type", CLAIM_TYPES, required=True,
                    value_kind="claim_type"),  # fmt: skip
            _field("period", "Claim period", "Text", "claim_period"),
            _peso("claimed", "Claimed ₱", "claim_amount", required=True),
            _peso("approved", "Approved ₱", "approved_amount"),
            _optional_choice("rejection_reason", "Rejection reason", CLAIM_REJECTIONS,
                             "claim_rejection"),  # fmt: skip
            _field("filed_by", "Filed by", "User", "filed_by", required=True),
        ),
    ),
)
