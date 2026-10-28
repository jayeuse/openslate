"""Money and quantities of the plant: typed amounts have a long tail, totals add up.

Named scenario: Customer Invoice 1 bills $12,480.00 for one retail load; Customer Payment 1
pays $9,360.00, leaving $3,120.00 open while the buyer clears a promotion deduction.
"""

from __future__ import annotations

from functools import lru_cache

from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer.plan_base import PINNED, Counts, Frozen, rng
from operations.sample.packs.manufacturer.realism import CREDIT_LIMIT, FREIGHT, INVOICE
from operations.sample.realism import long_tail_amount

SCENARIO_TOTAL = 12_480
SCENARIO_PAID = 9_360
SCENARIO_BALANCE = SCENARIO_TOTAL - SCENARIO_PAID
_SERVICE_CHARGES = (150, 250, 350, 500, 750, 1_500, 2_500)


def cents(value: float) -> int | float:
    rounded = round(value, 2)
    return int(rounded) if float(rounded).is_integer() else rounded


def credit_limit(customer: int) -> int | float:
    if customer < PINNED:
        return (250_000, 100_000, 50_000, 150_000, 75_000, 25_000, 50_000, 40_000, 200_000,
                30_000)[customer]  # fmt: skip
    return long_tail_amount(rng("customers", customer, "credit"), CREDIT_LIMIT)


def line_price(line: int, counts: Counts) -> int | float:
    """The case price on the customer's price list: foodservice and private label pay less."""
    product = sales.line_product(line, counts)
    order = sales.line_slot(line, counts)[0]
    channel = base.customer_channel(base.customer_of_order(order, counts))
    factor = {"Foodservice": 0.9, "Private label": 0.82, "Co-man": 0.78}
    return cents(base.list_price(product) * factor.get(channel, 1.0))


def line_cases(line: int, counts: Counts) -> int:
    order = sales.line_slot(line, counts)[0]
    channel = base.customer_channel(base.customer_of_order(order, counts))
    stream = rng("sales_order_lines", line, "cases")
    if channel == "Retail":
        return stream.choice((120, 240, 280, 360, 480, 560, 720, 960))
    if channel in {"Private label", "Co-man"}:
        return stream.choice((600, 800, 1_200, 1_600, 2_400))
    return max(5, int(stream.lognormvariate(3.6, 0.8)))


@lru_cache(maxsize=16)
def _order_values(frozen_counts: Frozen) -> dict[int, int | float]:
    counts = dict(frozen_counts)
    totals: dict[int, float] = {}
    for line in range(counts["sales_order_lines"]):
        if sales.line_class(line, counts) == "Cancelled":
            continue
        order = sales.line_slot(line, counts)[0]
        totals[order] = totals.get(order, 0.0) + line_cases(line, counts) * float(
            line_price(line, counts)
        )
    return {order: cents(total) for order, total in totals.items()}


def order_value(order: int, counts: Counts) -> int | float:
    return _order_values(base.frozen(counts)).get(order, 0)


def standard_cost(product: int) -> int | float:
    share = rng("products", product, "cost").uniform(0.55, 0.7)
    return cents(base.list_price(product) * share)


def po_qty(po: int, counts: Counts) -> int | float:
    _name, kind, unit, _price, _allergen, _lead = base.material_info(supply.po_material(po, counts))
    stream = rng("purchase_orders", po, "qty")
    if kind == "MRO":
        return stream.choice((2, 4, 6, 10, 20)) if unit != "L" else stream.choice((20, 50, 200))
    return {
        "tote": stream.choice((4, 6, 8, 10, 12)), "kg": stream.choice((1_000, 2_000, 5_000,
                                                                       10_000, 20_000)),
        "L": stream.choice((5_000, 10_000, 20_000)), "ea": stream.choice((10_000, 25_000,
                                                                          50_000, 100_000)),
        "roll": stream.choice((10, 20, 40, 60)), "case": stream.choice((5, 10, 20)),
    }.get(unit, 10)  # fmt: skip


def po_price(po: int, counts: Counts) -> int | float:
    return cents(base.material_info(supply.po_material(po, counts))[3])


def po_total(po: int, counts: Counts) -> int | float:
    return cents(float(po_qty(po, counts)) * float(po_price(po, counts)))


def price_variance(invoice: int, counts: Counts) -> int | float:
    label = supply.supplier_invoice_class(invoice, counts)
    if label not in {"Exception", "Disputed"}:
        return 0
    po = supply.supplier_invoice_po(invoice, counts)
    total = float(po_total(po, counts)) if po is not None else 1_000.0
    share = rng("supplier_invoices", invoice, "variance").uniform(-0.04, 0.09)
    return cents(total * share) or 25


def supplier_invoice_amount(invoice: int, counts: Counts) -> int | float:
    po = supply.supplier_invoice_po(invoice, counts)
    if po is None:
        return cents(rng("supplier_invoices", invoice, "amount").uniform(400, 4_000))
    total = float(po_total(po, counts))
    if po in _split_billed(base.frozen(counts)):
        total /= 2  # A split delivery is billed in two invoices.
    return cents(max(1.0, total + float(price_variance(invoice, counts))))


@lru_cache(maxsize=16)
def _split_billed(frozen_counts: Frozen) -> frozenset[int]:
    counts = dict(frozen_counts)
    seen: dict[int, int] = {}
    for invoice in range(counts["supplier_invoices"]):
        po = supply.supplier_invoice_po(invoice, counts)
        if po is not None:
            seen[po] = seen.get(po, 0) + 1
    return frozenset(po for po, total in seen.items() if total > 1)


def freight_cost(shipment: int) -> int | float:
    return long_tail_amount(rng("shipments", shipment, "freight"), FREIGHT)


def invoice_amount(invoice: int, counts: Counts) -> int | float:
    if invoice == 0:
        return SCENARIO_TOTAL
    if sales.invoice_shipment(invoice, counts) is None:
        stream = rng("customer_invoices", invoice, "charge")
        return stream.choice(_SERVICE_CHARGES)
    return long_tail_amount(rng("customer_invoices", invoice, "amount"), INVOICE)


def payment_amount(payment: int, counts: Counts) -> int | float:
    slot = sales.payment_slot(payment, counts)
    if slot is None:
        return 0
    invoice, part = slot
    amount = float(invoice_amount(invoice, counts))
    if invoice == 0:
        return SCENARIO_PAID
    stream = rng("customer_payments", payment, "amount")
    if part == "partial":
        return cents(amount * stream.uniform(0.4, 0.8))
    if part == "first":
        return cents(amount * stream.uniform(0.85, 0.97))
    if part == "second":
        first = next(item for item in sales.invoice_payments(invoice, counts) if item != payment)
        return cents(amount - float(payment_amount(first, counts)))
    return cents(amount)


def invoice_balance(invoice: int, counts: Counts) -> int | float:
    status = sales.invoice_status(invoice, counts)
    if status in {"Paid", "Credited"}:
        return 0
    payments = sales.invoice_payments(invoice, counts)
    paid = sum(float(payment_amount(item, counts)) for item in payments)
    return cents(float(invoice_amount(invoice, counts)) - paid)
