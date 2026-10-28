"""Distributor workflow status histories and the records reserved for named checks."""

_ORDER = ("Draft", "Submitted", "Confirmed", "Picked", "Dispatched")
_PO = ("Draft", "Pending approval", "Approved", "Sent to principal")
_RETURN = ("Requested", "Authorized", "Picked up", "Received", "Inspected")
_PROMOTION = ("Draft", "Pending principal approval", "Approved", "Active")
_CLAIM = ("Draft", "Submitted", "Under principal review")

_STATUS_CHAINS: dict[str, dict[str, tuple[str, ...]]] = {
    "outlets": {
        "Active": ("Prospect", "Active"),
        "Inactive": ("Active", "Inactive"),
        "On credit hold": ("Active", "On credit hold"),
        "Blocked": ("Active", "On credit hold", "Blocked"),
        "Closed": ("Active", "Inactive", "Closed"),
    },
    "beats": {
        "Active": ("Draft", "Active"),
        "Under review": ("Active", "Under review"),
        "Retired": ("Active", "Retired"),
    },
    "store_visits": {
        "Completed": ("Planned", "In progress", "Completed"),
        "Not visited": ("Planned", "Not visited"),
        "Abandoned": ("Planned", "In progress", "Abandoned"),
    },
    "sales_orders": {
        "Delivered": (*_ORDER, "Delivered"),
        "Partially delivered": (*_ORDER, "Partially delivered"),
        "Confirmed": ("Submitted", "Confirmed"),
        "Picked": ("Submitted", "Confirmed", "Picked"),
        "Credit hold": ("Submitted", "Credit hold"),
        "Cancelled": ("Submitted", "Cancelled"),
        "Rejected by credit": ("Submitted", "Credit hold", "Rejected by credit"),
    },
    "route_tours": {
        "Checked in": ("Planned", "Checked out", "Checked in"),
        "Settled": ("Planned", "Checked out", "Checked in", "Settled"),
        "Variance under review": ("Planned", "Checked out", "Checked in",
                                  "Variance under review"),  # fmt: skip
    },
    "trade_promotions": {
        "Approved": _PROMOTION[:3],
        "Active": _PROMOTION,
        "Ended": (*_PROMOTION, "Ended"),
        "Claimed": (*_PROMOTION, "Ended", "Claimed"),
        "Cancelled": ("Draft", "Pending principal approval", "Cancelled"),
    },
    "principals": {
        "Active": ("Onboarding", "Active"),
        "On hold": ("Active", "On hold"),
        "Terminated": ("Active", "On hold", "Terminated"),
    },
    "products": {
        "Active": ("New listing", "Active"),
        "Phase-out": ("Active", "Phase-out"),
        "Delisted": ("Active", "Phase-out", "Delisted"),
        "Recalled": ("Active", "Recalled"),
    },
    "purchase_orders": {
        "Approved": _PO[:3],
        "Sent to principal": _PO,
        "Partially received": (*_PO, "Partially received"),
        "Received": (*_PO, "Received"),
        "Closed": (*_PO, "Received", "Closed"),
        "Rejected": ("Draft", "Pending approval", "Rejected"),
        "Cancelled": ("Draft", "Cancelled"),
    },
    "goods_receipts": {
        "Posted": ("Draft", "Counting", "Posted"),
        "Posted with discrepancy": ("Draft", "Counting", "Posted with discrepancy"),
        "Reversed": ("Draft", "Counting", "Posted", "Reversed"),
    },
    "stock_lots": {
        "Pick first (FEFO)": ("Available", "Pick first (FEFO)"),
        "Depleted": ("Available", "Depleted"),
        "Quarantine": ("Available", "Quarantine"),
        "Blocked": ("Available", "Pick first (FEFO)", "Blocked"),
        "Returned to principal": ("Available", "Blocked", "Returned to principal"),
    },
    "stock_counts": {
        "Counted": ("Scheduled", "Counted"),
        "Recount required": ("Scheduled", "Counted", "Recount required"),
        "Approved": ("Scheduled", "Counted", "Approved"),
        "Posted": ("Scheduled", "Counted", "Approved", "Posted"),
    },
    "stock_adjustments": {
        "Pending approval": ("Draft", "Pending approval"),
        "Approved": ("Draft", "Pending approval", "Approved"),
        "Posted": ("Draft", "Pending approval", "Approved", "Posted"),
        "Rejected": ("Draft", "Pending approval", "Rejected"),
    },
    "returns": {
        "Authorized": _RETURN[:2],
        "Picked up": _RETURN[:3],
        "Received": _RETURN[:4],
        "Inspected": _RETURN,
        "Credited": (*_RETURN, "Credited"),
        "Replaced": (*_RETURN, "Replaced"),
        "Rejected": ("Requested", "Rejected"),
    },
    "delivery_trips": {
        "Returned to depot": ("Planned", "Loading", "Dispatched", "In transit",
                              "Returned to depot"),  # fmt: skip
        "Closed": ("Planned", "Loading", "Dispatched", "In transit", "Returned to depot",
                   "Closed"),  # fmt: skip
    },
    "vehicles": {
        "On trip": ("Available", "On trip"),
        "Under maintenance": ("Available", "Under maintenance"),
        "Out of service": ("Available", "Under maintenance", "Out of service"),
    },
    "sales_invoices": {
        "Paid": ("Open", "Paid"),
        "Partially paid": ("Open", "Partially paid"),
        "Overdue": ("Open", "Overdue"),
        "Disputed": ("Open", "Overdue", "Disputed"),
        "Written off": ("Open", "Overdue", "Written off"),
    },
    "collection_receipts": {
        "Remitted": ("Recorded", "Remitted"),
        "Deposited": ("Recorded", "Deposited"),
        "Cleared": ("Recorded", "Deposited", "Cleared"),
        "Bounced": ("Recorded", "Deposited", "Bounced"),
        "Voided": ("Recorded", "Voided"),
    },
    "credit_reviews": {
        "Under review": ("Submitted", "Under review"),
        "Approved": ("Submitted", "Under review", "Approved"),
        "Approved with conditions": ("Submitted", "Under review", "Approved with conditions"),
        "Declined": ("Submitted", "Under review", "Declined"),
    },
    "collection_followups": {
        "Promise to pay": ("Open", "Promise to pay"),
        "Paid": ("Open", "Promise to pay", "Paid"),
        "Escalated": ("Open", "Escalated"),
        "Closed – uncollectible": ("Open", "Escalated", "Closed – uncollectible"),
    },
    "principal_invoices": {
        "Matching": ("Received", "Matching"),
        "Approved for payment": ("Received", "Matching", "Approved for payment"),
        "Paid": ("Received", "Matching", "Approved for payment", "Paid"),
        "On hold – variance": ("Received", "Matching", "On hold – variance"),
        "Disputed": ("Received", "Matching", "On hold – variance", "Disputed"),
    },
    "principal_claims": {
        "Submitted": _CLAIM[:2],
        "Under principal review": _CLAIM,
        "Approved": (*_CLAIM, "Approved"),
        "Partially approved": (*_CLAIM, "Partially approved"),
        "Rejected": (*_CLAIM, "Rejected"),
        "Settled – credit note": (*_CLAIM, "Approved", "Settled – credit note"),
        "Settled – offset": (*_CLAIM, "Approved", "Settled – offset"),
        "Written off": (*_CLAIM, "Rejected", "Written off"),
    },
}

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    module: {final: chain[:-1] for final, chain in paths.items()}
    for module, paths in _STATUS_CHAINS.items()
}

PROTECTED_RECORDS = frozenset({"sales_invoices:000001", "collection_receipts:000001"})
TARGET_SHARE = 0.40
REASSIGNED_SHARE = 0.25
