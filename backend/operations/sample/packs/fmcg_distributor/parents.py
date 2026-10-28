"""The parents each child record links to, for every distributor relationship."""

from __future__ import annotations

from collections.abc import Callable, Mapping

from operations.sample.packs.fmcg_distributor import lines, links, links_claims, links_finance

Counts = Mapping[str, int]


def _one(value: int | None) -> tuple[int, ...]:
    return () if value is None else (value,)


def _lot_receipt(lot: int, counts: Counts) -> tuple[int, ...]:
    source = lines.lot_receipt(lot, counts)
    return () if source is None else (source[0],)


def _invoice_order(index: int, counts: Counts) -> tuple[int, ...]:
    bill = links_finance.invoice(index, counts)
    return (bill.source,) if bill.kind == "order" else ()


def _invoice_tour(index: int, counts: Counts) -> tuple[int, ...]:
    bill = links_finance.invoice(index, counts)
    return (bill.source,) if bill.kind == "van" else ()


def _visit_tour(visit: int, counts: Counts) -> tuple[int, ...]:
    if visit < links.presell_visit_count(counts):
        return ()
    return (links.visit_tour(visit, counts)[0],)


_PARENTS: dict[str, Callable[[int, Counts], tuple[int, ...]]] = {
    "beat_outlets": lambda i, c: _one(links.outlet_beat(i, c)),
    "outlet_visits": lambda i, c: (links.visit_outlet(i, c),),
    "outlet_orders": lambda i, c: (links.order_outlet(i, c),),
    "order_lines": lambda i, c: (lines.line_order(i, c),),
    "tour_visits": _visit_tour,
    "order_visit": lambda i, c: _one(links.order_visit(i, c)),
    "principal_products": lambda i, c: (links.product_principal(i, c),),
    "principal_purchase_orders": lambda i, c: (lines.po_principal(i, c),),
    "po_lines": lambda i, c: (lines.po_line_po(i, c),),
    "product_po_lines": lambda i, c: (lines.po_line_product(i, c),),
    "receipt_lots": _lot_receipt,
    "lot_adjustments": lambda i, c: (lines.adjustment_lot(i, c),),
    "vehicle_trips": lambda i, c: (links.trip_vehicle(i, c),),
    "invoice_receipts": lambda i, c: links_finance.receipt(i, c).invoices,
    "invoice_followups": lambda i, c: (links_finance.followup_invoice(i, c),),
    "line_product": lambda i, c: (lines.line_product(i, c),),
    "tour_vehicle": lambda i, c: (links.tour_vehicle(i, c),),
    "promotion_principal": lambda i, c: (links_claims.promotion_principal(i, c),),
    "receipt_po": lambda i, c: (lines.receipt_po(i, c),),
    "lot_product": lambda i, c: (lines.lot_product(i, c),),
    "count_product": lambda i, c: (lines.count_product(i, c),),
    "return_outlet": lambda i, c: (links_claims.return_outlet(i, c),),
    "return_invoice": lambda i, c: _one(links_claims.return_invoice(i, c)),
    "trip_orders": lambda i, c: links.trip_orders(i, c),
    "invoice_outlet": lambda i, c: (links_finance.invoice(i, c).outlet,),
    "invoice_order": _invoice_order,
    "invoice_tour": _invoice_tour,
    "review_outlet": lambda i, c: (links_claims.review_outlet(i, c),),
    "ap_invoice_principal": lambda i, c: (
        lines.po_principal(links_claims.ap_invoice_po(i, c), c),),
    "ap_invoice_po": lambda i, c: (links_claims.ap_invoice_po(i, c),),
    "claim_principal": lambda i, c: (links_claims.claim_principal(i, c),),
    "claim_promotions": lambda i, c: _one(links_claims.claim_promotion(i, c)),
    "claim_returns": lambda i, c: links_claims.claim_returns(i, c),
    "claim_receipt": lambda i, c: _one(links_claims.claim_receipt(i, c)),
}


def parent_indices(key: str, child: int, counts: Counts) -> tuple[int, ...]:
    """The parents one child record links to; for a link to another department the child is
    the record that names the other one."""
    rule = _PARENTS.get(key)
    if rule is None:
        raise ValueError("Unknown distributor relationship")
    return tuple(dict.fromkeys(rule(child, counts)))


def reference_parents(
    module_key: str, field_key: str, index: int, counts: Counts
) -> tuple[tuple[str, int], ...]:
    del module_key, field_key, index, counts
    raise ValueError("The distributor keeps no typed codes for linked records")
