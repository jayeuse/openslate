"""City government workflow status histories and records reserved for named checks."""

_PERMIT = ("Received", "Site inspected", "Under evaluation", "For payment", "Paid",
           "Permit issued")  # fmt: skip
_APPLICATION = ("Filed", "Verified", "Assessed", "Paid", "Approved", "Released")
_REQUEST = ("New", "Acknowledged", "Action scheduled", "In progress", "Fixed")
_VOUCHER = ("Received", "Pre-audited", "Certified by accountant", "Funds certified",
            "Approved for payment", "Paid")  # fmt: skip
_PROJECT = ("Pre-procurement conference", "Posted", "Bids opened", "Under evaluation",
            "Post-qualification", "Recommended for award", "Awarded", "Contract signed",
            "Notice to proceed")  # fmt: skip
_MEASURE = (
    "Filed",
    "First reading and referred",
    "In committee",
    "Committee report",
    "Second reading",
    "Approved on third reading",
    "Transmitted to the Mayor",
    "Signed",
)
_PURCHASE = ("Draft", "Submitted", "Budget-cleared", "Approved", "Endorsed to BAC",
             "Consolidated")  # fmt: skip


def _upto(chain: tuple[str, ...]) -> dict[str, tuple[str, ...]]:
    """Every later state of a straight workflow, reached through the states before it."""
    return {state: chain[: position + 1] for position, state in enumerate(chain) if position}


