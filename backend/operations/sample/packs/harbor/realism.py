"""Harbor's rates for the shared realism rules: a Philippine cold-storage and service firm."""

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

# R1. Most records sit in the module's normal end state; the rest form a long tail.
STATUS_WEIGHTS: dict[str, dict[str, float]] = {
    "customers": {"Active": 72, "Prospect": 18, "On hold": 10},
    "contacts": {"Active": 80, "Former": 13, "Do not contact": 7},
    "quotes": {"Accepted": 54, "Expired": 18, "Sent": 14, "Draft": 9, "Cancelled": 5},
    "sales_orders": {
        "Complete": 62, "Confirmed": 16, "Partially fulfilled": 10, "Draft": 8, "Cancelled": 4,
    },
    "customer_sites": {"Active": 81, "Seasonal": 12, "Closed": 7},
    "service_contracts": {"Active": 64, "Renewal due": 17, "Expired": 13, "Cancelled": 6},
    "service_requests": {
        "Resolved": 63, "In progress": 13, "Open": 11, "Overdue": 9, "Cancelled": 4,
    },
    "request_updates": {"Internal": 52, "Customer visible": 36, "Resolved": 12},
    "equipment": {"Operational": 78, "Needs service": 15, "Retired": 7},
    "work_orders": {
        "Completed": 61, "Scheduled": 12, "In progress": 10, "Open": 8, "Overdue": 6,
        "Cancelled": 3,
    },
    "inspections": {"Passed": 74, "Follow-up": 15, "Needs repair": 11},
    "maintenance_plans": {"Active": 70, "Scheduled": 20, "On hold": 10},
    "products": {"Available": 76, "Low stock": 16, "Discontinued": 8},
    "warehouses": {"Active": 85, "Temporarily closed": 15},
    "stock_movements": {"Received": 70, "Transferred": 22, "Adjusted": 8},
    "stock_counts": {"Reconciled": 66, "Variance found": 22, "Open": 12},
    "suppliers": {"Active": 76, "Pending review": 14, "On hold": 10},
    "expenses": {"Reimbursed": 58, "Approved": 20, "Submitted": 15, "Rejected": 7},
}  # fmt: skip
# Sales orders that already have an invoice were confirmed at least once.
INVOICED_ORDER_WEIGHTS = {"Complete": 70, "Partially fulfilled": 15, "Confirmed": 13, "Draft": 2}

# R2. Amounts in pesos around each module's median.
AMOUNT_SHAPES: dict[tuple[str, str], AmountShape] = {
    ("customers", "credit_limit"): AmountShape(150_000, sigma=0.8, round_share=0.35),
    ("quotes", "total"): AmountShape(38_000),
    ("sales_orders", "total"): AmountShape(42_000),
    ("service_contracts", "annual_value"): AmountShape(96_000, round_share=0.3),
    ("service_requests", "estimated_cost"): AmountShape(6_500, cents_share=0.2),
    ("equipment", "purchase_price"): AmountShape(85_000, sigma=1.0),
    ("expenses", "amount"): AmountShape(1_800, round_share=0.15, cents_share=0.4),
    ("credit_notes", "amount"): AmountShape(3_500, cents_share=0.3),
}
DEFAULT_AMOUNT = AmountShape(2_500)
INVOICE_TOTAL = AmountShape(42_000)
PRODUCT_PRICE = AmountShape(95, sigma=0.8, minimum=5)

# R3. The rainy season (June-September) fills the service and field queues; stock and
# sales orders peak before Christmas and drop in January.
_SERVICE = {6: 1.4, 7: 1.5, 8: 1.5, 9: 1.3, 12: 0.7, 1: 0.8}
_SALES = {10: 1.2, 11: 1.4, 12: 1.3, 1: 0.7, 4: 0.8}
SEASONS: dict[str, dict[int, float]] = {
    "service_requests": _SERVICE, "request_updates": _SERVICE, "work_orders": _SERVICE,
    "inspections": _SERVICE, "quotes": _SALES, "sales_orders": _SALES, "invoices": _SALES,
    "purchase_orders": {9: 1.3, 10: 1.4, 11: 1.2, 1: 0.8}, "stock_movements": _SALES,
}  # fmt: skip
GO_LIVE_SHARE = 0.04

# Totals computed from other fields (quantity x price), so never typed as round numbers.
COMPUTED_AMOUNTS = frozenset({
    "purchase_orders.total", "purchase_lines.line_total", "payments.amount",
    "stock_movements.unit_cost", "purchase_lines.unit_price",
})  # fmt: skip
# One child per parent slot: two lines per order, receipts and movements per receipt.
STRUCTURAL_LINKS = frozenset({"purchase_order_lines", "purchase_order_receipts",
                              "product_movements"})  # fmt: skip


def philippine_holidays(year: int) -> set[date]:
    easter = easter_sunday(year)
    fixed = ((1, 1), (4, 9), (5, 1), (6, 12), (8, 21), (11, 1), (11, 30), (12, 8), (12, 25),
             (12, 30), (12, 31))  # fmt: skip
    return {
        *(date(year, month, day) for month, day in fixed),
        easter - timedelta(days=3),  # Maundy Thursday
        easter - timedelta(days=2),  # Good Friday
        nth_weekday(year, 8, 0, -1),  # National Heroes Day
    }


@lru_cache(maxsize=8)
def holidays(anchor: date) -> frozenset[date]:
    return frozenset().union(*(philippine_holidays(anchor.year + offset) for offset in (-1, 0, 1)))


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
