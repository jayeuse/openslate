"""Each record's main working-day offset, taken from the records it follows (spec R3)."""

from __future__ import annotations

from collections.abc import Callable

from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_quality as quality
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer.plan_base import Counts, between


def _line(line: int, counts: Counts) -> int:
    order = sales.line_slot(line, counts)[0]
    return sales.order_wd(order) - between("sales_order_lines", line, 2, 8)


def _master(module: str) -> Callable[[int, Counts], int]:
    return lambda index, _counts: between(module, index, 0, 60, "master")


_MAIN: dict[str, Callable[[int, Counts], int]] = {
    "sales_orders": lambda index, _counts: sales.order_wd(index),
    "sales_order_lines": _line,
    "shipments": sales.shipment_wd,
    "customer_invoices": sales.invoice_wd,
    "customer_payments": sales.payment_wd,
    "purchase_orders": lambda index, _counts: supply.po_wd(index),
    "material_lots": supply.lot_wd,
    "supplier_invoices": supply.supplier_invoice_wd,
    "production_orders": lambda index, _counts: plant.wo_wd(index),
    "batch_records": plant.batch_wd,
    "finished_goods_lots": plant.finished_wd,
    "shift_reports": lambda index, counts: plant.report_slot(index, counts)[0],
    "downtime_events": lambda index, counts: plant.report_slot(
        plant.downtime_report(index, counts), counts)[0],  # fmt: skip
    "food_safety_logs": lambda index, counts: plant.log_slot(index, counts)[0],
    "ncrs": quality.ncr_wd,
    "capas": quality.capa_wd,
    "maintenance_work_orders": quality.mwo_wd,
    "equipment": lambda index, _counts: between("equipment", index, 1, 60, "pm"),
}


def main_wd(module_key: str, index: int, counts: Counts) -> int:
    rule = _MAIN.get(module_key) or _master(module_key)
    return rule(index, counts)
