"""Foundation rates for the shared realism rules: a Philippine community development NGO."""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

from operations.sample.realism import (
    AmountShape,
    DateCluster,
    DateShape,
    easter_sunday,
    nth_weekday,
)

# R1. Most records sit in the module's normal end state (research §8). Pledges, donors and
# volunteers are reshaped so the end state leads by twice the next status.
STATUS_WEIGHTS: dict[str, dict[str, float]] = {
    "donors": {
        "Active": 56, "Lapsed": 20, "First-time": 12, "Prospect": 6, "Reactivated": 4,
        "Do not contact": 1.5, "Deceased": 0.5,
    },
    "campaigns": {"Closed": 62, "Active": 22, "Planned": 10, "Cancelled": 6},
    "donations": {
        "Posted": 88, "Received": 5, "Pending": 3, "Failed": 2, "Refunded": 1, "Cancelled": 1,
    },
    "pledges": {
        "Completed": 56, "In progress": 22, "Overdue": 9, "Pending": 8, "Cancelled": 3,
        "Written off": 2,
    },
    "organizations": {"Active": 78, "Prospect": 12, "Inactive": 10},
    "grant_awards": {
        "Active": 52, "Closed": 12, "Closing": 8, "Under donor review": 8, "Declined": 7,
        "Proposal submitted": 4, "Concept note submitted": 3, "Identified": 2, "Withdrawn": 2,
        "Awarded – contracting": 2,
    },
    "grant_reports": {
        "Accepted": 60, "Submitted": 14, "In preparation": 9, "Not started": 9,
        "Revision requested": 5, "Overdue": 3,
    },
    "projects": {
        "Implementation": 56, "Closed": 15, "Finalisation": 11, "Pipeline": 10, "Suspended": 5,
        "Cancelled": 3,
    },
    "sites": {"Active": 80, "Assessed": 12, "Inactive": 8},
    "activities": {
        "Completed": 70, "Scheduled": 12, "Planned": 8, "Postponed": 6, "Cancelled": 4,
    },
    "beneficiaries": {
        "Active": 62, "Exited": 15, "Verified": 10, "Pre-registered": 5, "Ineligible": 3,
        "Pending consent": 2, "Duplicate": 2, "Consent withdrawn": 1,
    },
    "assistance": {
        "Verified": 60, "Delivered": 24, "Not delivered": 6, "Validated": 5, "Disputed": 3,
        "Reversed": 1, "Planned": 1,
    },
    "indicators": {"Active": 78, "Approved": 10, "Draft": 7, "Retired": 5},
    "feedback_cases": {
        "Closed": 65, "Resolved": 12, "Under review": 10, "Acknowledged": 6, "Received": 4,
        "Escalated": 3,
    },
    "cash_advances": {
        "Closed": 60, "Fully liquidated": 12, "Released": 9, "Partially liquidated": 8,
        "Overdue": 5, "Refund due": 3, "Rejected": 1.5, "Requested": 1, "Approved": 0.5,
    },
    "funds": {"Active": 70, "Closed": 12, "Frozen": 8, "Fully spent": 6, "Open": 4},
    "expense_lines": {
        "Posted": 75, "Approved": 10, "Checked": 5, "Submitted": 5, "Returned": 3,
        "Disallowed": 2,
    },
    "disbursements": {
        "Cleared": 80, "Released": 8, "Approved": 4, "For approval": 4, "On hold": 2,
        "Voided": 2,
    },
    "suppliers": {"Active": 70, "Accredited": 15, "Prospective": 9, "Suspended": 4,
                  "Excluded": 2},
    "volunteers": {"Active": 60, "Inactive": 22, "Screening": 7, "Applied": 6,
                   "Offboarded": 3, "Declined": 2},
}  # fmt: skip
# Results of the latest period are still being checked; older periods are reported.
LATEST_RESULT = {"Verified": 35, "Submitted": 30, "Draft": 20, "Reported": 10,
                 "Returned for correction": 5}  # fmt: skip
