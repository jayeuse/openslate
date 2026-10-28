"""Sauce plant record statuses (spec R1). A status that a linked record decides follows the
plan tables; the others are drawn from the pack's weights. Named cases stay exact."""

from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache

from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_quality as quality
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer.plan_base import PINNED, Counts, Frozen, draw
from operations.sample.packs.manufacturer.realism import (
    CAPA_STATUS,
    SUPPLIER_IDLE,
    WORK_CENTER_STATUS,
)


@lru_cache(maxsize=16)
def _active_suppliers(frozen_counts: Frozen) -> frozenset[int]:
    counts = dict(frozen_counts)
    return frozenset(supply.po_supplier(po, counts) for po in range(counts["purchase_orders"]))


def _supplier(index: int, counts: Counts) -> str:
    if index < PINNED or index in _active_suppliers(base.frozen(counts)):
        return "Conditional" if base.rng("suppliers", index, "cond").random() < 0.1 else "Approved"
    return draw("suppliers", index, SUPPLIER_IDLE)


@lru_cache(maxsize=16)
def _product_boms(frozen_counts: Frozen) -> dict[int, tuple[int, ...]]:
    counts = dict(frozen_counts)
    found: dict[int, list[int]] = {}
    for bom in range(counts["boms"]):
        found.setdefault(base.bom_product(bom, counts), []).append(bom)
    return {key: tuple(value) for key, value in found.items()}


def bom_product(bom: int, counts: Counts) -> int:
    return base.bom_product(bom, counts)


def bom_version(bom: int, counts: Counts) -> int:
    return _product_boms(base.frozen(counts))[bom_product(bom, counts)].index(bom) + 1


def _bom(index: int, counts: Counts) -> str:
    product = bom_product(index, counts)
    versions = _product_boms(base.frozen(counts))[product]
    if index != versions[-1]:
        return "Superseded"
    label = base.product_class(product)
    if label == "Development":
        return "Pending approval" if index % 2 else "Draft"
    return "Obsolete" if label == "Discontinued" else "Active"


def _shift_report(index: int, counts: Counts) -> str:
    day = plant.report_slot(index, counts)[0]
    if day == 0:
        return "Draft" if plant.report_slot(index, counts)[2] == "B" else "Submitted"
    if day <= 2:
        return draw("shift_reports", index, {"Submitted": 60, "Verified": 40})
    return draw("shift_reports", index, {"Verified": 97, "Submitted": 3})


def _downtime(index: int, counts: Counts) -> str:
    day = plant.report_slot(plant.downtime_report(index, counts), counts)[0]
    if day == 0:
        return "Open"
    if day <= 3:
        return draw("downtime_events", index, {"Coded": 70, "Reviewed": 30})
    return draw("downtime_events", index, {"Reviewed": 92, "Coded": 8})


def _log(index: int, counts: Counts) -> str:
    day = plant.log_slot(index, counts)[0]
    if plant.log_deviation(index) and day <= 6:
        return "Deviation"
    if day == 0:
        return draw("food_safety_logs", index, {"Completed": 70, "Open": 30})
    if day <= 6:  # Records are reviewed within 7 working days (21 CFR 117.165).
        return draw("food_safety_logs", index, {"Completed": 55, "Verified": 45})
    return "Verified"


def _capa(index: int, _counts: Counts) -> str:
    return "Open" if index == 0 else draw("capas", index, CAPA_STATUS)


def _work_center(index: int, _counts: Counts) -> str:
    return "Running" if index < PINNED else draw("work_centers", index, WORK_CENTER_STATUS)


_STATUS: dict[str, Callable[[int, Counts], str]] = {
    "customers": base.customer_status,
    "sales_orders": lambda index, _counts: sales.order_class(index),
    "sales_order_lines": sales.line_class,
    "products": lambda index, _counts: base.product_class(index),
    "materials": lambda index, _counts: base.material_status(index),
    "boms": _bom,
    "suppliers": _supplier,
    "purchase_orders": lambda index, _counts: supply.po_class(index),
    "production_orders": lambda index, _counts: plant.wo_class(index),
    "material_lots": supply.lot_class,
    "shipments": sales.shipment_class,
    "work_centers": _work_center,
    "batch_records": plant.batch_class,
    "shift_reports": _shift_report,
    "downtime_events": _downtime,
    "finished_goods_lots": plant.finished_class,
    "food_safety_logs": _log,
    "ncrs": quality.ncr_status,
    "capas": _capa,
    "equipment": lambda index, _counts: quality.equipment_status(index),
    "maintenance_work_orders": quality.mwo_status,
    "supplier_invoices": supply.supplier_invoice_class,
    "customer_invoices": sales.invoice_status,
    "customer_payments": sales.payment_status,
}


def status_label(module_key: str, index: int, counts: Counts) -> str:
    return _status_label(module_key, index, base.frozen(counts))


@lru_cache(maxsize=262_144)
def _status_label(module_key: str, index: int, frozen_counts: Frozen) -> str:
    return _STATUS[module_key](index, dict(frozen_counts))
