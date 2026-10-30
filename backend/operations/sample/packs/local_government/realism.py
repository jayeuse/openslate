"""City government rates for the shared realism rules: a Philippine city of about 100,000."""

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

# R1. Most records sit in the module's normal end state (research §8); the rest form a tail.
# Statuses that a linked record decides are drawn in ``states``.
STATUS_WEIGHTS: dict[str, dict[str, float]] = {
    "business_inspections": {
        "Complied": 58, "With findings": 16, "Failed": 9, "Scheduled": 9,
        "Not found or closed": 5, "Cancelled": 3,
    },
    "enforcement_notices": {
        "Complied": 55, "Served": 15, "Escalated": 10, "Lifted": 8, "Draft": 7, "Cancelled": 5,
    },
    "building_inspections": {
        "Passed": 62, "Passed with notes": 14, "Failed, correction required": 7, "Scheduled": 7,
        "Re-inspection scheduled": 5, "Cancelled": 3, "Stop-work issued": 2,
    },
    "work_orders": {
        "Completed": 64, "Verified": 18, "Planned": 6, "On hold for materials": 4,
        "Dispatched": 3, "Cancelled": 3, "On site": 2,
    },
    "deposit_reports": {
        "Reconciled": 74, "Deposited": 14, "Submitted": 6, "Discrepancy": 3, "Draft": 3,
    },
    "payment_releases": {
        "Cleared": 72, "Released": 16, "Signed": 5, "Prepared": 3, "Stale": 2, "Cancelled": 2,
    },
    "appropriations": {"Enacted": 86, "Closed": 7, "Reenacted": 4, "Proposed": 3},
    "obligation_requests": {
        "Obligated": 82, "Certified": 5, "Filed": 4, "Returned, insufficient allotment": 4,
        "Returned, wrong account code": 3, "Cancelled": 2,
    },
    "suppliers": {"Active": 82, "Inactive": 12, "Suspended": 4, "Blacklisted": 2},
    "bids": {"Opened": 93, "Withdrawn": 4, "Returned unopened": 3},
    "communications": {
        "Filed": 70, "Acted": 14, "In action": 6, "Routed": 5, "Received": 2, "Returned": 2,
        "Duplicate": 1,
    },
    "legislative_measures": {
        "Signed": 58, "In committee": 13, "Committee report": 5, "First reading and referred": 5,
        "Laid on the table": 5, "Second reading": 4, "Withdrawn": 3, "Vetoed": 2,
        "Transmitted to the Mayor": 2, "Deemed approved": 2, "Approved on third reading": 1,
    },
    "civil_registry": {
        "Transmitted to national registry": 66, "Registered": 14, "Posted for 10 days": 6,
        "Reviewed": 5, "Received": 4, "For correction": 4, "Rejected": 1,
    },
}  # fmt: skip
# The share of each pipeline that has not reached its linked end state yet.
APPLICATION_OPEN = {"Returned for compliance": 4, "Filed": 2, "Verified": 2, "Disapproved": 1,
                    "Withdrawn": 1}  # fmt: skip
APPLICATION_DONE = {"Released": 92, "Approved": 5, "Paid": 3}
PERMIT_DORMANT = {"Returned for compliance": 45, "Received": 40, "Disapproved": 15}
PERMIT_ACTIVE = {
    "Permit issued": 62, "Under construction": 12, "Under evaluation": 6, "For payment": 5,
    "Completed": 5, "Paid": 2, "Expired": 2, "Site inspected": 2, "Returned for compliance": 3,
    "Deemed approved": 1,
}  # fmt: skip
REQUEST_UNASSIGNED = {
    "Fixed": 40, "Duplicate": 14, "Not responsible": 10, "Acknowledged": 8, "New": 7,
    "Investigating": 6, "No further action": 6, "Internal referral": 4, "Reopened": 3,
    "Action scheduled": 2,
}  # fmt: skip
OOP_CLASSES = {"Paid": 77, "Partially paid": 8, "Unpaid": 8, "Reassessed": 4, "Cancelled": 3}
VOUCHER_OPEN = {
    "Received": 25, "Pre-audited": 20, "Returned for incomplete documents": 20,
    "Certified by accountant": 15, "Funds certified": 10, "Disallowed in pre-audit": 5,
    "Cancelled": 5,
}  # fmt: skip
REQUEST_PENDING = {"Returned": 20, "Approved": 18, "Submitted": 18, "Draft": 12,
                   "Cancelled": 12, "Budget-cleared": 10, "Endorsed to BAC": 10}  # fmt: skip
