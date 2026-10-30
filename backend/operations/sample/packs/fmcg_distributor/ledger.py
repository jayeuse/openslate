"""Distributor money: list prices, line and order totals, purchase orders and van sales."""

from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.fmcg_distributor import lines, links, vocabulary
from operations.sample.packs.fmcg_distributor.links import rng
from operations.sample.packs.fmcg_distributor.realism import LIST_PRICE, VAN_SALE
from operations.sample.realism import long_tail_amount

# The named order: 6 cases of evaporated milk, 5 of choco drink, 4 of condensada = 24,600.
_PINNED_PRICES = (2_150, 600, 2_175)
COST_SHARE = 0.86  # The distributor buys at about 14% below its list price.
SCENARIO_INVOICE = 24_600
SCENARIO_PAYMENT = 10_000
SCENARIO_BALANCE = SCENARIO_INVOICE - SCENARIO_PAYMENT


def money(value: float) -> int | float:
    rounded = round(value, 2)
    return int(rounded) if float(rounded).is_integer() else rounded


def product_sku(product: int, counts: Mapping[str, int]) -> tuple[str, str, int, int, str]:
    """Brand, item, pieces per case, shelf life (days), ABC class of one product."""
    principal = links.product_principal(product, counts)
    name, code, _category, _prefix, _terms = vocabulary.PRINCIPALS[
        principal % len(vocabulary.PRINCIPALS)]  # fmt: skip
    brand = name.split()[0]
    items = vocabulary.SKUS[code]
    rank = links.product_rank(product, counts)
    item, per_case, shelf_life, abc = items[rank % len(items)]
    variant = vocabulary.PACK_VARIANTS[(rank // len(items)) % len(vocabulary.PACK_VARIANTS)]
    batch = rank // (len(items) * len(vocabulary.PACK_VARIANTS))
    label = f"{item} {variant}".strip() if variant else item
    if batch:
        label = f"{label} {batch + 1}"
    if principal >= len(vocabulary.PRINCIPALS):
        region = vocabulary.REGIONS[(principal // len(vocabulary.PRINCIPALS) - 1)
                                    % len(vocabulary.REGIONS)]  # fmt: skip
        label = f"{label} ({region})"
    return brand, label, per_case, shelf_life, abc


def list_price(product: int) -> int | float:
    if product < len(_PINNED_PRICES):
        return _PINNED_PRICES[product]
    return long_tail_amount(rng("products", product, "price"), LIST_PRICE)


def unit_cost(product: int) -> int | float:
    return money(float(list_price(product)) * COST_SHARE)


def line_total(line: int, counts: Mapping[str, int]) -> int | float:
    product = lines.line_product(line, counts)
    per_case = product_sku(product, counts)[2]
    cases = lines.line_cases(line, counts) + lines.line_pieces(line, counts) / per_case
    discount = lines.line_discount(line, counts)
    return money(cases * float(list_price(product)) * (1 - discount / 100))


@lru_cache(maxsize=16)
def _order_totals(key: tuple[int, ...]) -> tuple[tuple[float, float], ...]:
    counts = dict(zip(("sales_orders", "order_lines", "products", "principals"), key,
                      strict=True))  # fmt: skip
    totals = []
    for order in range(counts["sales_orders"]):
        span = lines.order_line_range(order, counts)
        values = [(float(line_total(line, counts)), lines.line_status(line, counts))
                  for line in span]  # fmt: skip
        totals.append((sum(value for value, _ in values),
                       sum(value for value, state in values if state == "Delivered")))
    return tuple(totals)


def _order_key(counts: Mapping[str, int]) -> tuple[int, ...]:
    return links._key(counts, "sales_orders", "order_lines", "products", "principals")


def order_total(order: int, counts: Mapping[str, int]) -> int | float:
    return money(_order_totals(_order_key(counts))[order][0])


def delivered_value(order: int, counts: Mapping[str, int]) -> int | float:
    """What the outlet received, which the delivery invoice bills."""
    return money(_order_totals(_order_key(counts))[order][1])


def order_has_scheme(order: int, counts: Mapping[str, int]) -> bool:
    return any(lines.line_discount(line, counts) or lines.free_goods_line(line)
               for line in lines.order_line_range(order, counts))  # fmt: skip


def van_sale(invoice: int) -> int | float:
    return long_tail_amount(rng("sales_invoices", invoice, "van"), VAN_SALE)


def po_line_total(line: int, counts: Mapping[str, int]) -> int | float:
    product = lines.po_line_product(line, counts)
    return money(lines.po_line_cases(line) * float(unit_cost(product)))


def po_total(po: int, counts: Mapping[str, int]) -> int | float:
    return money(sum(float(po_line_total(line, counts))
                     for line in lines.po_line_range(po, counts)))  # fmt: skip


def po_received_value(po: int, counts: Mapping[str, int]) -> int | float:
    return money(sum(lines.po_line_received(line, counts)
                     * float(unit_cost(lines.po_line_product(line, counts)))
                     for line in lines.po_line_range(po, counts)))  # fmt: skip


def adjustment_cases(adjustment: int) -> int:
    reason = lines.adjustment_reason(adjustment)
    size = rng("stock_adjustments", adjustment, "cases").choice((1, 1, 2, 2, 3, 4, 6, 10))
    if reason == "Found stock":
        return size
    if reason == "Repack or re-case":
        return -1
    return -size


def adjustment_value(adjustment: int, counts: Mapping[str, int]) -> int | float:
    product = lines.lot_product(lines.adjustment_lot(adjustment, counts), counts)
    return money(adjustment_cases(adjustment) * float(unit_cost(product)))
