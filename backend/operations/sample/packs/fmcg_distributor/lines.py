"""Order lines, purchase order lines, receipts, stock lots, counts and adjustments."""

from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.fmcg_distributor.links import (
    PINNED,
    _key,
    fill,
    order_channel,
    order_status,
    owner,
    pick,
    popular_product,
    principal_products,
    principal_status,
    product_principal,
    rng,
    status,
)

# The named order (24,600 pesos) and the large credit order that the credit rule flags.
_PINNED_LINES = {0: 3, 1: 8}
PINNED_LINE_PRODUCTS = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0)
PINNED_LINE_CASES = (6, 5, 4, 25, 30, 20, 40, 15, 25, 30, 20)


def _desired_lines(order: int) -> int:
    if order < PINNED:
        return _PINNED_LINES.get(order, 4)
    channel = order_channel(order)
    if channel == "Key account":
        return rng("order_lines", order, "size").randint(12, 20)
    if channel == "Phone or chat":
        return rng("order_lines", order, "size").randint(2, 5)
    return rng("order_lines", order, "size").choices((1, 2, 3, 4, 5, 6, 8), (12, 18, 20, 18, 14,
                                                                              10, 8))[0]


@lru_cache(maxsize=16)
def _line_starts(orders: int, lines: int) -> tuple[int, ...]:
    return fill(orders, lines, _desired_lines)


def line_order(line: int, counts: Mapping[str, int]) -> int:
    return owner(_line_starts(*_key(counts, "sales_orders", "order_lines")), line)


def order_line_range(order: int, counts: Mapping[str, int]) -> range:
    starts = _line_starts(*_key(counts, "sales_orders", "order_lines"))
    return range(starts[order], starts[order + 1])


@lru_cache(maxsize=16)
def _line_products(orders: int, lines: int, products: int, principals: int) -> tuple[int, ...]:
    counts = {"sales_orders": orders, "order_lines": lines, "products": products,
              "principals": principals}  # fmt: skip
    chosen: list[int] = []
    for line in range(lines):
        if line < len(PINNED_LINE_PRODUCTS):
            chosen.append(PINNED_LINE_PRODUCTS[line] % products)
            continue
        taken = set(chosen[order_line_range(line_order(line, counts), counts).start:])
        product = popular_product("line_product", line, counts)
        for attempt in range(6):
            if product not in taken:
                break
            product = popular_product("line_product", line * 7 + attempt + 1, counts)
        chosen.append(product)
    return tuple(chosen)


def line_product(line: int, counts: Mapping[str, int]) -> int:
    return _line_products(*_key(counts, "sales_orders", "order_lines", "products",
                                "principals"))[line]  # fmt: skip


def line_cases(line: int, counts: Mapping[str, int]) -> int:
    if line < len(PINNED_LINE_CASES):
        return PINNED_LINE_CASES[line]
    order = line_order(line, counts)
    draw = rng("order_lines", line, "cases")
    if order_channel(order) == "Key account":
        return draw.choice((5, 6, 8, 10, 10, 12, 15, 20, 24, 30, 40))
    return draw.choices((1, 2, 3, 4, 5, 6, 10, 12), (30, 24, 15, 10, 8, 6, 4, 3))[0]


def line_pieces(line: int, counts: Mapping[str, int]) -> int:
    """Sari-sari owners often add a few loose pieces to the cases."""
    if line < PINNED or order_channel(line_order(line, counts)) != "Pre-sell":
        return 0
    draw = rng("order_lines", line, "pieces")
    return draw.choice((6, 12, 12, 24)) if draw.random() < 0.12 else 0


def line_discount(line: int, counts: Mapping[str, int]) -> float:
    if line < PINNED:
        return 0
    draw = rng("order_lines", line, "discount")
    return draw.choice((2.5, 5, 5, 10)) if draw.random() < 0.15 else 0


def free_goods_line(line: int) -> bool:
    return line >= PINNED and rng("order_lines", line, "free").random() < 0.1


