"""Sauce plant rates for the shared realism rules: a 165-person US condiments plant.

Statuses that a linked record decides are drawn in ``plan_base``, ``plan_sales`` and
``plan_plant``; the weights below keep the research §8 mixes, reshaped where the research
split fails the long-tail rule (the top status holds 50% or more and twice the next).
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

from operations.sample.realism import AmountShape, nth_weekday

# R1. Classes and statuses that no linked record decides.
CUSTOMER_CHANNELS = {"Wholesale": 45, "Foodservice": 25, "Retail": 15, "Private label": 12,
                     "Co-man": 3}  # fmt: skip
PRODUCT_CLASSES = {"Active": 78, "Phase-out": 9, "Development": 8, "Discontinued": 5}
MATERIAL_STATUS = {"Active": 88, "Obsolete": 8, "Blocked": 4}
ORDER_CLASSES = {
    "Closed": 54, "Invoiced": 16, "Shipped": 8, "Allocated": 8, "Confirmed": 6,
    "Partially shipped": 3, "Draft": 3, "On hold": 1, "Cancelled": 1,
}  # fmt: skip
PO_CLASSES = {
    "Closed": 56, "Received": 14, "Confirmed": 10, "Sent": 8, "Partially received": 6,
    "Draft": 4, "Cancelled": 2,
}  # fmt: skip
WO_CLASSES = {
    "Closed": 52, "Technically complete": 12, "Released": 11, "Completed": 8,
    "In progress": 6, "Created": 4, "Partially confirmed": 3, "On hold": 2, "Cancelled": 2,
}  # fmt: skip
# Research §8 has Consumed 55 / Released 38 and Shipped out 60 / Released 33: too flat.
LOT_CLASSES = {"Consumed": 62, "Released": 25, "On hold": 4, "Rejected": 4, "Expired": 3,
               "Quarantine": 2}  # fmt: skip
FINISHED_CLOSED = {"Shipped out": 80, "Released": 12, "Quality hold": 3, "Rework": 2,
                   "Destroyed": 2, "Recalled": 1}  # fmt: skip
INVOICE_CLASSES = {"Paid": 72, "Issued": 12, "Overdue": 7, "Partially paid": 5, "Disputed": 4}
NCR_SOURCES = {"In-process": 35, "Incoming": 22, "Final": 18, "Customer complaint": 12,
               "Audit": 7, "Supplier": 6}  # fmt: skip
NCR_STATUS = {"Closed": 60, "Dispositioned": 16, "Under review": 12, "Contained": 4,
              "Open": 4, "Voided": 4}  # fmt: skip
CAPA_STATUS = {"Closed, effective": 30, "Effectiveness check": 25, "Action in progress": 25,
               "Root cause": 10, "Open": 5, "Reopened": 5}  # fmt: skip
EQUIPMENT_STATUS = {"In service": 82, "Retired": 7, "Down": 6, "Out of service": 5}
WORK_CENTER_STATUS = {"Running": 62, "Idle": 16, "Sanitation": 14, "Down": 8}
MWO_TYPES = {"Preventive": 62, "Corrective": 20, "Calibration": 8, "Emergency": 5,
             "Improvement": 5}  # fmt: skip
MWO_STATUS = {
    "Closed": 66, "Scheduled": 10, "Completed": 9, "Waiting parts": 5, "In progress": 4,
    "Approved": 2, "Requested": 2, "Cancelled": 2,
}  # fmt: skip
SUPPLIER_IDLE = {"Inactive": 40, "Approved": 30, "Pending approval": 20, "Suspended": 10}
# Downtime reasons by frequency (research §9): jams and changeovers are the usual stops.
REASON_WEIGHTS = (14, 6, 18, 5, 9, 3, 3, 3, 4, 4, 7, 2, 2, 5, 8, 2, 3, 1)

# R2. Typed amounts follow a long tail; the others come from the records they total.
CREDIT_LIMIT = AmountShape(50_000, sigma=1.0, round_share=0.85, minimum=5_000)
INVOICE = AmountShape(9_800, sigma=0.85, round_share=0.02, cents_share=0.95, minimum=400)
FREIGHT = AmountShape(640, sigma=0.8, round_share=0.12, cents_share=0.6, minimum=95)
NCR_COST = AmountShape(1_400, sigma=1.2, round_share=0.25, minimum=40)
PARTS = AmountShape(220, sigma=1.1, round_share=0.1, cents_share=0.8, minimum=8)
COMPUTED_AMOUNTS = frozenset({
    "sales_orders.order_value", "products.standard_cost", "purchase_orders.po_total",
    "supplier_invoices.amount", "customer_invoices.balance", "customer_payments.amount",
})  # fmt: skip
# Price lists: one contract or list price for each item, checked for round numbers only.
TIERED_AMOUNTS = frozenset({
    "sales_order_lines.unit_price", "products.list_price", "materials.contract_price",
    "purchase_orders.unit_price",
})  # fmt: skip
# A price variance is signed and mostly zero; it is not an amount people type.
NOT_AMOUNTS = frozenset({"supplier_invoices.price_variance"})
# Every order has its lines; the other one-to-many links leave some parents childless.
STRUCTURAL_LINKS = frozenset({"order_lines"})


def _observed(day: date) -> date:
    """A Saturday holiday is observed on Friday, a Sunday one on Monday."""
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def plant_holidays(year: int) -> set[date]:
    """The days the plant closes: the usual US manufacturing holidays, observed."""
    thanksgiving = nth_weekday(year, 11, 3, 4)
    return {
        _observed(date(year, 1, 1)),
        nth_weekday(year, 5, 0, -1),  # Memorial Day
        _observed(date(year, 7, 4)),
        nth_weekday(year, 9, 0, 1),  # Labor Day
        thanksgiving,
        thanksgiving + timedelta(days=1),
        _observed(date(year, 12, 24)) if date(year, 12, 24).weekday() < 5 else date(year, 12, 23),
        _observed(date(year, 12, 25)),
    }


@lru_cache(maxsize=8)
def holidays(anchor: date) -> frozenset[date]:
    return frozenset().union(*(plant_holidays(anchor.year + offset) for offset in (-1, 0, 1)))


# R9. Every department board has a Kanban whose stages fit the team's work.
BOARD_STAGES: dict[str, tuple[str, ...]] = {
    "sales": ("New request", "Quoting", "Waiting on customer", "Confirmed"),
    "planning": ("To plan", "Ordered", "Expediting", "Received"),
    "warehouse": ("To do", "In progress", "Waiting on carrier", "Done"),
    "manufacturing": ("Reported", "Scheduled", "In progress", "Checking", "Done"),
    "quality": ("Open", "Investigating", "Waiting on records", "Verified"),
    "maintenance": ("Requested", "Planned", "Waiting parts", "In progress", "Done"),
    "finance": ("To review", "In progress", "Waiting on approval", "Posted"),
}
BOARD_OBJECTIVES: dict[str, tuple[str, ...]] = {
    "sales": ("Send the spring promotion calendar to the retail buyers",
              "Confirm the private label launch dates", "Announce the price increase date",
              "Clear the orders on credit hold", "Update the customer specification files"),
    "planning": ("Freeze next week's schedule", "Book the tomato paste contract for next year",
                 "Review the reorder points for glass and closures",
                 "Expedite the late spice orders", "Plan the holiday peak builds"),
    "warehouse": ("Post the holiday carrier cutoffs", "Count the A items this week",
                  "Prepare the quarterly physical inventory", "Remind the team about FEFO picks",
                  "Clear the dock door 3 backlog"),
    "manufacturing": ("Post the toolbox talk on lockout and tagout",
                      "Open the Saturday overtime sign-up", "Plan the line trial for the new SKU",
                      "Cut changeover time on L2", "Review last week's downtime top five"),
    "quality": ("Prepare the records for the certification audit", "Run the mock recall",
                "Schedule the GMP refresher", "Close the overdue CAPA actions",
                "Review the allergen changeover near miss"),
    "maintenance": ("Plan the December shutdown", "Book the boiler inspection",
                    "Order the L1 filler rebuild kit", "Hold the contractor safety briefing",
                    "Raise preventive maintenance compliance to 90%"),
    "finance": ("Publish the month-end close calendar", "Update next year's standard costs",
                "Chase the overdue retail deductions", "Clear the invoice match exceptions",
                "Review the order variances for the month"),
}  # fmt: skip
