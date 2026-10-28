"""Procure to pay: purchase orders, material lots received against them, supplier invoices."""

from __future__ import annotations

from functools import cache, lru_cache

from operations.sample.packs.manufacturer.plan_base import (
    PINNED,
    Counts,
    Frozen,
    between,
    counted,
    draw,
    frozen,
    material_info,
    material_supplier,
    rng,
)
from operations.sample.packs.manufacturer.realism import LOT_CLASSES, PO_CLASSES
from operations.sample.realism import skewed_parent

RECEIVING = frozenset({"Partially received", "Received", "Closed"})
USABLE_LOTS = frozenset({"Consumed", "Released"})
_PO_WD = {
    "Closed": (18, 55), "Received": (8, 30), "Partially received": (5, 25),
    "Confirmed": (2, 12), "Sent": (1, 6), "Draft": (0, 20), "Cancelled": (3, 40),
}  # fmt: skip


@cache
def po_class(po: int) -> str:
    return "Closed" if po < PINNED else draw("purchase_orders", po, PO_CLASSES)


@cache
def po_wd(po: int) -> int:
    return between("purchase_orders", po, *_PO_WD[po_class(po)])


@counted
def po_material(po: int, counts: Counts) -> int:
    if po == 0:
        return 2 % counts["materials"]  # Tomato paste totes: the receipt rejected for mold.
    return skewed_parent("material_purchase_orders", po, counts["materials"])


@counted
def po_supplier(po: int, counts: Counts) -> int:
    alternate = po >= PINNED and rng("purchase_orders", po, "alternate").random() < 0.1
    return material_supplier(po_material(po, counts), counts, alternate)


@lru_cache(maxsize=16)
def _lot_table(frozen_counts: Frozen) -> tuple[tuple[int, int], ...]:
    """(purchase order, receipt number) for each lot: 1.3 receipts for each received PO."""
    counts = dict(frozen_counts)
    receiving = [po for po in range(counts["purchase_orders"]) if po_class(po) in RECEIVING]
    rows = [(po, 1) for po in receiving]
    seconds = [po for po in receiving if po_class(po) != "Partially received" and po >= PINNED]
    stream = rng("material_lots", counts["material_lots"])
    stream.shuffle(seconds)
    rows += [(po, 2) for po in seconds]
    return tuple(rows[: counts["material_lots"]])


def lot_slot(lot: int, counts: Counts) -> tuple[int, int] | None:
    table = _lot_table(frozen(counts))
    return table[lot] if lot < len(table) else None


def lot_po(lot: int, counts: Counts) -> int | None:
    slot = lot_slot(lot, counts)
    return None if slot is None else slot[0]


def lot_material(lot: int, counts: Counts) -> int:
    po = lot_po(lot, counts)
    return po_material(po, counts) if po is not None else lot % counts["materials"]


@counted
def lot_wd(lot: int, counts: Counts) -> int:
    slot = lot_slot(lot, counts)
    if slot is None:
        return between("material_lots", lot, 0, 30)
    po, receipt = slot
    first = max(0, po_wd(po) - between("material_lots", lot, 2, 8, "lead"))
    if receipt == 1:
        return first
    return max(0, first - between("material_lots", lot, 3, 10, "second"))


@counted
def lot_class(lot: int, counts: Counts) -> str:
    if lot == 0:
        return "Rejected"  # The rejected receipt that the create rule flags for an NCR.
    if lot < PINNED:
        return "Consumed"
    if lot_wd(lot, counts) <= 1:
        return "Quarantine" if rng("material_lots", lot, "new").random() < 0.85 else "Released"
    return draw("material_lots", lot, LOT_CLASSES)


@lru_cache(maxsize=16)
def lots_received(frozen_counts: Frozen) -> tuple[int, ...]:
    """Usable ingredient lots, oldest receipt first."""
    counts = dict(frozen_counts)
    usable = [lot for lot in range(counts["material_lots"])
              if lot_class(lot, counts) in USABLE_LOTS
              and material_info(lot_material(lot, counts))[1] == "Ingredient"]  # fmt: skip
    return tuple(sorted(usable, key=lambda lot: (-lot_wd(lot, counts), lot)))


# Supplier invoices: one for each received purchase order, a second for split deliveries.
@lru_cache(maxsize=16)
def _invoice_table(frozen_counts: Frozen) -> tuple[int, ...]:
    counts = dict(frozen_counts)
    received = [po for po in range(counts["purchase_orders"])
                if po_class(po) in {"Closed", "Received"}]  # fmt: skip
    partial = [po for po in range(counts["purchase_orders"])
               if po_class(po) == "Partially received"]  # fmt: skip
    rows = received + partial
    seconds = [po for po in received if po >= PINNED]
    rows += seconds[: max(0, counts["supplier_invoices"] - len(rows))]
    return tuple(rows[: counts["supplier_invoices"]])


def supplier_invoice_po(invoice: int, counts: Counts) -> int | None:
    table = _invoice_table(frozen(counts))
    return table[invoice] if invoice < len(table) else None


def po_first_lot(po: int, counts: Counts) -> int | None:
    table = _lot_table(frozen(counts))
    return next((lot for lot, slot in enumerate(table) if slot == (po, 1)), None)


@counted
def supplier_invoice_wd(invoice: int, counts: Counts) -> int:
    po = supplier_invoice_po(invoice, counts)
    if po is None:
        return between("supplier_invoices", invoice, 0, 20)
    lot = po_first_lot(po, counts)
    received = lot_wd(lot, counts) if lot is not None else max(0, po_wd(po) - 5)
    return max(0, received - between("supplier_invoices", invoice, 1, 6))


@counted
def supplier_invoice_class(invoice: int, counts: Counts) -> str:
    po = supplier_invoice_po(invoice, counts)
    if invoice < PINNED or po is None:
        return "Paid" if po is not None else "Received"
    if supplier_invoice_wd(invoice, counts) <= 1:
        return "Received"
    weights = {
        "Closed": {"Paid": 90, "Approved": 10},
        "Received": {"Approved": 40, "Matched": 35, "Exception": 15, "Disputed": 10},
    }.get(po_class(po), {"Matched": 50, "Exception": 30, "Received": 20})
    return draw("supplier_invoices", invoice, weights)