OLDER_RESULT = {"Reported": 88, "Verified": 8, "Returned for correction": 2, "Submitted": 2}
# Requests that never became an order.
OPEN_REQUEST = {"Sourcing": 25, "Approved": 20, "Submitted": 15, "Cancelled": 15,
                "Rejected": 12, "Returned": 8, "Budget checked": 5}  # fmt: skip

# R2. Amounts in pesos: gifts cluster on 500, 1,000 and 5,000; budgets are round.
GIFT = AmountShape(1_500, sigma=1.1, round_share=0.45, cents_share=0.05)
IN_KIND = AmountShape(8_000, sigma=1.0, round_share=0.3, cents_share=0.2)
PLEDGE = AmountShape(60_000, sigma=1.05, round_share=0.6)
GRANT_REQUEST = AmountShape(4_500_000, sigma=0.9, round_share=0.6, minimum=250_000)
BUDGET_LINE = AmountShape(180_000, sigma=1.0, round_share=0.5, minimum=5_000)
ADVANCE = AmountShape(18_000, sigma=0.95, round_share=0.55, minimum=1_000)
EXPENSE = AmountShape(2_400, sigma=1.0, round_share=0.25, cents_share=0.5, minimum=20)
REQUEST = AmountShape(35_000, sigma=1.2, round_share=0.4, minimum=500)
OTHER_PAYMENT = AmountShape(65_000, sigma=0.9, round_share=0.3, cents_share=0.4)
FUND = AmountShape(1_500_000, sigma=0.8, round_share=0.6, minimum=50_000)
MONTHLY_TIERS = (300, 500, 500, 1_000, 1_000, 1_000, 2_000, 5_000)
# Price per item of a distribution or service (tiers set by the logistics plan).
ITEM_VALUES = {
    "Food pack": 650, "Hygiene kit": 1_200, "Shelter repair kit": 4_500, "Sleeping kit": 1_500,
    "Kitchen set": 950, "Water filter": 1_800, "Solar lamp": 1_250,
    "Multipurpose cash – tranche 1": 5_000, "Multipurpose cash – tranche 2": 3_000,
    "School kit": 850, "Seeds and tools pack": 1_400, "Fishing gear pack": 6_500,
    "Dignity kit": 700, "Starter kit": 7_500, "Seed capital grant": 10_000,
    "Skills training certificate": 2_500, "Tuition subsidy": 6_000, "Tutoring package": 1_500,
    "Psychosocial session": 500, "Referral": 0,
}  # fmt: skip

# Amounts the foundation computes from other records: paid and open balances, liquidations,
# vouchers that repeat an advance or an order, and orders priced from their request.
COMPUTED_AMOUNTS = frozenset({
    "pledges.amount_paid", "pledges.balance_due", "grant_awards.amount_awarded",
    "budget_lines.actual_to_date", "budget_lines.committed", "cash_advances.amount_liquidated",
    "cash_advances.balance", "disbursements.amount", "purchase_orders.amount",
})  # fmt: skip
TIERED_AMOUNTS = frozenset({"assistance.unit_value"})
NOT_AMOUNTS: frozenset[str] = frozenset()
# Every one-to-many link here leaves some parents without children (rule R5).
STRUCTURAL_LINKS: frozenset[str] = frozenset()


def philippine_holidays(year: int) -> set[date]:
    """Regular holidays and the common special non-working days (Proclamation lists)."""
    easter = easter_sunday(year)
    fixed = ((1, 1), (4, 9), (5, 1), (6, 12), (8, 21), (11, 1), (11, 2), (11, 30), (12, 8),
             (12, 24), (12, 25), (12, 30), (12, 31))  # fmt: skip
    return {
        *(date(year, month, day) for month, day in fixed),
        easter - timedelta(days=3),  # Maundy Thursday
        easter - timedelta(days=2),  # Good Friday
        easter - timedelta(days=1),  # Black Saturday
        nth_weekday(year, 8, 0, -1),  # National Heroes Day
    }


