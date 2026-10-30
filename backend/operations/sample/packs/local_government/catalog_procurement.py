"""Procurement and General Services modules: request, bidding, award, delivery (RA 12009)."""

from __future__ import annotations

from operations.sample.packs.local_government.catalog_fields import (
    EVALUATIONS,
    OFFICES,
    PROCUREMENT_MODES,
    SUPPLIER_TYPES,
    TIMELINE_FLAGS,
    _check,
    _choice,
    _field,
    _module,
    _optional_choice,
    _peso,
)

PROCUREMENT = (
    _module(
        "suppliers",
        "Supplier",
        "procurement",
        "SUP",
        "Last reviewed",
        ("Active", "Inactive", "Suspended", "Blacklisted"),
        55,
        (
            _field("tin", "TIN", "Text", "tin", required=True),
            _field("last_reviewed", "Last reviewed", "Date", "review_date"),
            _field("registry_no", "Registry number", "Text", "registry_no"),
            _choice(
                "supplier_type", "Type", SUPPLIER_TYPES, required=True, value_kind="supplier_type"
            ),  # fmt: skip
            _field("contact_person", "Contact person", "Text", "contact_person"),
            _field("email", "Email", "Email", "email"),
            _field("phone", "Phone", "Text", "phone"),
            _field("address", "Address", "Text", "supplier_address"),
        ),
    ),
    _module(
        "purchase_requests",
        "Purchase Request",
        "procurement",
        "PR",
        "Requested on",
        (
            "Draft",
            "Submitted",
            "Budget-cleared",
            "Approved",
            "Endorsed to BAC",
            "Consolidated",
            "Returned",
            "Cancelled",
        ),  # fmt: skip
        110,
        (
            _field("pr_no", "PR number", "Text", "reference", required=True),
            _field("requested_on", "Requested on", "Date", "requested_on", required=True),
            _choice("office", "Office", OFFICES, required=True, value_kind="requesting_office"),
            _field("purpose", "Purpose", "Long text", "pr_purpose", required=True),
            _field("item_summary", "Items", "Text", "item_summary", required=True),
            _peso("abc_amount", "Approved budget (ABC) ₱", "abc_amount", required=True),
            _check("in_plan", "In procurement plan"),
            _field("requested_by", "Requested by", "User", "requester", required=True),
            _optional_choice(
                "recommended_mode", "Recommended mode", PROCUREMENT_MODES, "recommended_mode"
            ),  # fmt: skip
        ),
    ),
    _module(
        "procurement_projects",
        "Procurement Project",
        "procurement",
        "BAC",
        "Posted on",
        (
            "Pre-procurement conference",
            "Posted",
            "Pre-bid held",
            "Bids opened",
            "Under evaluation",
            "Post-qualification",
            "Recommended for award",
            "Awarded",
            "Contract signed",
            "Notice to proceed",
            "Failed bidding",
            "Re-bid posted",
            "Second failure, negotiated",
            "Cancelled",
        ),  # fmt: skip
        80,
        (
            _field("reference_no", "Reference number", "Text", "reference", required=True),
            _field("posted_on", "Posted on", "Date", "posted_on"),
            _choice("mode", "Mode", PROCUREMENT_MODES, required=True, value_kind="mode"),
            _peso("abc_total", "ABC total ₱", "project_abc", required=True),
            _field("bid_opening", "Bid opening", "Date/Time", "bid_opening"),
            _field(
                "days_since_opening",
                "Days since opening",
                "Integer",
                "days_since_opening",
                minimum=0,
                maximum=400,
            ),  # fmt: skip
            _choice("timeline_flag", "Timeline", TIMELINE_FLAGS, value_kind="timeline_flag"),
            _field("bac_resolution_no", "BAC resolution number", "Text", "bac_resolution"),
            _field("procurement_officer", "Procurement officer", "User", "procurement_officer"),
        ),
    ),
    _module(
        "bids",
        "Bid or Quotation",
        "procurement",
        "BID",
        "Submitted on",
        ("Received", "Opened", "Withdrawn", "Returned unopened"),
        190,
        (
            _field("submitted_on", "Submitted on", "Date", "submitted_on", required=True),
            _peso("bid_amount", "Bid amount ₱", "bid_amount", required=True),
            _choice(
                "eligibility",
                "Eligibility",
                ("Eligible", "Ineligible"),
                required=True,
                value_kind="eligibility",
            ),  # fmt: skip
            _optional_choice("evaluation", "Evaluation", EVALUATIONS, "evaluation"),
            _field("rank", "Rank", "Integer", "bid_rank", minimum=1, maximum=20),
        ),
    ),
    _module(
        "purchase_orders",
        "Purchase Order",
        "procurement",
        "PO",
        "PO date",
        (
            "Issued",
            "Conformed",
            "Partially delivered",
            "Delivered",
            "Accepted",
            "Paid",
            "Terminated",
            "Liquidated damages applied",
        ),  # fmt: skip
        72,
        (
            _field("po_no", "PO number", "Text", "reference", required=True),
            _field("po_date", "PO date", "Date", "po_date", required=True),
            _peso("amount", "Contract amount ₱", "po_amount", required=True),
            _field(
                "delivery_days",
                "Delivery period (days)",
                "Integer",
                "delivery_days",
                minimum=1,
                maximum=180,
            ),  # fmt: skip
            _field("delivery_due", "Delivery due", "Date", "delivery_due"),
            _field("place_of_delivery", "Place of delivery", "Text", "delivery_place"),
            _field("approved_by", "Approved by", "Text", "po_approver", required=True),
        ),
    ),
    _module(
        "acceptance_reports",
        "Inspection and Acceptance Report",
        "procurement",
        "IAR",
        "Delivered on",
        (
            "Complete and conforming",
            "Partial",
            "Rejected, nonconforming",
            "Rejected, short delivery",
        ),  # fmt: skip
        75,
        (
            _field("iar_no", "IAR number", "Text", "reference", required=True),
            _field("delivered_on", "Delivered on", "Date", "delivered_on", required=True),
            _field("invoice_no", "Supplier invoice", "Text", "invoice_no"),
            _field("accepted_on", "Accepted on", "Date", "accepted_on"),
            _field(
                "inspection_officer",
                "Inspection officer",
                "User",
                "inspection_officer",
                required=True,
            ),  # fmt: skip
            _field("property_custodian", "Property custodian", "User", "custodian"),
        ),
    ),
)
