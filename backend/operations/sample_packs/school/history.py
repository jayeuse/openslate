"""School workflow status histories and records reserved for named checks."""

_STATUS_CHAINS: dict[str, dict[str, tuple[str, ...]]] = {
    "admission_inquiries": {
        "Contacted": ("New", "Contacted"),
        "Toured": ("New", "Contacted", "Toured"),
        "Applied": ("New", "Contacted", "Toured", "Applied"),
    },
    "applications": {
        "Submitted": ("Started", "Submitted"),
        "Complete": ("Started", "Submitted", "Complete"),
        "Testing and interview": ("Started", "Submitted", "Complete", "Testing and interview"),
        "Decision released": (
            "Started",
            "Submitted",
            "Complete",
            "Testing and interview",
            "Decision released",
        ),
        "Enrolment in process": (
            "Started",
            "Submitted",
            "Complete",
            "Testing and interview",
            "Decision released",
            "Enrolment in process",
        ),
        "Enrolled": (
            "Started",
            "Submitted",
            "Complete",
            "Testing and interview",
            "Decision released",
            "Enrolment in process",
            "Enrolled",
        ),
    },
    "students": {"Enrolled": ("Incoming", "Enrolled")},
    "attendance_exceptions": {
        "Explained": ("Unexplained", "Explained"),
        "Verified": ("Unexplained", "Explained", "Verified"),
        "Amended": ("Unexplained", "Explained", "Verified", "Amended"),
    },
    "courses": {"Active": ("Proposed", "Active")},
    "class_sections": {
        "Submitted": ("Open", "Submitted"),
        "Approved": ("Open", "Submitted", "Approved"),
        "Posted": ("Open", "Submitted", "Approved", "Posted"),
    },
    "assessments": {
        "Assigned": ("Planned", "Assigned"),
        "Collected": ("Planned", "Assigned", "Collected"),
        "Marked": ("Planned", "Assigned", "Collected", "Marked"),
        "Returned": ("Planned", "Assigned", "Collected", "Marked", "Returned"),
    },
    "report_card_batches": {
        "Adviser review": ("Collecting grades", "Adviser review"),
        "Principal sign-off": ("Collecting grades", "Adviser review", "Principal sign-off"),
        "Released": ("Collecting grades", "Adviser review", "Principal sign-off", "Released"),
    },
    "academic_alerts": {
        "Parent notified": ("Raised", "Parent notified"),
        "Intervention": ("Raised", "Parent notified", "Intervention"),
        "Resolved": ("Raised", "Parent notified", "Intervention", "Resolved"),
    },
    "grade_change_requests": {
        "Principal approved": ("Submitted", "Principal approved"),
        "Registrar posted": ("Submitted", "Principal approved", "Registrar posted"),
    },
    "behaviour_incidents": {
        "Under investigation": ("Reported", "Under investigation"),
        "Action assigned": ("Reported", "Under investigation", "Action assigned"),
        "Parent informed": (
            "Reported",
            "Under investigation",
            "Action assigned",
            "Parent informed",
        ),
        "Closed": (
            "Reported",
            "Under investigation",
            "Action assigned",
            "Parent informed",
            "Closed",
        ),
    },
    "guidance_cases": {
        "Intake": ("Referred", "Intake"),
        "Active": ("Referred", "Intake", "Active"),
        "Monitoring": ("Referred", "Intake", "Active", "Monitoring"),
        "Closed": ("Referred", "Intake", "Active", "Monitoring", "Closed"),
    },
    "parent_contacts": {
        "Contacted": ("To contact", "Contacted"),
        "Follow-up due": ("To contact", "Contacted", "Follow-up due"),
        "Done": ("To contact", "Contacted", "Follow-up due", "Done"),
    },
    "clinic_visits": {
        "Disposed": ("Open", "Disposed"),
        "Parent informed": ("Open", "Disposed", "Parent informed"),
        "Closed": ("Open", "Disposed", "Parent informed", "Closed"),
    },
    "health_alerts": {"Active": ("Pending documents", "Active")},
    "fee_items": {"Board approved": ("Draft", "Board approved")},
    "fee_assessments": {
        "Issued": ("Draft", "Issued"),
        "Partially paid": ("Draft", "Issued", "Partially paid"),
        "Paid": ("Draft", "Issued", "Partially paid", "Paid"),
        "Past due": ("Draft", "Issued", "Partially paid", "Past due"),
    },
    "payments": {
        "Deposited": ("Recorded", "Deposited"),
        "Reconciled": ("Recorded", "Deposited", "Reconciled"),
    },
    "fee_adjustments": {
        "Under review": ("Requested", "Under review"),
        "Approved": ("Requested", "Under review", "Approved"),
        "Applied": ("Requested", "Under review", "Approved", "Applied"),
    },
    "collection_cases": {
        "Promise to pay": ("Open", "Promise to pay"),
        "Settled": ("Open", "Promise to pay", "Settled"),
    },
    "maintenance_requests": {
        "Assigned": ("New", "Assigned"),
        "In progress": ("New", "Assigned", "In progress"),
        "Completed": ("New", "Assigned", "In progress", "Completed"),
        "Closed": ("New", "Assigned", "In progress", "Completed", "Closed"),
    },
    "activities": {"Active": ("Proposed", "Approved", "Active")},
    "staff_leave": {
        "Supervisor approved": ("Filed", "Supervisor approved"),
        "HR recorded": ("Filed", "Supervisor approved", "HR recorded"),
    },
}

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    module: {final: chain[:-1] for final, chain in paths.items()}
    for module, paths in _STATUS_CHAINS.items()
}

PROTECTED_RECORDS = frozenset({"fee_assessments:000001", "payments:000001"})
TARGET_SHARE = 0.40
REASSIGNED_SHARE = 0.25