def line_free_goods(line: int, counts: Mapping[str, int], pieces_per_case: int) -> int:
    """A 12+1 scheme gives one free piece for every twelve bought."""
    if not free_goods_line(line):
        return 0
    return line_cases(line, counts) * pieces_per_case // 12


def line_status(line: int, counts: Mapping[str, int]) -> str:
    order = line_order(line, counts)
    state = order_status(order)
    if state == "Delivered":
        return "Delivered"
    if state == "Partially delivered":
        lines = order_line_range(order, counts)
        return "Short-shipped" if line == lines.stop - 1 and len(lines) > 1 else "Delivered"
    if state in {"Cancelled", "Rejected by credit"}:
        return "Cancelled"
    return "Allocated" if state in {"Confirmed", "Picked", "Dispatched"} else "Open"


# Purchasing: purchase orders go to principals that supply, with about six lines each.


def _ordering(principals: int) -> tuple[int, ...]:
    return tuple(item for item in range(principals)
                 if principal_status(item) in {"Active", "On hold"})  # fmt: skip


def po_principal(po: int, counts: Mapping[str, int]) -> int:
    total = counts["principals"]
    ordering = _ordering(total)
    if po < PINNED:
        return ordering[po % len(ordering)]
    return pick("principal_purchase_orders", po, (total,), lambda: ordering, alpha=0.7)


def po_status(po: int) -> str:
    return "Closed" if po < PINNED and po != 1 else status("purchase_orders", po)


def _desired_po_lines(po: int) -> int:
    return 6 if po < PINNED else rng("po_lines", po, "size").choice((3, 4, 5, 6, 6, 7, 8, 9))


@lru_cache(maxsize=16)
def _po_line_starts(pos: int, lines: int) -> tuple[int, ...]:
    return fill(pos, lines, _desired_po_lines)


def po_line_po(line: int, counts: Mapping[str, int]) -> int:
    return owner(_po_line_starts(*_key(counts, "purchase_orders", "po_lines")), line)


def po_line_range(po: int, counts: Mapping[str, int]) -> range:
    starts = _po_line_starts(*_key(counts, "purchase_orders", "po_lines"))
    return range(starts[po], starts[po + 1])


def po_line_product(line: int, counts: Mapping[str, int]) -> int:
    po = po_line_po(line, counts)
    products = principal_products(po_principal(po, counts), counts)
    if not products:
        return popular_product("po_line_product", line, counts)
    position = line - po_line_range(po, counts).start
    start = rng("po_lines", po, "start").randrange(len(products))
    return products[(start + position * 7) % len(products)]


def po_line_cases(line: int) -> int:
    return rng("po_lines", line, "cases").choice((20, 30, 50, 50, 80, 100, 100, 120, 150, 200,
                                                  300))  # fmt: skip


def po_line_received(line: int, counts: Mapping[str, int]) -> int:
    ordered = po_line_cases(line)
    state = po_status(po_line_po(line, counts))
    if state in {"Received", "Closed"}:
        short = line >= PINNED and rng("po_lines", line, "short").random() < 0.08
        return ordered - min(ordered - 1, 2 + line % 5) if short else ordered
    if state == "Partially received":
        return ordered if line % 2 == 0 else 0
    return 0


def po_line_status(line: int, counts: Mapping[str, int]) -> str:
    received, ordered = po_line_received(line, counts), po_line_cases(line)
    state = po_status(po_line_po(line, counts))
    if received == ordered:
        return "Received"
    if received and state == "Closed":
        return "Short-closed"
    return "Partially received" if received else (
        "Short-closed" if state in {"Rejected", "Cancelled"} else "Open")  # fmt: skip


# Warehouse: each delivery of a received order has a goods receipt; lots come from them.


@lru_cache(maxsize=16)
def received_pos(pos: int) -> tuple[int, ...]:
    return tuple(item for item in range(pos)
                 if po_status(item) in {"Closed", "Received", "Partially received"})  # fmt: skip


def receipt_po(receipt: int, counts: Mapping[str, int]) -> int:
    received = received_pos(counts["purchase_orders"])
    if not received:
        return 0
    if receipt < len(received):
        return received[receipt]
    return pick("receipt_po", receipt, (counts["purchase_orders"],), lambda: received)