PROJECT_CLASSES = {"awarded": 82, "evaluation": 7, "failed": 5, "early": 3, "cancelled": 3}
PURCHASE_ORDER_CLASSES = {"delivered": 88, "issued": 9, "terminated": 3}

# R2. Typed amounts follow a long tail; the others are computed from linked records.
ESTIMATED_COST = AmountShape(850_000, sigma=1.1, round_share=0.3, minimum=20_000)
DECLARED_GROSS = AmountShape(1_200_000, sigma=1.2, round_share=0.2, cents_share=0.3,
                             minimum=50_000)  # fmt: skip
APPROPRIATED = AmountShape(2_500_000, sigma=1.3, round_share=0.4, minimum=50_000)
ABC = AmountShape(450_000, sigma=0.6, round_share=0.45, minimum=5_000)
PAYROLL = AmountShape(1_800_000, sigma=0.5, round_share=0.02, cents_share=0.9)
UTILITIES = AmountShape(120_000, sigma=0.7, round_share=0.02, cents_share=0.9)
TRAVEL = AmountShape(9_000, sigma=0.8, round_share=0.4, cents_share=0.2, minimum=500)
OTHER_OBLIGATION = AmountShape(60_000, sigma=1.1, round_share=0.3, cents_share=0.3)

# Amounts the city computes from others: assessments from fee schedules, receipts from
# their orders of payment, and the procurement chain from the approved budget.
COMPUTED_AMOUNTS = frozenset({
    "payment_orders.amount_due", "payment_orders.balance", "official_receipts.amount",
    "deposit_reports.total_collected", "deposit_reports.deposited_amount",
    "payment_releases.net_amount", "appropriations.allotted_amount",
    "disbursement_vouchers.gross_amount", "disbursement_vouchers.net_amount",
    "procurement_projects.abc_total", "bids.bid_amount", "purchase_orders.amount",
})  # fmt: skip
TIERED_AMOUNTS: frozenset[str] = frozenset()
NOT_AMOUNTS: frozenset[str] = frozenset()
# Every one-to-many link here leaves some parents without children (rule R5).
STRUCTURAL_LINKS: frozenset[str] = frozenset()


def philippine_holidays(year: int) -> set[date]:
    """Regular holidays and special non-working days, plus the city's charter day."""
    easter = easter_sunday(year)
    fixed = ((1, 1), (2, 25), (4, 9), (5, 1), (6, 12), (8, 21), (9, 15), (11, 1), (11, 2),
             (11, 30), (12, 8), (12, 24), (12, 25), (12, 30), (12, 31))  # fmt: skip
    return {
        *(date(year, month, day) for month, day in fixed),
        easter - timedelta(days=3),  # Maundy Thursday
        easter - timedelta(days=2),  # Good Friday
        nth_weekday(year, 8, 0, -1),  # National Heroes Day
    }


@lru_cache(maxsize=8)
def holidays(anchor: date) -> frozenset[date]:
    return frozenset().union(*(philippine_holidays(anchor.year + offset) for offset in (-1, 0, 1)))


# R3. The January renewal peak (research §12), quarterly tax installments in the first
# weeks of April, July and October, the June-November rains, and the year-end rush.
_RAINS = {6: 1.5, 7: 1.8, 8: 1.9, 9: 1.8, 10: 1.6, 11: 1.3, 12: 0.8, 1: 0.7, 2: 0.6, 3: 0.6,
          4: 0.7, 5: 0.8}  # fmt: skip
