"""Executive Office, Finance and Procurement links, and the relationship dispatcher."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from functools import lru_cache

from operations.sample.packs.nonprofit.links import (
    RELEASED,
    active_projects,
    activity_project,
    activity_site,
    assistance_activity,
    assistance_beneficiary,
    beneficiary_projects,
    beneficiary_site,
    budget_line_grant,
    donation_campaign,
    donation_donor,
    fund_grant,
    grant_funder,
    indicator_project,
    open_budget_lines,
    pick,
    pledge_campaign,
    pledge_donor,
    pledge_slot,
    project_grants,
    report_grant,
    result_slot,
    rng,
    site_projects,
    status,
    where,
)


def feedback_project(case: int, counts: Mapping[str, int]) -> int:
    return pick("feedback_project", case, active_projects(counts))


def line_count(advance: int, counts: Mapping[str, int]) -> int:
    if advance == 0:
        return 3
    if advance == 3:
        return 1
    state = status("cash_advances", advance, counts)
    if state in {"Partially liquidated", "Overdue"}:
        return 1 + advance % 2
    if state in {"Closed", "Fully liquidated", "Refund due"}:
        return 2 + rng("cash_advances", advance, "lines").randrange(3)
    return 0


@lru_cache(maxsize=16)
def _expense_slots(advances: int, lines: int) -> tuple[tuple[int, int], ...]:
    counts = {"cash_advances": advances}
    slots = [(advance, step) for advance in range(advances)
             for step in range(line_count(advance, counts))]  # fmt: skip
    return tuple(slots[:lines])


def expense_slot(line: int, counts: Mapping[str, int]) -> tuple[int, int] | None:
    slots = _expense_slots(counts["cash_advances"], counts["expense_lines"])
    return slots[line] if line < len(slots) else None


def expense_advance(line: int, counts: Mapping[str, int]) -> int | None:
    slot = expense_slot(line, counts)
    return None if slot is None else slot[0]


def liquidated_lines(advance: int, counts: Mapping[str, int]) -> int:
    slots = _expense_slots(counts["cash_advances"], counts["expense_lines"])
    return sum(1 for owner, _step in slots if owner == advance)


def released_advances(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("cash_advances", counts, RELEASED)


def request_converted(request: int) -> bool:
    return request != 0 and request % 10 not in {3, 6, 8}


@lru_cache(maxsize=16)
def _converted(requests: int) -> tuple[int, ...]:
    return tuple(item for item in range(requests) if request_converted(item))


@lru_cache(maxsize=16)
def ordered_requests(requests: int, orders: int) -> frozenset[int]:
    converted = _converted(requests)
    return frozenset(converted[order % len(converted)] for order in range(orders)) if converted \
        else frozenset()  # fmt: skip


def order_request(order: int, counts: Mapping[str, int]) -> int | None:
    converted = _converted(counts["purchase_requests"])
    return converted[order % len(converted)] if converted else None


def lot_number(order: int, counts: Mapping[str, int]) -> int:
    """1 for a request's first order, 2 for a second lot of the same request."""
    converted = _converted(counts["purchase_requests"])
    return 1 + (order // len(converted) if converted else 0)


def _trading_suppliers(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("suppliers", counts, frozenset({"Active", "Accredited"})) or (0,)


def order_supplier(order: int, counts: Mapping[str, int]) -> int:
    return pick("supplier_orders", order, _trading_suppliers(counts))


def paid_orders(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("purchase_orders", counts, frozenset({"Paid", "Closed"}))


def disbursement_kind(voucher: int, counts: Mapping[str, int]) -> tuple[str, int | None]:
    """The first vouchers release the advances, the next pay orders; the rest are others."""
    advances = released_advances(counts)
    if voucher < len(advances):
        return "advance", advances[voucher]
    orders = paid_orders(counts)
    if voucher - len(advances) < len(orders):
        return "order", orders[voucher - len(advances)]
    return "other", None


def parent_indices(key: str, target: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    """The parents one child record links to; for a link to another department the child is
    the record that names the other one."""
    single = _SINGLE.get(key)
    if single is not None:
        value = single(target, counts)
        return () if value is None else (value,)
    if key == "pledge_donations":
        slot = pledge_slot(target, counts)
        return () if slot is None else (slot[0],)
    if key == "project_sites":
        return site_projects(target, counts)
    if key == "project_beneficiaries":
        return beneficiary_projects(target, counts)
    if key == "project_grants":
        return project_grants(target, counts)
    if key in {"expense_budget_line", "request_budget_line"}:
        return (pick(key, target, open_budget_lines(counts)),)
    if key == "advance_release":
        kind, advance = disbursement_kind(target, counts)
        return (advance,) if kind == "advance" and advance is not None else ()
    if key == "disbursement_order":
        kind, order = disbursement_kind(target, counts)
        return (order,) if kind == "order" and order is not None else ()
    raise ValueError("Unknown Fairhaven relationship")


_SINGLE: dict[str, Callable[[int, Mapping[str, int]], int | None]] = {
    "donor_donations": donation_donor,
    "donor_pledges": pledge_donor,
    "campaign_donations": donation_campaign,
    "campaign_pledges": pledge_campaign,
    "funder_grants": grant_funder,
    "grant_budget_lines": budget_line_grant,
    "grant_report_schedule": report_grant,
    "project_activities": activity_project,
    "site_activities": activity_site,
    "site_beneficiaries": beneficiary_site,
    "beneficiary_assistance": assistance_beneficiary,
    "activity_assistance": assistance_activity,
    "indicator_result_series": lambda result, counts: result_slot(result, counts)[0],
    "indicator_project": indicator_project,
    "feedback_project": feedback_project,
    "fund_grant": fund_grant,
    "advance_expenses": expense_advance,
    "supplier_orders": order_supplier,
    "request_orders": order_request,
}


def reference_parents(
    _module_key: str, _field_key: str, _index: int, _counts: Mapping[str, int]
) -> tuple[tuple[str, int], ...]:
    raise ValueError("Fairhaven has no typed reference fields")
