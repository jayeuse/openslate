"""Which parent records each generated child record links to."""

from __future__ import annotations

from collections.abc import Mapping


def receipt_order_index(receipt_index: int) -> int:
    """Skip cancelled PO 3; the final receipt completes the first PO."""
    return 0 if receipt_index == 2 else receipt_index


def payment_invoice_index(payment_index: int) -> int:
    return payment_index if payment_index < 2 else payment_index + 1


def invoice_payment_index(invoice_index: int, counts: Mapping[str, int]) -> int | None:
    """The payment linked to an invoice, if the invoice has one."""
    if invoice_index == 2 or invoice_index > counts["payments"]:
        return None
    if invoice_index < 2:
        return invoice_index if invoice_index < counts["payments"] else None
    return invoice_index - 1


def parent_indices(key: str, target: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    """Return the parent record indexes that one child record links to.

    For most links the child is the target. For links to another department the child is
    the referencing source record, and the result is the indexes of the records it names.
    """
    if key == "equipment_work_orders":
        return ((target * 2) % counts["equipment"], (target * 2 + 1) % counts["equipment"])
    if key == "purchase_order_lines":
        return (target // 2,)
    if key == "purchase_order_receipts":
        return (receipt_order_index(target),)
    if key in {"product_movements", "warehouse_movements"}:
        receipt_index, movement_index = divmod(target, 5)
        order_index = receipt_order_index(receipt_index)
        if key == "warehouse_movements":
            return (order_index % counts["warehouses"],)
        line_index = 0 if movement_index < 3 else 1
        return ((order_index * 2 + line_index) % counts["products"],)
    if key == "invoice_payments":
        return (payment_invoice_index(target),)
    if key == "invoice_credits":
        return ((target + 3) % counts["invoices"],)
    if key == "movement_receipt":
        return (target // 5,)
    if key == "work_order_products":
        products = counts["products"]
        return ((target * 3) % products, (target * 3 + 13) % products)
    return (target % counts[_PARENTS[key]],)


_PARENTS = {
    "customer_contacts": "customers",
    "customer_quotes": "customers",
    "customer_orders": "customers",
    "site_contracts": "customer_sites",
    "site_requests": "customer_sites",
    "request_updates": "service_requests",
    "work_order_inspections": "work_orders",
    "equipment_plans": "equipment",
    "supplier_orders": "suppliers",
    "warehouse_counts": "warehouses",
    "product_counts": "products",
    "site_customer": "customers",
    "invoice_customer": "customers",
    "invoice_sales_order": "sales_orders",
    "request_equipment": "equipment",
    "line_product": "products",
    "order_warehouse": "warehouses",
}


def reference_parents(
    module_key: str, field_key: str, index: int, counts: Mapping[str, int]
) -> tuple[tuple[str, int], ...]:
    """Harbor names other records only through relationships, never through typed codes."""
    raise ValueError("Unknown reference field")


REFERENCE_FIELDS: tuple[tuple[str, str], ...] = ()
