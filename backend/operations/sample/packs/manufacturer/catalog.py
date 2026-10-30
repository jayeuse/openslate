"""Sauce plant departments, Sandbox modules, relationships, and size profiles."""

from __future__ import annotations

from typing import Literal

from operations.sample.packs.manufacturer.catalog_commercial import PLANNING, SALES
from operations.sample.packs.manufacturer.catalog_plant import MANUFACTURING, QUALITY, WAREHOUSE
from operations.sample.packs.manufacturer.catalog_support import FINANCE, MAINTENANCE
from operations.sample.packs.types import RelationshipSpec, SampleProfile

Cardinality = Literal["one-to-one", "one-to-many", "many-to-many"]

_DEPARTMENTS = (
    ("sales", "Sales and Customer Service"),
    ("planning", "Planning and Purchasing"),
    ("warehouse", "Warehouse and Logistics"),
    ("manufacturing", "Production"),
    ("quality", "Quality and Food Safety"),
    ("maintenance", "Maintenance"),
    ("finance", "Finance"),
)

_MODULES = (*SALES, *PLANNING, *WAREHOUSE, *MANUFACTURING, *QUALITY, *MAINTENANCE, *FINANCE)


def _link(key: str, name: str, source: str, target: str) -> RelationshipSpec:
    """A one-to-many link inside one department: the later (target) record links itself."""
    return RelationshipSpec(key, name, source, target, "one-to-many")


def _names(
    key: str, name: str, source: str, target: str, cardinality: Cardinality = "many-to-many"
) -> RelationshipSpec:
    """The record that names another one links itself once both exist (plan rule 11).

    A child that names one parent with several children stays many-to-many (contract rule 5).
    """
    return RelationshipSpec(key, name, source, target, cardinality, child="source")


_RELATIONSHIPS = (
    _link("customer_orders", "Sales orders", "customers", "sales_orders"),
    _link("order_lines", "Order lines", "sales_orders", "sales_order_lines"),
    _link("product_boms", "Bills of materials", "products", "boms"),
    _link("supplier_purchase_orders", "Purchase orders", "suppliers", "purchase_orders"),
    _link("material_purchase_orders", "Purchase orders", "materials", "purchase_orders"),
    _link("product_production_orders", "Production orders", "products", "production_orders"),
    _link("work_center_reports", "Shift reports", "work_centers", "shift_reports"),
    _link("report_downtime", "Downtime events", "shift_reports", "downtime_events"),
    _link("equipment_work_orders", "Work orders", "equipment", "maintenance_work_orders"),
    _link("invoice_payments", "Payments", "customer_invoices", "customer_payments"),
    _names("ncr_finished_lots", "Affected finished lots", "ncrs", "finished_goods_lots"),
    _names("capa_ncrs", "Nonconformances", "capas", "ncrs"),
    # Links to records kept in another department.
    _names("line_product", "Product", "sales_order_lines", "products"),
    _names("order_work_center", "Filling line", "production_orders", "work_centers"),
    _names("order_sales_order", "Make-to-order sales order", "production_orders", "sales_orders"),
    _names("batch_production_order", "Production order", "batch_records", "production_orders"),
    _names("batch_material_lots", "Material lots used", "batch_records", "material_lots"),
    _names("lot_purchase_order", "Purchase order", "material_lots", "purchase_orders"),
    _names("shipment_sales_order", "Sales order", "shipments", "sales_orders"),
    _names("shipment_finished_lots", "Finished lots shipped", "shipments",
           "finished_goods_lots"),  # fmt: skip
    _names("finished_lot_order", "Production order", "finished_goods_lots",
           "production_orders"),  # fmt: skip
    _names("log_work_center", "Line", "food_safety_logs", "work_centers"),
    _names("ncr_material_lots", "Affected material lots", "ncrs", "material_lots"),
    _names("ncr_batches", "Affected batches", "ncrs", "batch_records"),
    _names("equipment_work_center", "Work center", "equipment", "work_centers"),
    _names("work_order_downtime", "Breakdown", "maintenance_work_orders", "downtime_events",
           "one-to-one"),  # fmt: skip
    _names("invoice_shipment", "Shipment", "customer_invoices", "shipments", "one-to-one"),
    _names("invoice_customer", "Bill-to customer", "customer_invoices", "customers"),
    _names("supplier_invoice_order", "Purchase order", "supplier_invoices", "purchase_orders"),
)

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, (count + 4) // 5) for key, count in _STANDARD_COUNTS.items()},
    "standard": dict(_STANDARD_COUNTS),
    "large": {key: count * 4 for key, count in _STANDARD_COUNTS.items()},
}
SPECIAL_STATUSES: dict[str, dict[int, str]] = {}
