"""Order to cash: sales orders, lines, shipments, customer invoices and payments.

Each record's main day is a working-day offset before the anchor date (``wd``: 0 is the
last working day, a negative offset lies ahead). An offset needs no date, so links can use
it: a shipment follows its order, an invoice its shipment, a payment its invoice.
"""

from __future__ import annotations

from functools import cache, lru_cache

from operations.sample.packs.manufacturer.plan_base import (
    PINNED,
    Counts,
    Frozen,
    between,
    counted,
    customer_channel,
    customer_of_order,
    draw,
    frozen,
    rng,
    sellable,
)
from operations.sample.packs.manufacturer.realism import INVOICE_CLASSES, ORDER_CLASSES
from operations.sample.realism import skewed_parent

SHIPPED_ORDERS = frozenset({"Closed", "Invoiced", "Shipped", "Partially shipped"})
SHIPPED = frozenset({"Delivered", "Shipped", "Refused"})
_ORDER_WD = {
    "Closed": (10, 30), "Invoiced": (5, 18), "Shipped": (2, 9), "Partially shipped": (3, 14),
    "Allocated": (0, 5), "Confirmed": (0, 4), "Draft": (0, 24), "On hold": (3, 20),
    "Cancelled": (2, 25),
}  # fmt: skip
OVERDUE_WD = 22  # About 30 days after the invoice date, past Net 30.


@cache
def order_class(order: int) -> str:
    return "Closed" if order < PINNED else draw("sales_orders", order, ORDER_CLASSES)


@cache
def order_wd(order: int) -> int:
    return between("sales_orders", order, *_ORDER_WD[order_class(order)])


@counted
def order_mto(order: int, counts: Counts) -> bool:
    channel = customer_channel(customer_of_order(order, counts))
    if channel in {"Private label", "Co-man"}:
        return True
    return channel == "Foodservice" and rng("sales_orders", order, "mto").random() < 0.3


@lru_cache(maxsize=16)
def _line_table(orders: int, lines: int) -> tuple[tuple[int, int], ...]:
    """(order, line number) for each line: every order has one line, some have many."""
    sizes = [1] * orders
    stream = rng("lines", orders, lines)
    weights = [stream.paretovariate(1.6) for _ in range(orders)]
    for _ in range(max(0, lines - orders)):
        sizes[stream.choices(range(orders), weights=weights)[0]] += 1
    table = [(order, number) for order in range(orders) for number in range(1, sizes[order] + 1)]
    return tuple(table[:lines]) if lines >= orders else tuple((i, 1) for i in range(lines))


def line_slot(line: int, counts: Counts) -> tuple[int, int]:
    return _line_table(counts["sales_orders"], counts["sales_order_lines"])[line]


@lru_cache(maxsize=16)
def _order_lines(orders: int, lines: int) -> dict[int, tuple[int, ...]]:
    found: dict[int, list[int]] = {}
    for line, (order, _number) in enumerate(_line_table(orders, lines)):
        found.setdefault(order, []).append(line)
    return {key: tuple(value) for key, value in found.items()}


def order_lines(order: int, counts: Counts) -> tuple[int, ...]:
    return _order_lines(counts["sales_orders"], counts["sales_order_lines"]).get(order, ())


@counted
def line_product(line: int, counts: Counts) -> int:
    pool = sellable(counts)
    return pool[skewed_parent("line_product", line, len(pool), pinned=0, dormant_share=0.0)]


@counted
def line_class(line: int, counts: Counts) -> str:
    order = line_slot(line, counts)[0]
    label = order_class(order)
    roll = rng("sales_order_lines", line, "class").random()
    if label in {"Closed", "Invoiced", "Shipped"}:
        return "Cancelled" if roll < 0.04 and line >= PINNED else "Shipped"
    if label == "Partially shipped":
        return "Shipped" if roll < 0.6 else "Backordered"
    return {"Allocated": "Allocated", "Cancelled": "Cancelled"}.get(label, "Open")


