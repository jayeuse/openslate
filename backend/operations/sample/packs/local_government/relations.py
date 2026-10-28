"""The parents each child record links to, for every city government relationship."""

from __future__ import annotations

from collections.abc import Callable, Mapping

from operations.sample.packs.local_government import links
from operations.sample.packs.local_government import links_finance as finance

Counts = Mapping[str, int]


def _one(rule: Callable[[int, Counts], int | None]) -> Callable[[int, Counts], tuple[int, ...]]:
    def parents(target: int, counts: Counts) -> tuple[int, ...]:
        parent = rule(target, counts)
        return () if parent is None else (parent,)

    return parents


def _receipt_order(receipt: int, counts: Counts) -> int | None:
    slot = links.receipt_slot(receipt, counts)
    return None if slot is None else slot[0]


_RULES: dict[str, Callable[[int, Counts], tuple[int, ...]]] = {
    "establishment_applications": _one(links.application_establishment),
    "establishment_inspections": _one(links.inspection_establishment),
    "establishment_notices": _one(links.notice_establishment),
    "inspection_notices": _one(links.notice_inspection),
    "permit_inspections": _one(links.inspection_permit),
    "request_work_orders": links.work_order_requests,
    "order_receipts": _one(_receipt_order),
    "appropriation_obligations": _one(finance.obr_appropriation),
    "obligation_vouchers": _one(finance.dv_obligation),
    "project_requests": finance.project_requests,
    "project_bids": _one(finance.bid_project),
    "supplier_bids": _one(finance.bid_supplier),
    "project_purchase_orders": _one(finance.po_project),
    "supplier_purchase_orders": _one(finance.po_supplier),
    "order_acceptance_reports": _one(lambda iar, counts: finance.iar_slot(iar, counts)[0]),
    "measure_communications": finance.communication_measures,
    "order_application": _one(finance.oop_application),
    "order_building_permit": _one(finance.oop_permit),
    "release_voucher": _one(finance.release_voucher),
    "obligation_purchase_order": _one(finance.obr_po),
    "voucher_acceptance_reports": finance.dv_iars,
}


def parent_indices(key: str, target: int, counts: Counts) -> tuple[int, ...]:
    """The parents one child record links to; for a link to another department the child is
    the record that names the other one."""
    rule = _RULES.get(key)
    if rule is None:
        raise ValueError("Unknown city government relationship")
    return rule(target, counts)


def reference_parents(
    module_key: str, field_key: str, index: int, counts: Counts
) -> tuple[tuple[str, int], ...]:
    """The records in the same department that a field's visible code names."""
    if (module_key, field_key) == ("official_receipts", "oop_reference"):
        order = _receipt_order(index, counts)
        return () if order is None else (("payment_orders", order),)
    raise ValueError("Unknown city government reference field")
