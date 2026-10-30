"""Distributor rates for the shared realism rules: a Philippine FMCG distributor."""

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

# R1. Most records sit in the module's normal end state (research §8). Stock lots, trade
# promotions, returns and principal claims are reshaped so the end state leads by twice the
# next status; the research marks those mixes as judgment.
STATUS_WEIGHTS: dict[str, dict[str, float]] = {
    "outlets": {"Active": 85, "Inactive": 4, "On credit hold": 4, "Prospect": 3, "Blocked": 2,
                "Closed": 2},
    "store_visits": {"Completed": 86, "Not visited": 7, "Planned": 4, "Abandoned": 2,
                     "In progress": 1},
    "sales_orders": {"Delivered": 82, "Cancelled": 4, "Confirmed": 3, "Partially delivered": 3,
                     "Picked": 2, "Credit hold": 2, "Submitted": 1.5, "Rejected by credit": 1,
                     "Draft": 1.5},
    "trade_promotions": {"Claimed": 52, "Active": 24, "Ended": 10, "Approved": 5,
                         "Pending principal approval": 4, "Cancelled": 4, "Draft": 1},
    "products": {"Active": 88, "Phase-out": 5, "New listing": 3, "Delisted": 3,
                 "Recalled": 1},
    "purchase_orders": {"Closed": 66, "Received": 9, "Partially received": 8,
                        "Sent to principal": 7, "Pending approval": 4, "Approved": 2,
                        "Rejected": 2, "Cancelled": 2},
    "goods_receipts": {"Posted": 80, "Posted with discrepancy": 10, "Counting": 4, "Draft": 3,
                       "Reversed": 3},
    "stock_lots": {"Available": 58, "Depleted": 20, "Pick first (FEFO)": 12, "Quarantine": 4,
                   "Blocked": 4, "Returned to principal": 2},
    "stock_counts": {"Posted": 72, "Approved": 10, "Counted": 8, "Scheduled": 6,
                     "Recount required": 4},
    "stock_adjustments": {"Posted": 70, "Approved": 10, "Pending approval": 10, "Draft": 5,
                          "Rejected": 5},
    "returns": {"Credited": 52, "Replaced": 12, "Inspected": 10, "Rejected": 7, "Received": 6,
                "Requested": 5, "Picked up": 4, "Authorized": 3, "Cancelled": 1},
    "vehicles": {"Available": 70, "On trip": 15, "Under maintenance": 10, "Out of service": 5},
    "collection_receipts": {"Cleared": 82, "Deposited": 9, "Remitted": 5, "Bounced": 2,
                            "Voided": 2},
    "credit_reviews": {"Approved": 60, "Approved with conditions": 15, "Declined": 12,
                       "Under review": 8, "Submitted": 5},
    "principal_invoices": {"Paid": 70, "Approved for payment": 10, "On hold – variance": 8,
                           "Matching": 6, "Received": 4, "Disputed": 2},
    "principal_claims": {"Settled – credit note": 50, "Under principal review": 16,
                         "Submitted": 9, "Settled – offset": 8, "Partially approved": 6,
                         "Rejected": 5, "Approved": 4, "Draft": 2},
}  # fmt: skip

# R2. Amounts in pesos: list prices and limits have long tails; limits sit on round tiers.
LIST_PRICE = AmountShape(780, sigma=0.95, round_share=0.12, cents_share=0.5, minimum=60)
RETURN_VALUE = AmountShape(1_450, sigma=1.05, round_share=0.15, cents_share=0.4, minimum=40)
CREDIT_LIMIT = AmountShape(30_000, sigma=1.0, round_share=0.85, minimum=5_000, step=5_000)
CLAIM_AMOUNT = AmountShape(28_000, sigma=1.1, round_share=0.12, cents_share=0.6, minimum=500)
PROMO_BUDGET = AmountShape(75_000, sigma=0.9, round_share=0.7, minimum=10_000, step=1_000)
VAN_SALE = AmountShape(1_650, sigma=0.9, round_share=0.08, cents_share=0.9, minimum=120)
OUTLET_LIMITS = (5_000, 10_000, 10_000, 15_000, 20_000, 20_000, 30_000, 50_000, 75_000,
                 100_000, 250_000, 500_000)  # fmt: skip