@lru_cache(maxsize=8)
def holidays(anchor: date) -> frozenset[date]:
    return frozenset().union(*(philippine_holidays(anchor.year + offset) for offset in (-1, 0, 1)))


# R3. Typhoons peak from July to October (research §12) and lift registrations,
# distributions, advances and purchases; year-end giving peaks in December.
_TYPHOON = {7: 1.4, 8: 1.8, 9: 2.0, 10: 1.6, 11: 1.1, 12: 0.8, 1: 0.8}
_GIVING = {11: 1.5, 12: 2.4, 1: 0.8, 8: 1.2, 9: 1.2}
_AUDIT = {2: 1.3, 3: 1.4, 4: 1.2}
SEASONS: dict[str, dict[int, float]] = {
    "donations": _GIVING, "pledges": {11: 1.3, 12: 1.6}, "donors": _GIVING,
    "beneficiaries": _TYPHOON, "assistance": _TYPHOON, "activities": _TYPHOON,
    "cash_advances": _TYPHOON, "expense_lines": _TYPHOON, "purchase_requests": _TYPHOON,
    "purchase_orders": _TYPHOON, "disbursements": _TYPHOON, "volunteers": _TYPHOON,
    "feedback_cases": _TYPHOON, "grant_reports": _AUDIT, "suppliers": _AUDIT,
}  # fmt: skip
GO_LIVE_SHARE = 0.04


@lru_cache(maxsize=512)
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
    "resource_mobilization": ("Ideas", "Drafting", "Approval", "Live", "Thanked"),
    "grants_partnerships": ("Pipeline", "Writing", "Internal review", "Submitted", "Decided"),
    "programs": ("To plan", "Preparing", "In the field", "Reporting", "Done"),
    "meal": ("To collect", "Cleaning", "Verifying", "Reported"),
    "finance": ("To do", "Checking", "For approval", "Posted"),
    "procurement": ("Requested", "Quotes", "PO issued", "Delivered", "Closed"),
    "volunteer_engagement": ("Recruiting", "Screening", "Scheduled", "Thanked"),
    "executive_office": ("For the agenda", "In progress", "Board review", "Done"),
}
BOARD_OBJECTIVES: dict[str, tuple[str, ...]] = {
    "resource_mobilization": ("Draft the year-end appeal letter", "Clean up lapsed donor emails",
                              "Plan the donor thank-you calls week", "Refresh the giving page",
                              "Send the monthly givers update", "Prepare the Harvest Dinner"),
    "grants_partnerships": ("Finish the bilateral DRR concept note", "Send the Q3 interim report",
                            "Renew the partner MOUs", "Check the realignment request",
                            "Book the donor monitoring visit"),
    "programs": ("Pre-position the food packs", "Validate the Round 3 list",
                 "Plan the livelihood graduation", "Book boats for the island sites",
                 "Refresh the evacuation drill plan", "Train the new facilitators"),
    "meal": ("Run the post-distribution survey", "Clean the KoBo exports",
             "Prepare the quarterly data review", "Update the indicator tracker",
             "Visit two sites for data quality"),
    "finance": ("List the advances over 30 days", "Close the month", "Prepare the audit files",
                "Reconcile the appeal bank account", "Count the petty cash"),
    "procurement": ("Open the RFQ for shelter kits", "Renew supplier accreditation",
                    "Inspect the warehouse stock", "Compare trucking quotes",
                    "Update the price list"),
    "volunteer_engagement": ("Fill the weekend repacking shifts", "Book the first aid refresher",
                             "Plan the volunteer appreciation night",
                             "Check the background clearances"),
    "executive_office": ("Prepare the quarterly board pack", "Review the reserves policy",
                         "Renew the DSWD accreditation", "Brief the board on the typhoon response",
                         "Review the safeguarding policy"),
}  # fmt: skip
