"""Clinic rates for the shared realism rules: a US multi-specialty outpatient clinic."""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

from operations.sample.realism import AmountShape, DateCluster, DateShape, nth_weekday

# R1. Most records sit in the module's normal end state (research §8); the rest form a tail.
STATUS_WEIGHTS: dict[str, dict[str, float]] = {
    "patients": {"Active": 91, "Inactive": 6, "Merged": 2, "Entered in error": 1},
    "coverages": {"Active": 84, "Cancelled": 9, "Draft": 5, "Entered in error": 2},
    "payers": {"Active": 92, "Inactive": 8},
    # Appointments and encounters are drawn from their visit: see generation.py.
    "orders": {"Completed": 88, "Active": 8, "Revoked": 3, "Entered in error": 1},
    "prescriptions": {
        "Active": 62, "Completed": 28, "Stopped": 5, "Cancelled": 3, "On hold": 1,
        "Entered in error": 1,
    },
    "lab_qc_runs": {"Passed": 95, "Repeated and passed": 4, "Failed": 1},
    "dispenses": {
        "Completed": 90, "In progress": 4, "Declined": 3, "Cancelled": 2, "On hold": 1,
    },
    "pharmacy_items": {"Active": 88, "Inactive": 8, "Discontinued": 4},
    "stock_lots": {
        "Available": 74, "Depleted": 14, "Quarantined": 5, "Expired": 5, "Recalled": 2,
    },
    "temperature_logs": {"In range": 98, "Excursion resolved": 1.5, "Excursion": 0.5},
    "claim_responses": {"Posted": 88, "Received": 9, "Disputed": 3},
    "payments": {"Posted": 96, "Pending": 2, "Refunded": 1, "Voided": 1},
    "suppliers": {"Active": 84, "On hold": 10, "Inactive": 6},
    "purchase_orders": {
        "Closed": 65, "Received": 15, "Sent": 12, "Partially received": 6, "Cancelled": 2,
    },
    "equipment": {
        "In service": 80, "Due for service": 9, "Under repair": 5, "Out of service": 4,
        "Retired": 2,
    },
    "maintenance_work_orders": {
        "Completed": 82, "Scheduled": 9, "Awaiting parts": 4, "Open": 3, "In progress": 1,
        "Cancelled": 1,
    },
    "incident_reports": {"Closed": 60, "Action plan": 15, "Under review": 15, "Reported": 10},
    "staff_credentials": {
        "Verified": 85, "Expiring soon": 8, "Renewed": 4, "Pending verification": 2,
        "Expired": 1,
    },
}  # fmt: skip
# Status mixes that a linked record decides (research §8).
APPOINTMENT_UNSEEN = {"No-show": 11, "Cancelled": 9, "Booked": 6, "Entered in error": 0.5}
ENCOUNTER_OPEN = {"In progress": 1.5, "Triaged": 1, "Cancelled": 1.5, "Entered in error": 1}
SPECIMEN_PENDING = {"Received": 45, "Collected": 30, "Unsatisfactory": 13, "Unavailable": 12}
# A claim's outcome class decides its status, its response and its payer payment.
CLAIM_CLASSES = {
    "Paid": 70, "Partially paid": 8, "Submitted": 6, "Pending": 6, "Denied": 5,
    "Resubmitted": 2, "Returned for correction": 1, "Written off": 1, "Draft": 1,
}  # fmt: skip
PAID_CLASSES = frozenset({"Paid", "Partially paid"})
DECIDED_CLASSES = frozenset(
    {"Paid", "Partially paid", "Denied", "Resubmitted", "Returned for correction", "Written off"}
)

# R2. Charges follow a long tail; copays follow each plan's fixed tiers.
CHARGE = AmountShape(210, sigma=0.8, round_share=0.1, cents_share=0.5)
PACK_PRICE = AmountShape(16, sigma=0.9, round_share=0.12, cents_share=0.7, minimum=1)
LOT_COST = AmountShape(11, sigma=0.9, round_share=0.1, cents_share=0.7, minimum=1)
PO_TOTAL = AmountShape(1_850, sigma=1.0, round_share=0.1, cents_share=0.5)
WO_COST = AmountShape(180, sigma=1.0, round_share=0.15, cents_share=0.3)
COPAY_TIERS = (0, 20, 25, 30, 40, 50, 75)

# Amounts the clinic computes from others: what a payer allowed and paid, and balances.
COMPUTED_AMOUNTS = frozenset({
    "claims.paid_total", "claims.balance", "claim_responses.allowed_amount",
    "claim_responses.paid_amount", "claim_responses.patient_share", "payments.amount",
})  # fmt: skip
# Amounts from a plan's fixed schedule: round numbers, but no long tail.
TIERED_AMOUNTS = frozenset({"coverages.copay"})
NOT_AMOUNTS: frozenset[str] = frozenset()
# Every one-to-many link here leaves some parents without children (rule R5).
STRUCTURAL_LINKS: frozenset[str] = frozenset()