def second_delivery(receipt: int, counts: Mapping[str, int]) -> bool:
    return receipt >= len(received_pos(counts["purchase_orders"]))


def receipt_status(receipt: int, counts: Mapping[str, int]) -> str:
    pinned = {2: "Counting", 4: "Posted with discrepancy"}.get(receipt)
    if pinned is not None:
        return pinned
    if receipt < PINNED:
        return "Posted"
    if second_delivery(receipt, counts) or po_status(receipt_po(receipt, counts)) == (
        "Partially received"
    ):
        return status("goods_receipts", receipt)
    draw = rng("goods_receipts", receipt, "posted").random()
    return "Posted with discrepancy" if draw < 0.11 else "Posted"


@lru_cache(maxsize=16)
def _lot_sources(receipts: int, pos: int, lines: int, lots: int) -> tuple[tuple[int, int], ...]:
    """(receipt, PO line) behind each received lot; the remaining lots are opening stock."""
    counts = {"goods_receipts": receipts, "purchase_orders": pos, "po_lines": lines}
    sources: list[tuple[int, int]] = []
    for receipt in range(receipts):
        if receipt_status(receipt, counts) not in {"Posted", "Posted with discrepancy"}:
            continue
        for line in po_line_range(receipt_po(receipt, counts), counts):
            if len(sources) < lots and po_line_received(line, counts):
                sources.append((receipt, line))
    return tuple(sources)


def _lot_key(counts: Mapping[str, int]) -> tuple[int, ...]:
    return _key(counts, "goods_receipts", "purchase_orders", "po_lines", "stock_lots")


def lot_receipt(lot: int, counts: Mapping[str, int]) -> tuple[int, int] | None:
    sources = _lot_sources(*_lot_key(counts))
    return sources[lot] if lot < len(sources) else None


def lot_product(lot: int, counts: Mapping[str, int]) -> int:
    source = lot_receipt(lot, counts)
    if source is not None:
        return po_line_product(source[1], counts)
    return popular_product("lot_product", lot, counts)


def lot_status(lot: int) -> str:
    return "Available" if lot < PINNED else status("stock_lots", lot)


def _lots_with(lots: int, allowed: frozenset[str]) -> tuple[int, ...]:
    found = tuple(item for item in range(lots) if lot_status(item) in allowed)
    return found or tuple(range(lots))


def adjustment_reason(adjustment: int) -> str:
    if adjustment < PINNED:
        return ("Cycle count variance", "Damaged in warehouse", "Expired – write-off")[
            adjustment % 3]  # fmt: skip
    return rng("stock_adjustments", adjustment, "reason").choices(
        ("Cycle count variance", "Damaged in warehouse", "Expired – write-off", "Found stock",
         "Pilferage or shortage", "Repack or re-case", "Free samples issued",
         "Wrong lot posted", "Transfer error"), (30, 20, 15, 8, 8, 7, 6, 3, 3))[0]  # fmt: skip


def adjustment_lot(adjustment: int, counts: Mapping[str, int]) -> int:
    lots = counts["stock_lots"]
    if adjustment < PINNED:
        return adjustment % lots
    expired = adjustment_reason(adjustment) == "Expired – write-off"
    allowed = frozenset({"Blocked"} if expired else {"Available", "Pick first (FEFO)",
                                                     "Quarantine", "Depleted"})  # fmt: skip
    return pick(f"lot_adjustments:{expired}", adjustment, (lots,),
                lambda: _lots_with(lots, allowed))  # fmt: skip


def count_product(count: int, counts: Mapping[str, int]) -> int:
    return popular_product("count_product", count, counts)


def count_type(count: int) -> str:
    if count < PINNED:
        return "Cycle A"
    return rng("stock_counts", count, "type").choices(
        ("Cycle A", "Cycle B", "Cycle C", "Spot check", "Full stock take"), (52, 22, 10, 10, 6)
    )[0]


def product_supplier(product: int, counts: Mapping[str, int]) -> int:
    return product_principal(product, counts)
