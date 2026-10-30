"""Foundation workflow status histories and records reserved for named checks."""

from operations.sample.packs.nonprofit.catalog_fields import AWARDED

_PIPELINE = ("Identified", "Concept note submitted", "Proposal submitted", "Under donor review")
_STATUS_CHAINS: dict[str, dict[str, tuple[str, ...]]] = {
    "donors": {
        "Active": ("Prospect", "First-time", "Active"),
        "Lapsed": ("First-time", "Active", "Lapsed"),
        "Reactivated": ("Active", "Lapsed", "Reactivated"),
        "First-time": ("Prospect", "First-time"),
    },
    "campaigns": {"Active": ("Planned", "Active"), "Closed": ("Planned", "Active", "Closed")},
    "donations": {
        "Received": ("Pending", "Received"),
        "Posted": ("Pending", "Received", "Posted"),
        "Refunded": ("Pending", "Received", "Posted", "Refunded"),
        "Failed": ("Pending", "Failed"),
    },
    "pledges": {
        "In progress": ("Pending", "In progress"),
        "Completed": ("Pending", "In progress", "Completed"),
        "Overdue": ("Pending", "In progress", "Overdue"),
        "Written off": ("Pending", "In progress", "Overdue", "Written off"),
    },
    "organizations": {"Active": ("Prospect", "Active"), "Inactive": ("Active", "Inactive")},
    "grant_awards": {
        "Under donor review": _PIPELINE,
        AWARDED: (*_PIPELINE, AWARDED),
        "Active": (*_PIPELINE, AWARDED, "Active"),
        "Closing": (AWARDED, "Active", "Closing"),
        "Closed": (AWARDED, "Active", "Closing", "Closed"),
        "Declined": (*_PIPELINE, "Declined"),
    },
    "grant_reports": {
        "In preparation": ("Not started", "In preparation"),
        "Submitted": ("Not started", "In preparation", "Internal review", "Submitted"),
        "Accepted": ("In preparation", "Internal review", "Submitted", "Accepted"),
        "Revision requested": ("In preparation", "Submitted", "Revision requested"),
    },
    "projects": {
        "Implementation": ("Pipeline", "Implementation"),
        "Finalisation": ("Implementation", "Finalisation"),
        "Closed": ("Implementation", "Finalisation", "Closed"),
    },
    "sites": {"Active": ("Assessed", "Active"), "Inactive": ("Assessed", "Active", "Inactive")},
    "activities": {
        "Scheduled": ("Planned", "Scheduled"),
        "Completed": ("Planned", "Scheduled", "Completed"),
        "Postponed": ("Planned", "Scheduled", "Postponed"),
    },
    "beneficiaries": {
        "Verified": ("Pre-registered", "Verified"),
        "Active": ("Pre-registered", "Verified", "Active"),
        "Exited": ("Verified", "Active", "Exited"),
        "Ineligible": ("Pre-registered", "Ineligible"),
    },
    "assistance": {
        "Validated": ("Planned", "Validated"),
        "Delivered": ("Planned", "Validated", "Delivered"),
        "Verified": ("Validated", "Delivered", "Verified"),
        "Disputed": ("Planned", "Validated", "Delivered", "Disputed"),
    },
    "indicators": {"Approved": ("Draft", "Approved"), "Active": ("Draft", "Approved", "Active")},
    "indicator_results": {
        "Submitted": ("Draft", "Submitted"),
        "Verified": ("Draft", "Submitted", "Verified"),
        "Reported": ("Submitted", "Verified", "Reported"),
    },
    "feedback_cases": {
        "Acknowledged": ("Received", "Acknowledged"),
        "Under review": ("Received", "Acknowledged", "Under review"),
        "Resolved": ("Acknowledged", "Under review", "Resolved"),
        "Closed": ("Acknowledged", "Under review", "Resolved", "Closed"),
        "Escalated": ("Received", "Under review", "Escalated"),
    },
    "funds": {"Active": ("Open", "Active"), "Closed": ("Active", "Fully spent", "Closed")},
    "cash_advances": {
        "Released": ("Requested", "Approved", "Released"),
        "Partially liquidated": ("Approved", "Released", "Partially liquidated"),
        "Closed": ("Released", "Partially liquidated", "Fully liquidated", "Closed"),
        "Overdue": ("Released", "Overdue"),
    },
    "expense_lines": {
        "Checked": ("Submitted", "Checked"),
        "Approved": ("Submitted", "Checked", "Approved"),
        "Posted": ("Checked", "Approved", "Posted"),
        "Disallowed": ("Submitted", "Checked", "Disallowed"),
    },
    "disbursements": {
        "Approved": ("Draft", "For approval", "Approved"),
        "Released": ("For approval", "Approved", "Released"),
        "Cleared": ("Approved", "Released", "Cleared"),
    },
    "suppliers": {"Active": ("Prospective", "Accredited", "Active")},
    "purchase_requests": {
        "Approved": ("Submitted", "Budget checked", "Approved"),
        "PO issued": ("Approved", "Sourcing", "PO issued"),
        "Completed": ("Approved", "Sourcing", "PO issued", "Completed"),
        "Rejected": ("Submitted", "Rejected"),
    },
    "purchase_orders": {
        "Issued": ("Draft", "Issued"),
        "Received": ("Issued", "Received"),
        "Paid": ("Issued", "Received", "Invoiced", "Paid"),
        "Closed": ("Received", "Invoiced", "Paid", "Closed"),
    },
    "volunteers": {
        "Active": ("Applied", "Screening", "Active"),
        "Inactive": ("Screening", "Active", "Inactive"),
    },
}

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    module: {final: chain[:-1] for final, chain in paths.items()}
    for module, paths in _STATUS_CHAINS.items()
}

PROTECTED_RECORDS = frozenset({
    "pledges:000001", "donations:000001", "cash_advances:000001", "expense_lines:000001",
    "expense_lines:000002", "expense_lines:000003",
})  # fmt: skip
TARGET_SHARE = 0.40
REASSIGNED_SHARE = 0.25