def us_federal_holidays(year: int) -> set[date]:
    """US federal holidays, moved to the observed weekday when they fall on a weekend."""

    def observed(day: date) -> date:
        if day.weekday() == 5:
            return day - timedelta(days=1)
        if day.weekday() == 6:
            return day + timedelta(days=1)
        return day

    return {
        observed(date(year, 1, 1)),
        nth_weekday(year, 1, 0, 3),  # Martin Luther King Jr. Day
        nth_weekday(year, 2, 0, 3),  # Washington's Birthday
        nth_weekday(year, 5, 0, -1),  # Memorial Day
        observed(date(year, 6, 19)),  # Juneteenth
        observed(date(year, 7, 4)),
        nth_weekday(year, 9, 0, 1),  # Labor Day
        nth_weekday(year, 10, 0, 2),  # Columbus Day
        observed(date(year, 11, 11)),  # Veterans Day
        nth_weekday(year, 11, 3, 4),  # Thanksgiving Day
        observed(date(year, 12, 25)),
    }


@lru_cache(maxsize=8)
def holidays(anchor: date) -> frozenset[date]:
    return frozenset().union(*(us_federal_holidays(anchor.year + offset) for offset in (-1, 0, 1)))


# R3. Flu season (research §12): respiratory visits rise from mid-November to February,
# and summer is quieter. Year-end brings physicals and benefit use before January.
_FLU = {10: 1.1, 11: 1.3, 12: 1.4, 1: 1.45, 2: 1.25, 3: 1.05, 6: 0.9, 7: 0.8, 8: 0.85}
_YEAR_END = {11: 1.15, 12: 1.3, 1: 0.85}
SEASONS: dict[str, dict[int, float]] = {
    "appointments": _FLU, "encounters": _FLU, "patients": _FLU, "orders": _FLU,
    "prescriptions": _FLU, "specimens": _FLU, "lab_results": _FLU, "dispenses": _FLU,
    "claims": _YEAR_END, "payments": _YEAR_END, "purchase_requests": {10: 1.2, 11: 1.3},
    "stock_lots": {9: 1.3, 10: 1.4, 11: 1.2},
}  # fmt: skip
GO_LIVE_SHARE = 0.04


@lru_cache(maxsize=256)
def date_cluster(module_key: str, anchor: date, earliest: int, latest: int) -> DateCluster:
    return DateCluster(
        DateShape(
            start=anchor + timedelta(days=earliest),
            end=anchor + timedelta(days=latest),
            holidays=holidays(anchor),
            seasons=SEASONS.get(module_key, {}),
            go_live_share=GO_LIVE_SHARE,
        )
    )


# R9. Every department board has a Kanban whose stages fit the department's work.
BOARD_STAGES: dict[str, tuple[str, ...]] = {
    "patient_access": ("To call", "Waiting on patient", "Insurance check", "Scheduled", "Done"),
    "clinical": ("Proposed", "Planning", "In progress", "Review", "Done"),
    "laboratory": ("Requested", "In progress", "Validation", "Signed off"),
    "pharmacy": ("To order", "Ordered", "Received", "Shelved"),
    "revenue_cycle": ("To work", "Appealed", "Waiting on payer", "Resolved"),
    "operations": ("Requested", "Quoted", "Ordered", "Delivered", "Closed"),
    "quality": ("Reported", "Investigating", "Action plan", "Closed"),
}
BOARD_OBJECTIVES: dict[str, tuple[str, ...]] = {
    "patient_access": ("Update the no-show callback script", "Post the holiday hours",
                       "Clean up duplicate patient records", "Train the new front desk hire",
                       "Check the insurance card scanner", "Review the waitlist"),
    "clinical": ("Plan the Saturday flu clinics", "Update the triage vitals procedure",
                 "Publish the holiday on-call roster", "Book the BLS refresher",
                 "Restock the procedure room", "Review the standing orders"),
    "laboratory": ("Submit the proficiency testing results", "Book the analyzer service visit",
                   "Update the critical-value call list", "Move the courier pickup to 15:30",
                   "Review the monthly QC charts"),
    "pharmacy": ("Plan the year-end stock count", "Run the monthly expiry sweep",
                 "Find a substitute for the backordered inhaler",
                 "File the lot recall paperwork", "Check the fridge data loggers"),
    "revenue_cycle": ("Work the top five denial reasons", "Load the January fee schedules",
                      "Send the 60-day filing reminders", "Reconcile the weekly ERA batch",
                      "Close the month-end books"),
    "operations": ("Run the generator load check", "Plan the quarterly maintenance week",
                   "Review the new glove supplier", "Schedule the fire drill",
                   "Replace the waiting room chairs"),
    "quality": ("Raise the hand-hygiene score to 90%", "Present the Q3 incident trends",
                "Send the privacy refresher", "Prepare the mock accreditation survey",
                "Walk round with infection control"),
}  # fmt: skip
