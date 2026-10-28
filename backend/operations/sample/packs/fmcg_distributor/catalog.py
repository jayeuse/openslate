"""Distributor departments, Sandbox modules, relationships, and size profiles."""

from __future__ import annotations

from typing import Literal

from operations.sample.packs.fmcg_distributor.catalog_finance import ACCOUNTING, CREDIT
from operations.sample.packs.fmcg_distributor.catalog_sales import SALES, TRADE
from operations.sample.packs.fmcg_distributor.catalog_supply import LOGISTICS, PURCHASING, WAREHOUSE
from operations.sample.packs.types import RelationshipSpec, SampleProfile

Cardinality = Literal["one-to-one", "one-to-many", "many-to-many"]

_DEPARTMENTS = (
    ("sales", "Sales"),
    ("trade_marketing", "Key Accounts and Trade Marketing"),
    ("purchasing", "Purchasing and Principal Relations"),
    ("warehouse", "Warehouse and Inventory"),
    ("logistics", "Logistics"),
    ("credit_collections", "Credit and Collections"),
    ("accounting", "Accounting and Claims"),
)

_MODULES = (*SALES, *TRADE, *PURCHASING, *WAREHOUSE, *LOGISTICS, *CREDIT, *ACCOUNTING)


def _link(
    key: str, name: str, source: str, target: str, cardinality: Cardinality = "one-to-many"
) -> RelationshipSpec:
    """A link inside one department: the later (target) record links to its parent."""
    return RelationshipSpec(key, name, source, target, cardinality)


def _names(
    key: str, name: str, source: str, target: str, cardinality: Cardinality = "many-to-many"
) -> RelationshipSpec:
    """A record that names another record links itself to it (plan rule 11)."""
    return RelationshipSpec(key, name, source, target, cardinality, child="source")


_RELATIONSHIPS = (
    _link("beat_outlets", "Outlets", "beats", "outlets"),
    _link("outlet_visits", "Store visits", "outlets", "store_visits"),
    _link("outlet_orders", "Sales orders", "outlets", "sales_orders"),
    _link("order_lines", "Lines", "sales_orders", "order_lines"),
    _link("tour_visits", "Store visits", "route_tours", "store_visits"),
    # A productive pre-sell call yields one order; the order names its visit.
    _names("order_visit", "Store visit", "sales_orders", "store_visits", "one-to-one"),
    _link("principal_products", "Products", "principals", "products"),
    _link("principal_purchase_orders", "Purchase orders", "principals", "purchase_orders"),
    _link("po_lines", "Lines", "purchase_orders", "po_lines"),
    _link("product_po_lines", "PO lines", "products", "po_lines"),
    _link("receipt_lots", "Stock lots", "goods_receipts", "stock_lots"),
    _link("lot_adjustments", "Stock adjustments", "stock_lots", "stock_adjustments"),
    _link("vehicle_trips", "Delivery trips", "vehicles", "delivery_trips"),
    _link("invoice_receipts", "Collection receipts", "sales_invoices", "collection_receipts",
          "many-to-many"),  # fmt: skip
    _link("invoice_followups", "Follow-ups", "sales_invoices", "collection_followups"),
    # Links to records that another department keeps.
    _names("line_product", "Product", "order_lines", "products"),
    _names("tour_vehicle", "Vehicle", "route_tours", "vehicles"),
    _names("promotion_principal", "Principal", "trade_promotions", "principals"),
    _names("receipt_po", "Purchase order", "goods_receipts", "purchase_orders"),
    _names("lot_product", "Product", "stock_lots", "products"),
    _names("count_product", "Product", "stock_counts", "products"),
    _names("return_outlet", "Outlet", "returns", "outlets"),
    _names("return_invoice", "Source invoice", "returns", "sales_invoices"),
    _names("trip_orders", "Sales orders", "delivery_trips", "sales_orders"),
    _names("invoice_outlet", "Outlet", "sales_invoices", "outlets"),
    _names("invoice_order", "Sales order", "sales_invoices", "sales_orders"),
    _names("invoice_tour", "Route tour", "sales_invoices", "route_tours"),
    _names("review_outlet", "Outlet", "credit_reviews", "outlets"),
    _names("ap_invoice_principal", "Principal", "principal_invoices", "principals"),
    _names("ap_invoice_po", "Purchase order", "principal_invoices", "purchase_orders"),
    _names("claim_principal", "Principal", "principal_claims", "principals"),
    _names("claim_promotions", "Trade promotions", "principal_claims", "trade_promotions"),
    _names("claim_returns", "Returns", "principal_claims", "returns"),
    _names("claim_receipt", "Goods receipt", "principal_claims", "goods_receipts"),
)

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, (count + 4) // 5) for key, count in _STANDARD_COUNTS.items()},
    "standard": dict(_STANDARD_COUNTS),
    "large": {key: count * 4 for key, count in _STANDARD_COUNTS.items()},
}
SPECIAL_STATUSES: dict[str, dict[int, str]] = {}