# Amounts the distributor computes from other records: line and order totals, invoice and
# receipt amounts, balances, the van day's values, the principal's bills and approvals.
COMPUTED_AMOUNTS = frozenset({
    "sales_orders.order_total", "order_lines.unit_price", "order_lines.line_total",
    "route_tours.load_value", "route_tours.sales_value", "purchase_orders.po_total",
    "po_lines.unit_cost", "po_lines.line_total", "stock_adjustments.value",
    "sales_invoices.amount", "sales_invoices.balance", "collection_receipts.amount",
    "credit_reviews.approved_limit", "principal_invoices.amount", "principal_claims.approved",
})  # fmt: skip
# Credit limits sit on the credit committee's round tiers.
TIERED_AMOUNTS = frozenset({"outlets.credit_limit"})
NOT_AMOUNTS: frozenset[str] = frozenset()
# Every order and purchase order has its lines; other one-to-many links leave parents bare.
STRUCTURAL_LINKS = frozenset({"order_lines", "po_lines"})


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


# R3. The "ber months" lift orders from September; the hot-dry season (March to May) lifts
# beverages; the typhoon season (June to November) slows routes and raises damage returns.
_BER = {9: 1.25, 10: 1.35, 11: 1.45, 12: 1.6, 1: 0.8, 6: 0.9, 7: 0.85, 8: 0.9}
_TYPHOON = {7: 1.3, 8: 1.5, 9: 1.4, 10: 1.3, 11: 1.1}
SEASONS: dict[str, dict[int, float]] = {
    "store_visits": _BER, "sales_orders": _BER, "credit_reviews": _BER,
    "returns": _TYPHOON, "stock_adjustments": _TYPHOON,
    "purchase_orders": {8: 1.2, 9: 1.3, 10: 1.4, 11: 1.3, 3: 1.2, 4: 1.2},
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
    "sales": ("To plan", "In the field", "Waiting on outlet", "Done"),
    "trade_marketing": ("Circular received", "Setting up", "Running", "Claim prep", "Closed"),
    "purchasing": ("To order", "Waiting on principal", "Confirmed", "Received"),
    "warehouse": ("To count", "Counting", "Variance check", "Adjusted", "Done"),
    "logistics": ("To schedule", "At the shop", "Waiting on parts", "Back on the road"),
    "credit_collections": ("To call", "Promised", "Visited", "Escalated", "Settled"),
    "accounting": ("To compile", "Filed", "Principal review", "Settled"),
}
BOARD_OBJECTIVES: dict[str, tuple[str, ...]] = {
    "sales": ("Cut the new PJP for PS04 and PS07", "Ride along on the Tuesday van route",
              "Push the Sabaw 12+1 before the 31st", "Clean up the closed outlets list",
              "Review strike rates with the pre-sellers", "Plan the Christmas order drive"),
    "trade_marketing": ("Load the Kestrel Q4 scheme circular", "Book the display audit week",
                        "Prepare the Brightbay business review", "Collect signed outlet lists",
                        "Reset the supermarket planograms"),
    "purchasing": ("Send the Monday replenishment POs", "Update the Kestrel price increase",
                   "List the new Palmera SKUs", "Chase the Tala allocation notice",
                   "Review stock cover for the ber months"),
    "warehouse": ("Publish the near-expiry list", "Run the A-item cycle count",
                  "Book the pest control visit", "Plan the quarter-end stock take",
                  "Clear the BO cage", "Hold the safety toolbox talk"),
    "logistics": ("Book the truck PMS schedule", "Renew the June registrations",
                  "Post the holiday dispatch schedule", "Check the typhoon route plan",
                  "Replace the worn tires on truck 3"),
    "credit_collections": ("Send the day-1 statements", "Deposit this week's PDCs",
                           "Call the 60-day accounts", "Prepare the credit committee list",
                           "Reconcile the van cash remittances"),
    "accounting": ("File the Kestrel scheme claim", "Close the month by the 3rd",
                   "Reconcile the principal statements", "File the monthly VAT return",
                   "Send the BO claims with photos"),
}  # fmt: skip