_DRY_SEASON = {1: 1.2, 2: 1.3, 3: 1.4, 4: 1.4, 5: 1.2, 7: 0.8, 8: 0.7, 9: 0.7, 12: 0.8}
SEASONS: dict[str, dict[int, float]] = {
    "renewals": {1: 14.0, 2: 1.4, 12: 1.6, 3: 0.6, 4: 0.6, 5: 0.5, 6: 0.5, 7: 0.5, 8: 0.5,
                 9: 0.5, 10: 0.5, 11: 0.6},
    "new_businesses": {1: 1.6, 2: 1.2, 6: 1.1, 12: 0.7},
    "drainage": {month: weight ** 2 for month, weight in _RAINS.items()},
    "service_requests": _RAINS,
    "building_permits": _DRY_SEASON,
    "purchase_requests": {1: 1.3, 2: 1.4, 3: 1.3, 10: 1.4, 11: 1.5, 12: 0.7},
    "obligation_requests": {11: 1.4, 12: 1.6},
    "communications": {6: 1.1, 7: 1.2, 8: 1.2, 9: 1.2, 10: 1.1, 12: 0.8},
    "legislative_measures": {10: 1.4, 11: 1.5, 12: 1.6, 1: 0.8},
    "marriages": {2: 2.0, 5: 1.6, 6: 1.8, 12: 1.7, 4: 0.6, 9: 0.7},
    "business_inspections": {2: 1.6, 3: 1.7, 4: 1.3, 1: 0.5, 12: 0.6},
}  # fmt: skip
GO_LIVE_SHARE = 0.03


@lru_cache(maxsize=256)
def date_cluster(season: str, anchor: date, earliest: int, latest: int) -> DateCluster:
    return DateCluster(
        DateShape(
            start=anchor + timedelta(days=earliest),
            end=anchor + timedelta(days=latest),
            holidays=holidays(anchor),
            seasons=SEASONS.get(season, {}),
            go_live_share=GO_LIVE_SHARE,
        )
    )


# R9. Every department board has a Kanban whose stages fit the office's work.
BOARD_STAGES: dict[str, tuple[str, ...]] = {
    "bplo": ("To verify", "For inspection", "Waiting on business", "Released"),
    "building_official": ("Received", "Evaluation", "Site visit", "For signing", "Done"),
    "public_works": ("Reported", "Scheduled", "Crew on site", "Done"),
    "treasury": ("To do", "In progress", "For signature", "Done"),
    "budget_accounting": ("To review", "Pre-audit", "Returned to office", "Cleared"),
    "procurement": ("Request", "Posting", "Evaluation", "Award", "Delivered"),
    "city_clerk": ("Received", "Routed", "For agenda", "Filed"),
}
BOARD_OBJECTIVES: dict[str, tuple[str, ...]] = {
    "bplo": ("Open the extra renewal windows in January", "Post the list of renewal requirements",
             "Schedule the joint inspections by barangay", "Update the negative list",
             "Send delinquency notices for unpaid business tax"),
    "building_official": ("Publish the updated schedule of fees", "Hold the contractors' seminar",
                          "Clear the evaluation backlog", "Check deemed-approved applications",
                          "Inspect the reported illegal construction"),
    "public_works": ("Run the pothole blitz week", "Desilt the canals before the rains",
                     "Replace the streetlights on the national road",
                     "Restock cold-mix asphalt", "Post the hotline on the city page"),
    "treasury": ("Prepare the extra collection windows for January",
                 "Remind taxpayers of the March 31 property tax deadline",
                 "Reconcile the deposit reports for the month", "Replace the spoiled OR booklets",
                 "Set up the e-payment channel list"),
    "budget_accounting": ("Release the first-quarter allotments", "Post the DV submission cutoff",
                          "Prepare the budget call", "Close the books for the month",
                          "Answer the audit observation memorandum"),
    "procurement": ("Publish the annual procurement plan", "Set the pre-bid conference dates",
                    "Run the supplier registration drive", "Clear the undelivered purchase orders",
                    "Prepare the BAC meeting agenda"),
    "city_clerk": ("Publish the weekly session calendar", "Prepare the public hearing notice",
                   "Organize the mass wedding in February", "Clear the FOI requests due",
                   "Archive last year's communications"),
}  # fmt: skip