# Shipments: one for each shipped order, one planned for each allocated order, and the
# extra loads of large and backordered orders.
@lru_cache(maxsize=16)
def _shipment_table(frozen_counts: Frozen) -> tuple[tuple[int, str], ...]:
    counts = dict(frozen_counts)
    orders = range(counts["sales_orders"])
    rows = [(order, "shipped") for order in orders if order_class(order) in SHIPPED_ORDERS]
    rows += [(order, "planned") for order in orders if order_class(order) == "Allocated"]
    rows += [(order, "backorder") for order in orders
             if order_class(order) == "Partially shipped"]  # fmt: skip
    extra = [order for order in orders if order_class(order) in {"Closed", "Invoiced"}]
    stream = rng("shipments", counts["shipments"])
    while len(rows) < counts["shipments"] and extra:
        rows.append((stream.choice(extra), "second"))
    return tuple(rows[: counts["shipments"]])


def shipment_slot(shipment: int, counts: Counts) -> tuple[int, str] | None:
    table = _shipment_table(frozen(counts))
    return table[shipment] if shipment < len(table) else None


@counted
def shipment_class(shipment: int, counts: Counts) -> str:
    slot = shipment_slot(shipment, counts)
    if slot is None:
        return "Planned"
    order, kind = slot
    if kind in {"planned", "backorder"}:
        return draw("shipments", shipment, {"Planned": 40, "Picking": 35, "Loaded": 25})
    if shipment < PINNED:
        return "Delivered"
    if order_class(order) == "Shipped" and kind == "shipped":
        return "Shipped" if rng("shipments", shipment, "transit").random() < 0.7 else "Delivered"
    return "Refused" if rng("shipments", shipment, "refused").random() < 0.03 else "Delivered"


@counted
def shipment_wd(shipment: int, counts: Counts) -> int:
    slot = shipment_slot(shipment, counts)
    if slot is None:
        return -1
    order, kind = slot
    if kind in {"planned", "backorder"}:
        return -between("shipments", shipment, 0, 3)
    lag = (1, 4) if kind == "shipped" else (3, 8)
    return max(0, order_wd(order) - between("shipments", shipment, *lag))


@lru_cache(maxsize=16)
def _shipped(frozen_counts: Frozen) -> tuple[int, ...]:
    counts = dict(frozen_counts)
    return tuple(item for item in range(counts["shipments"])
                 if shipment_class(item, counts) in SHIPPED)  # fmt: skip


# Customer invoices: one for each shipped load, then freight, plate and pallet charges.
def invoice_shipment(invoice: int, counts: Counts) -> int | None:
    shipped = _shipped(frozen(counts))
    return shipped[invoice] if invoice < len(shipped) else None


@lru_cache(maxsize=16)
def _shipment_invoice(frozen_counts: Frozen) -> dict[int, int]:
    counts = dict(frozen_counts)
    shipped = _shipped(frozen_counts)
    return {shipped[item]: item for item in range(min(len(shipped), counts["customer_invoices"]))}


def shipment_invoice(shipment: int, counts: Counts) -> int | None:
    return _shipment_invoice(frozen(counts)).get(shipment)


@counted
def invoice_customer(invoice: int, counts: Counts) -> int:
    shipment = invoice_shipment(invoice, counts)
    slot = None if shipment is None else shipment_slot(shipment, counts)
    if slot is not None:
        return customer_of_order(slot[0], counts)
    return skewed_parent("invoice_customer", invoice, counts["customers"], pinned=0)


def invoice_type(invoice: int, counts: Counts) -> str:
    if invoice_shipment(invoice, counts) is not None:
        return "Shipment"
    weights = {"Freight rebill": 50, "Art and plate charge": 25, "Pallet charge": 25}
    if customer_channel(invoice_customer(invoice, counts)) == "Private label":
        weights = {"Art and plate charge": 70, "Freight rebill": 30}
    return draw("customer_invoices", invoice, weights, "type")


