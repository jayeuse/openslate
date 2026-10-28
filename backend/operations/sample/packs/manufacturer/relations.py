"""The parents each child record links to, for every sauce plant relationship."""

from __future__ import annotations

from collections.abc import Callable

from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_quality as quality
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer.plan_base import Counts, bom_product, customer_of_order

Rule = Callable[[int, Counts], tuple[int, ...]]


def _one(rule: Callable[[int, Counts], int | None]) -> Rule:
    def parents(child: int, counts: Counts) -> tuple[int, ...]:
        parent = rule(child, counts)
        return () if parent is None else (parent,)

    return parents


def _slot(rule: Callable[[int, Counts], tuple[int, object] | None]) -> Rule:
    def parents(child: int, counts: Counts) -> tuple[int, ...]:
        slot = rule(child, counts)
        return () if slot is None else (slot[0],)

    return parents


def _equipment_center(item: int, counts: Counts) -> int | None:
    return quality.equipment_slot(item, counts)[0]


def _invoice_customer(invoice: int, counts: Counts) -> int:
    return sales.invoice_customer(invoice, counts)


_RULES: dict[str, Rule] = {
    "customer_orders": _one(customer_of_order),
    "order_lines": _slot(sales.line_slot),
    "product_boms": _one(bom_product),
    "supplier_purchase_orders": _one(supply.po_supplier),
    "material_purchase_orders": _one(supply.po_material),
    "product_production_orders": _one(plant.wo_product),
    "work_center_reports": _one(lambda report, counts: plant.report_slot(report, counts)[1]),
    "report_downtime": _one(plant.downtime_report),
    "equipment_work_orders": _one(quality.mwo_equipment),
    "invoice_payments": _slot(sales.payment_slot),
    "ncr_finished_lots": lambda ncr, counts: quality.ncr_links(ncr, counts).get("finished", ()),
    "capa_ncrs": quality.capa_ncrs,
    "line_product": _one(sales.line_product),
    "order_work_center": _one(plant.wo_line),
    "order_sales_order": _one(plant.wo_sales_order),
    "batch_production_order": _slot(plant.batch_slot),
    "batch_material_lots": plant.batch_lots,
    "lot_purchase_order": _one(supply.lot_po),
    "shipment_sales_order": _slot(sales.shipment_slot),
    "shipment_finished_lots": plant.shipment_lots,
    "finished_lot_order": _slot(plant.finished_slot),
    "log_work_center": _one(lambda log, counts: plant.log_slot(log, counts)[1]),
    "ncr_material_lots": lambda ncr, counts: quality.ncr_links(ncr, counts).get("lots", ()),
    "ncr_batches": lambda ncr, counts: quality.ncr_links(ncr, counts).get("batches", ()),
    "equipment_work_center": _one(_equipment_center),
    "work_order_downtime": _one(quality.mwo_downtime),
    "invoice_shipment": _one(sales.invoice_shipment),
    "invoice_customer": _one(_invoice_customer),
    "supplier_invoice_order": _one(supply.supplier_invoice_po),
}


def parent_indices(key: str, child: int, counts: Counts) -> tuple[int, ...]:
    """The parents one child links to; for a link that names another record, the child is
    the record that names it."""
    rule = _RULES.get(key)
    if rule is None:
        raise ValueError("Unknown sauce plant relationship")
    return rule(child, counts)


def reference_parents(
    module_key: str, field_key: str, index: int, counts: Counts
) -> tuple[tuple[str, int], ...]:
    """The invoice a payment's remittance names, in the same department."""
    if (module_key, field_key) == ("customer_payments", "remit_invoice"):
        slot = sales.payment_slot(index, counts)
        return () if slot is None else (("customer_invoices", slot[0]),)
    raise ValueError("Unknown sauce plant reference field")
