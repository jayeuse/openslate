"""Harbor status transitions and records protected by named scenarios."""

STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    "customers": {"Active": ("Prospect",), "On hold": ("Prospect", "Active")},
    "quotes": {"Sent": ("Draft",), "Accepted": ("Draft", "Sent"),
               "Expired": ("Draft", "Sent"), "Cancelled": ("Draft",)},
    "sales_orders": {"Confirmed": ("Draft",), "Partially fulfilled": ("Draft", "Confirmed"),
                     "Complete": ("Draft", "Confirmed", "Partially fulfilled"),
                     "Cancelled": ("Draft",)},
    "service_contracts": {"Renewal due": ("Active",), "Expired": ("Active", "Renewal due"),
                          "Cancelled": ("Active",)},
    "service_requests": {"In progress": ("Open",), "Overdue": ("Open", "In progress"),
                         "Resolved": ("Open", "In progress"), "Cancelled": ("Open",)},
    "equipment": {"Needs service": ("Operational",), "Retired": ("Operational",)},
    "work_orders": {"Scheduled": ("Open",), "Overdue": ("Open", "Scheduled"),
                    "In progress": ("Open", "Scheduled"),
                    "Completed": ("Open", "Scheduled", "In progress"), "Cancelled": ("Open",)},
    "stock_counts": {"Variance found": ("Open",), "Reconciled": ("Open", "Variance found")},
    "purchase_orders": {"Confirmed": ("Draft",), "Partially received": ("Draft", "Confirmed"),
                        "Received": ("Draft", "Confirmed"), "Delayed": ("Draft", "Confirmed"),
                        "Cancelled": ("Draft",)},
    "purchase_lines": {"Partially received": ("Open",), "Received": ("Open",),
                       "Cancelled": ("Open",)},
    "invoices": {"Issued": ("Draft",), "Partially paid": ("Draft", "Issued"),
                 "Paid": ("Draft", "Issued"), "Overdue": ("Draft", "Issued"),
                 "Disputed": ("Draft", "Issued"), "Cancelled": ("Draft",)},
    "payments": {"Posted": ("Pending",)},
    "expenses": {"Approved": ("Submitted",), "Rejected": ("Submitted",),
                 "Reimbursed": ("Submitted", "Approved")},
    "credit_notes": {"Approved": ("Draft",), "Issued": ("Draft", "Approved"),
                     "Cancelled": ("Draft",)},
}  # fmt: skip
# Records that named business cases or named automation checks depend on.
_PROTECTED = frozenset(
    {"invoices:000001", "payments:000001", "sales_orders:000001", "customers:000001",
     "quotes:000001", "work_orders:000001", "stock_movements:000001"}
)  # fmt: skip
_TARGET_SHARE = 0.40
_REASSIGNED_SHARE = 0.25