@counted
def invoice_wd(invoice: int, counts: Counts) -> int:
    shipment = invoice_shipment(invoice, counts)
    if shipment is not None:
        return shipment_wd(shipment, counts)
    return between("customer_invoices", invoice, 0, 28)


def _invoice_class(invoice: int, counts: Counts) -> str:
    shipment = invoice_shipment(invoice, counts)
    if shipment is not None and shipment_class(shipment, counts) == "Refused":
        return "Credited"
    if invoice == 0:
        return "Partially paid"  # The named part payment.
    if invoice < PINNED:
        return "Paid"
    if invoice_wd(invoice, counts) <= 3:
        return "Draft" if rng("customer_invoices", invoice, "draft").random() < 0.15 else "Issued"
    label = draw("customer_invoices", invoice, INVOICE_CLASSES)
    return "Issued" if label == "Overdue" and invoice_wd(invoice, counts) < OVERDUE_WD else label


@lru_cache(maxsize=16)
def _payment_table(frozen_counts: Frozen) -> tuple[tuple[int, str], ...]:
    """(invoice, part) for each payment: full, partial, or the first and second of two."""
    counts = dict(frozen_counts)
    invoices = range(counts["customer_invoices"])
    classes = {item: _invoice_class(item, counts) for item in invoices}
    rows = [(item, "partial" if classes[item] == "Partially paid" else "full")
            for item in invoices if classes[item] in {"Paid", "Partially paid"}]  # fmt: skip
    rows = rows[: counts["customer_payments"]]
    paid_twice = [index for index, (item, part) in enumerate(rows)
                  if part == "full" and item >= PINNED]  # fmt: skip
    stream = rng("customer_payments", counts["customer_payments"])
    stream.shuffle(paid_twice)
    for index in paid_twice[: counts["customer_payments"] - len(rows)]:
        item = rows[index][0]
        rows[index] = (item, "first")
        rows.append((item, "second"))
    return tuple(rows)


def payment_slot(payment: int, counts: Counts) -> tuple[int, str] | None:
    table = _payment_table(frozen(counts))
    return table[payment] if payment < len(table) else None


@lru_cache(maxsize=16)
def _invoice_payments(frozen_counts: Frozen) -> dict[int, tuple[int, ...]]:
    found: dict[int, list[int]] = {}
    for payment, (invoice, _part) in enumerate(_payment_table(frozen_counts)):
        found.setdefault(invoice, []).append(payment)
    return {key: tuple(value) for key, value in found.items()}


def invoice_payments(invoice: int, counts: Counts) -> tuple[int, ...]:
    return _invoice_payments(frozen(counts)).get(invoice, ())


@counted
def invoice_status(invoice: int, counts: Counts) -> str:
    label = _invoice_class(invoice, counts)
    payments = invoice_payments(invoice, counts)
    if payments:
        parts = {payment_slot(item, counts)[1] for item in payments}  # type: ignore[index]
        return "Partially paid" if parts == {"partial"} else "Paid"
    if label in {"Paid", "Partially paid"}:
        return "Overdue" if invoice_wd(invoice, counts) >= OVERDUE_WD else "Issued"
    return label


@counted
def payment_wd(payment: int, counts: Counts) -> int:
    slot = payment_slot(payment, counts)
    if slot is None:
        return between("customer_payments", payment, 0, 20)
    invoice, part = slot
    start = invoice_wd(invoice, counts)
    first = max(0, start - between("customer_payments", payment, 3, 12, "lag"))
    if part != "second":
        return first
    earlier = next(item for item in invoice_payments(invoice, counts) if item != payment)
    return max(0, payment_wd(earlier, counts) - between("customer_payments", payment, 2, 8))


def payment_status(payment: int, counts: Counts) -> str:
    return "Applied" if payment_wd(payment, counts) <= 2 else "Cleared"