_STATUS_CHAINS: dict[str, dict[str, tuple[str, ...]]] = {
    "business_establishments": {
        "Delinquent": ("Active", "Delinquent"),
        "Under notice": ("Active", "Under notice"),
        "Closed by order": ("Active", "Under notice", "Closed by order"),
        "Retired": ("Active", "Retired"),
    },
    "permit_applications": {
        **_upto(_APPLICATION),
        "Returned for compliance": ("Filed", "Returned for compliance"),
        "Disapproved": ("Filed", "Verified", "Disapproved"),
        "Withdrawn": ("Filed", "Withdrawn"),
    },
    "business_inspections": {
        label: ("Scheduled", label)
        for label in ("Complied", "With findings", "Failed", "Not found or closed", "Cancelled")
    },
    "enforcement_notices": {
        "Served": ("Draft", "Served"),
        "Complied": ("Draft", "Served", "Complied"),
        "Escalated": ("Draft", "Served", "Escalated"),
        "Lifted": ("Draft", "Served", "Escalated", "Lifted"),
    },
    "building_permits": {
        **_upto(_PERMIT),
        "Under construction": (*_PERMIT, "Under construction"),
        "Completed": (*_PERMIT, "Under construction", "Completed"),
        "Expired": (*_PERMIT, "Expired"),
        "Returned for compliance": ("Received", "Returned for compliance"),
        "Disapproved": ("Received", "Site inspected", "Under evaluation", "Disapproved"),
        "Deemed approved": ("Received", "Site inspected", "Under evaluation", "Deemed approved"),
    },
    "building_inspections": {
        "Passed": ("Scheduled", "Passed"),
        "Passed with notes": ("Scheduled", "Passed with notes"),
        "Failed, correction required": ("Scheduled", "Failed, correction required"),
        "Re-inspection scheduled": (
            "Scheduled",
            "Failed, correction required",
            "Re-inspection scheduled",
        ),  # fmt: skip
        "Stop-work issued": ("Scheduled", "Stop-work issued"),
        "Cancelled": ("Scheduled", "Cancelled"),
    },
    "service_requests": {
        **_upto(_REQUEST),
        "Investigating": ("New", "Acknowledged", "Investigating"),
        "No further action": ("New", "Acknowledged", "Investigating", "No further action"),
        "Duplicate": ("New", "Duplicate"),
        "Not responsible": ("New", "Not responsible"),
        "Internal referral": ("New", "Internal referral"),
        "Reopened": (*_REQUEST, "Reopened"),
    },
    "work_orders": {
        **_upto(("Planned", "Dispatched", "On site", "Completed", "Verified")),
        "On hold for materials": ("Planned", "Dispatched", "On hold for materials"),
        "Cancelled": ("Planned", "Cancelled"),
    },
    "payment_orders": {
        label: ("Unpaid", label) for label in ("Partially paid", "Paid", "Reassessed", "Cancelled")
    },
    "official_receipts": {"Cancelled": ("Issued", "Cancelled")},
    "deposit_reports": {
        **_upto(("Draft", "Submitted", "Deposited", "Reconciled")),
        "Discrepancy": ("Draft", "Submitted", "Deposited", "Discrepancy"),
    },
    "payment_releases": {
        **_upto(("Prepared", "Signed", "Released", "Cleared")),
        "Stale": ("Prepared", "Signed", "Released", "Stale"),
        "Cancelled": ("Prepared", "Cancelled"),
    },
    "appropriations": {
        "Enacted": ("Proposed", "Enacted"),
        "Closed": ("Proposed", "Enacted", "Closed"),
    },
    "obligation_requests": {
        **_upto(("Filed", "Certified", "Obligated")),
        "Returned, insufficient allotment": ("Filed", "Returned, insufficient allotment"),
        "Returned, wrong account code": ("Filed", "Returned, wrong account code"),
        "Cancelled": ("Filed", "Cancelled"),
    },
    "disbursement_vouchers": {
        **_upto(_VOUCHER),
        "Returned for incomplete documents": ("Received", "Returned for incomplete documents"),
        "Disallowed in pre-audit": ("Received", "Pre-audited", "Disallowed in pre-audit"),
        "Cancelled": ("Received", "Cancelled"),
    },
    "suppliers": {
        "Inactive": ("Active", "Inactive"),
        "Suspended": ("Active", "Suspended"),
        "Blacklisted": ("Active", "Suspended", "Blacklisted"),
    },
    "purchase_requests": {
        **_upto(_PURCHASE),
        "Returned": ("Draft", "Submitted", "Returned"),
        "Cancelled": ("Draft", "Cancelled"),
    },
    "procurement_projects": {
        **_upto(_PROJECT),
        "Pre-bid held": ("Pre-procurement conference", "Posted", "Pre-bid held"),
        "Failed bidding": ("Pre-procurement conference", "Posted", "Failed bidding"),
        "Re-bid posted": (
            "Pre-procurement conference",
            "Posted",
            "Failed bidding",
            "Re-bid posted",
        ),  # fmt: skip
        "Second failure, negotiated": (
            "Pre-procurement conference",
            "Posted",
            "Failed bidding",
            "Re-bid posted",
            "Second failure, negotiated",
        ),
        "Cancelled": ("Pre-procurement conference", "Cancelled"),
    },
    "bids": {label: ("Received", label) for label in ("Opened", "Withdrawn", "Returned unopened")},
    "purchase_orders": {
        "Conformed": ("Issued", "Conformed"),
        "Partially delivered": ("Issued", "Conformed", "Partially delivered"),
        "Delivered": ("Issued", "Conformed", "Delivered"),
        "Accepted": ("Issued", "Conformed", "Delivered", "Accepted"),
        "Paid": ("Issued", "Conformed", "Delivered", "Accepted", "Paid"),
        "Terminated": ("Issued", "Conformed", "Terminated"),
        "Liquidated damages applied": (
            "Issued",
            "Conformed",
            "Delivered",
            "Liquidated damages applied",
        ),  # fmt: skip
    },
    "communications": {
        **_upto(("Received", "Routed", "In action", "Acted", "Filed")),
        "Returned": ("Received", "Returned"),
        "Duplicate": ("Received", "Duplicate"),
    },
    "legislative_measures": {
        **_upto(_MEASURE),
        "Vetoed": (*_MEASURE[:7], "Vetoed"),
        "Deemed approved": (*_MEASURE[:7], "Deemed approved"),
        "Laid on the table": (*_MEASURE[:3], "Laid on the table"),
        "Withdrawn": ("Filed", "Withdrawn"),
    },
    "civil_registry": {
        **_upto(("Received", "Reviewed", "Registered", "Transmitted to national registry")),
        "Posted for 10 days": ("Received", "Posted for 10 days"),
        "For correction": ("Received", "Reviewed", "For correction"),
        "Rejected": ("Received", "Reviewed", "Rejected"),
    },
}

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    module: {final: chain[:-1] for final, chain in paths.items()}
    for module, paths in _STATUS_CHAINS.items()
}

# The named installment, and the failed inspection whose create-time rule flags a notice.
PROTECTED_RECORDS = frozenset(
    {"payment_orders:000001", "official_receipts:000001", "business_inspections:000001"}
)
TARGET_SHARE = 0.40
REASSIGNED_SHARE = 0.25
