"""Clinic workflow status histories (FHIR R4 paths) and records reserved for named checks."""

_STATUS_CHAINS: dict[str, dict[str, tuple[str, ...]]] = {
    "patients": {"Inactive": ("Active", "Inactive"), "Merged": ("Active", "Merged")},
    "coverages": {"Active": ("Draft", "Active"), "Cancelled": ("Draft", "Active", "Cancelled")},
    "appointments": {
        "Arrived": ("Booked", "Arrived"),
        "Checked in": ("Booked", "Arrived", "Checked in"),
        "Fulfilled": ("Booked", "Arrived", "Checked in", "Fulfilled"),
        "No-show": ("Booked", "No-show"),
        "Cancelled": ("Booked", "Cancelled"),
    },
    "encounters": {
        "Triaged": ("Arrived", "Triaged"),
        "In progress": ("Arrived", "Triaged", "In progress"),
        "Finished": ("Arrived", "Triaged", "In progress", "Finished"),
    },
    "orders": {"Completed": ("Active", "Completed"), "Revoked": ("Active", "Revoked")},
    "prescriptions": {
        "Completed": ("Active", "Completed"),
        "Stopped": ("Active", "Stopped"),
        "On hold": ("Active", "On hold"),
    },
    "specimens": {
        "Received": ("Collected", "Received"),
        "Available": ("Collected", "Received", "Available"),
        "Unsatisfactory": ("Collected", "Received", "Unsatisfactory"),
    },
    "lab_results": {
        "Final": ("Preliminary", "Final"),
        "Amended": ("Preliminary", "Final", "Amended"),
        "Corrected": ("Preliminary", "Final", "Corrected"),
    },
    "lab_qc_runs": {
        "Passed": ("Pending", "Passed"),
        "Repeated and passed": ("Pending", "Failed", "Repeated and passed"),
    },
    "dispenses": {
        "In progress": ("Preparation", "In progress"),
        "Completed": ("Preparation", "In progress", "Completed"),
        "Cancelled": ("Preparation", "In progress", "Cancelled"),
    },
    "stock_lots": {
        "Depleted": ("Available", "Depleted"),
        "Quarantined": ("Available", "Quarantined"),
        "Expired": ("Available", "Expired"),
    },
    "temperature_logs": {"Excursion resolved": ("Excursion", "Excursion resolved")},
    "claims": {
        "Submitted": ("Draft", "Submitted"),
        "Pending": ("Draft", "Submitted", "Pending"),
        "Paid": ("Draft", "Submitted", "Pending", "Paid"),
        "Partially paid": ("Draft", "Submitted", "Pending", "Partially paid"),
        "Denied": ("Draft", "Submitted", "Denied"),
        "Resubmitted": ("Draft", "Submitted", "Denied", "Resubmitted"),
        "Written off": ("Draft", "Submitted", "Denied", "Written off"),
    },
    "claim_responses": {"Posted": ("Received", "Posted")},
    "payments": {"Posted": ("Pending", "Posted"), "Refunded": ("Pending", "Posted", "Refunded")},
    "purchase_requests": {
        "Submitted": ("Draft", "Submitted"),
        "Approved": ("Draft", "Submitted", "Approved"),
        "Converted to PO": ("Draft", "Submitted", "Approved", "Converted to PO"),
        "Rejected": ("Draft", "Submitted", "Rejected"),
    },
    "purchase_orders": {
        "Sent": ("Draft", "Approved", "Sent"),
        "Partially received": ("Draft", "Approved", "Sent", "Partially received"),
        "Received": ("Draft", "Approved", "Sent", "Received"),
        "Closed": ("Draft", "Approved", "Sent", "Received", "Closed"),
    },
    "equipment": {
        "Due for service": ("In service", "Due for service"),
        "Out of service": ("In service", "Out of service"),
        "Under repair": ("In service", "Out of service", "Under repair"),
        "Retired": ("In service", "Retired"),
    },
    "maintenance_work_orders": {
        "Scheduled": ("Open", "Scheduled"),
        "In progress": ("Open", "Scheduled", "In progress"),
        "Completed": ("Open", "Scheduled", "In progress", "Completed"),
        "Awaiting parts": ("Open", "Scheduled", "In progress", "Awaiting parts"),
    },
    "incident_reports": {
        "Under review": ("Reported", "Under review"),
        "Action plan": ("Reported", "Under review", "Action plan"),
        "Closed": ("Reported", "Under review", "Action plan", "Closed"),
    },
    "staff_credentials": {
        "Verified": ("Pending verification", "Verified"),
        "Expiring soon": ("Pending verification", "Verified", "Expiring soon"),
        "Renewed": ("Verified", "Expiring soon", "Renewed"),
        "Expired": ("Verified", "Expiring soon", "Expired"),
    },
}

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    module: {final: chain[:-1] for final, chain in paths.items()}
    for module, paths in _STATUS_CHAINS.items()
}

PROTECTED_RECORDS = frozenset({"claims:000001", "payments:000001"})
TARGET_SHARE = 0.40
REASSIGNED_SHARE = 0.25
