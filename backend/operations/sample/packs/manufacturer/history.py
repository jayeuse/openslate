"""Sauce plant workflow status histories and records reserved for named checks."""

_ORDER = ("Draft", "Confirmed", "Allocated", "Shipped", "Invoiced", "Closed")
_WO = ("Created", "Released", "In progress", "Completed", "Technically complete", "Closed")
_BATCH = ("Weighing", "Cooking", "Awaiting QA", "Released to filler", "Consumed")
_PO = ("Draft", "Sent", "Confirmed", "Received", "Closed")
_MWO = ("Requested", "Approved", "Scheduled", "In progress", "Completed", "Closed")


def _upto(chain: tuple[str, ...]) -> dict[str, tuple[str, ...]]:
    """Every later state of a straight workflow, reached through the states before it."""
    return {state: chain[: position + 1] for position, state in enumerate(chain) if position}


_STATUS_CHAINS: dict[str, dict[str, tuple[str, ...]]] = {
    "customers": {
        "Active": ("Prospect", "Active"),
        "Credit hold": ("Active", "Credit hold"),
        "Inactive": ("Active", "Inactive"),
    },
    "sales_orders": {
        **_upto(_ORDER),
        "Partially shipped": ("Draft", "Confirmed", "Allocated", "Partially shipped"),
        "On hold": ("Draft", "Confirmed", "On hold"),
        "Cancelled": ("Draft", "Cancelled"),
    },
    "products": {
        "Active": ("Development", "Active"),
        "Phase-out": ("Active", "Phase-out"),
        "Discontinued": ("Active", "Phase-out", "Discontinued"),
    },
    "boms": {
        "Pending approval": ("Draft", "Pending approval"),
        "Active": ("Draft", "Pending approval", "Active"),
        "Superseded": ("Active", "Superseded"),
    },
    "suppliers": {
        "Approved": ("Pending approval", "Approved"),
        "Conditional": ("Pending approval", "Conditional"),
        "Suspended": ("Approved", "Suspended"),
    },
    "purchase_orders": {
        **_upto(_PO),
        "Partially received": ("Draft", "Sent", "Confirmed", "Partially received"),
        "Cancelled": ("Draft", "Cancelled"),
    },
    "production_orders": {
        **_upto(_WO),
        "Partially confirmed": ("Created", "Released", "In progress", "Partially confirmed"),
        "On hold": ("Created", "Released", "On hold"),
        "Cancelled": ("Created", "Cancelled"),
    },
    "material_lots": {
        "Released": ("Quarantine", "Released"),
        "Consumed": ("Quarantine", "Released", "Consumed"),
        "Rejected": ("Quarantine", "Rejected"),
        "On hold": ("Quarantine", "On hold"),
        "Expired": ("Quarantine", "Released", "Expired"),
    },
    "shipments": {
        **_upto(("Planned", "Picking", "Loaded", "Shipped", "Delivered")),
        "Refused": ("Planned", "Picking", "Loaded", "Shipped", "Refused"),
    },
    "batch_records": {
        **_upto(_BATCH),
        "QA hold": ("Weighing", "Cooking", "Awaiting QA", "QA hold"),
        "Reprocess": ("Weighing", "Cooking", "Awaiting QA", "QA hold", "Reprocess"),
        "Destroyed": ("Weighing", "Cooking", "Awaiting QA", "QA hold", "Destroyed"),
    },
    "shift_reports": _upto(("Draft", "Submitted", "Verified")),
    "downtime_events": _upto(("Open", "Coded", "Reviewed")),
    "finished_goods_lots": {
        "Released": ("QA hold, awaiting release", "Released"),
        "Shipped out": ("QA hold, awaiting release", "Released", "Shipped out"),
        "Quality hold": ("QA hold, awaiting release", "Quality hold"),
        "Rework": ("QA hold, awaiting release", "Quality hold", "Rework"),
        "Destroyed": ("QA hold, awaiting release", "Quality hold", "Destroyed"),
        "Recalled": ("QA hold, awaiting release", "Released", "Shipped out", "Recalled"),
    },
    "food_safety_logs": {
        "Completed": ("Open", "Completed"),
        "Verified": ("Open", "Completed", "Verified"),
        "Deviation": ("Open", "Deviation"),
    },
    "ncrs": {
        **_upto(("Open", "Contained", "Under review", "Dispositioned", "Closed")),
        "Voided": ("Open", "Voided"),
    },
    "capas": {
        **_upto(("Open", "Root cause", "Action in progress", "Effectiveness check",
                 "Closed, effective")),  # fmt: skip
        "Reopened": ("Open", "Root cause", "Action in progress", "Effectiveness check",
                     "Reopened"),  # fmt: skip
    },
    "equipment": {
        "Down": ("In service", "Down"),
        "Out of service": ("In service", "Down", "Out of service"),
        "Retired": ("In service", "Retired"),
    },
    "maintenance_work_orders": {
        **_upto(_MWO),
        "Waiting parts": ("Requested", "Approved", "Scheduled", "In progress", "Waiting parts"),
        "Cancelled": ("Requested", "Cancelled"),
    },
    "supplier_invoices": {
        **_upto(("Received", "Matched", "Approved", "Paid")),
        "Exception": ("Received", "Exception"),
        "Disputed": ("Received", "Exception", "Disputed"),
    },
    "customer_invoices": {
        "Issued": ("Draft", "Issued"),
        "Partially paid": ("Draft", "Issued", "Partially paid"),
        "Paid": ("Draft", "Issued", "Paid"),
        "Overdue": ("Draft", "Issued", "Overdue"),
        "Disputed": ("Draft", "Issued", "Disputed"),
        "Credited": ("Draft", "Issued", "Credited"),
    },
    "customer_payments": {"Cleared": ("Applied", "Cleared")},
}

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    module: {final: chain[:-1] for final, chain in paths.items()}
    for module, paths in _STATUS_CHAINS.items()
}

# The named part payment, and the rejected receipt whose create-time rule flags an NCR.
PROTECTED_RECORDS = frozenset(
    {"customer_invoices:000001", "customer_payments:000001", "material_lots:000001"}
)
TARGET_SHARE = 0.40
REASSIGNED_SHARE = 0.25
