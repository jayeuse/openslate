"""City government record statuses (spec R1). A status that a linked record decides follows
the index rules in ``links`` and ``links_finance``; the others are drawn from the pack's
weights. Named cases below index ``PINNED`` stay exact.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Mapping
from functools import lru_cache

from operations.sample.packs.local_government import links
from operations.sample.packs.local_government import links_finance as finance
from operations.sample.packs.local_government.links import ASSESSED_APPLICATION, PINNED
from operations.sample.packs.local_government.realism import (
    APPLICATION_DONE,
    REQUEST_UNASSIGNED,
    STATUS_WEIGHTS,
    VOUCHER_OPEN,
)
from operations.sample.realism import weighted_label

Counts = Mapping[str, int]
_SETTLED_RELEASES = frozenset({"Released", "Cleared", "Stale"})
_OPEN_NOTICES = frozenset({"Served", "Escalated", "Draft"})
_WORK_TO_REQUEST = {"Completed": "Fixed", "Verified": "Fixed", "Planned": "Action scheduled",
                    "Dispatched": "In progress", "On site": "In progress",
                    "On hold for materials": "In progress",
                    "Cancelled": "No further action"}  # fmt: skip


def _draw(seed: int | str, module: str, index: int, weights: Mapping[str, float]) -> str:
    return weighted_label(random.Random(f"{seed}:{module}:{index}:status"), weights)


def _weights(module: str) -> Mapping[str, float]:
    return STATUS_WEIGHTS[module]


def _top(module: str) -> str:
    return next(iter(STATUS_WEIGHTS[module]))


def notice_status(notice: int) -> str:
    if notice == 0:
        return "Draft"  # Drafted after the failed inspection that the rule flagged.
    if notice < PINNED:
        return _top("enforcement_notices")
    return _draw("lg", "enforcement_notices", notice, _weights("enforcement_notices"))


@lru_cache(maxsize=16)
def _establishment_notices(notices: int, inspections: int, establishments: int
                           ) -> dict[int, tuple[int, ...]]:  # fmt: skip
    counts = {"enforcement_notices": notices, "business_inspections": inspections,
              "business_establishments": establishments}  # fmt: skip
    found: dict[int, list[int]] = {}
    for notice in range(notices):
        found.setdefault(links.notice_establishment(notice, counts), []).append(notice)
    return {key: tuple(value) for key, value in found.items()}


def establishment_status(establishment: int, counts: Counts) -> str:
    if establishment < PINNED:
        return "Active"
    apps = links.establishment_apps(establishment, counts)
    if any(links.application_type(app, counts) == "Retirement" for app in apps):
        return "Retired"
    table = _establishment_notices(counts["enforcement_notices"],
                                   counts["business_inspections"],
                                   counts["business_establishments"])  # fmt: skip
    notices = table.get(establishment, ())
    if any(links.notice_type(item, counts) == "Closure order"
           and notice_status(item) in _OPEN_NOTICES for item in notices):  # fmt: skip
        return "Closed by order"
    if any(notice_status(item) in _OPEN_NOTICES for item in notices):
        return "Under notice"
    return "Active" if apps else "Delinquent"


def application_status(app: int, seed: int, counts: Counts) -> str:
    if app == ASSESSED_APPLICATION:
        return "Assessed"  # The live rule flags it; the order of payment follows.
    stage = finance.application_stage(app)
    if stage != "assessed":
        return stage
    if not finance.application_paid(app, counts):
        return "Assessed"
    if app < PINNED:
        return "Released"
    return _draw(seed, "permit_applications", app, APPLICATION_DONE)


@lru_cache(maxsize=16)
def _permit_orders(orders: int, frozen: tuple[tuple[str, int], ...]) -> dict[int, list[int]]:
    counts = dict(frozen)
    found: dict[int, list[int]] = {}
    for order in range(orders):
        permit = finance.oop_permit(order, counts)
        if permit is not None:
            found.setdefault(permit, []).append(order)
    return found


def permit_status(permit: int, counts: Counts) -> str:
    stage = finance.permit_stage(permit, counts)
    if stage != "For payment":
        return stage
    frozen = tuple(sorted(counts.items()))
    orders = _permit_orders(counts["payment_orders"], frozen).get(permit, [])
    return "Paid" if any(links.paid_installments(item, counts) for item in orders) else stage


def work_order_status(order: int) -> str:
    return "Completed" if order < PINNED else _draw("lg", "work_orders", order,
                                                    _weights("work_orders"))  # fmt: skip


def request_status(request: int, seed: int, counts: Counts) -> str:
    order = links.request_work_order(request, counts)
    if order is not None:
        return _WORK_TO_REQUEST[work_order_status(order)]
    service = links.service_type(request)
    if service == "Leaking water main":
        return "Not responsible"  # The water district's line, not the city's.
    if service in {"Stray animals", "Illegal construction report"}:
        return "Internal referral"
    return _draw(seed, "service_requests", request, REQUEST_UNASSIGNED)


def order_status(order: int, counts: Counts) -> str:
    label = links.oop_class(order)
    if label in {"Reassessed", "Cancelled"}:
        return label
    planned, paid = finance.amount_installment(order), links.paid_installments(order, counts)
    if paid == 0:
        return "Unpaid"
    return "Paid" if paid >= planned else "Partially paid"


def deposit_status(report: int, seed: int, counts: Counts) -> str:
    newest = counts["deposit_reports"] - 1 - report
    if newest < 2:
        return ("Draft", "Submitted")[newest]  # Today's report and yesterday's.
    if report < PINNED:
        return _top("deposit_reports")
    return _draw(seed, "deposit_reports", report, _weights("deposit_reports"))


def release_status(release: int) -> str:
    if release < PINNED:
        return "Cleared"
    return _draw("lg", "payment_releases", release, _weights("payment_releases"))


def voucher_paid(dv: int, counts: Counts) -> bool:
    return dv < counts["payment_releases"] and release_status(dv) in _SETTLED_RELEASES


def voucher_status(dv: int, counts: Counts) -> str:
    if dv < counts["payment_releases"]:
        return "Paid" if voucher_paid(dv, counts) else "Approved for payment"
    return _draw("lg", "disbursement_vouchers", dv, VOUCHER_OPEN)


def project_status(project: int, seed: int, counts: Counts) -> str:
    label = finance.project_class(project)
    if label == "awarded":
        if not finance.project_orders(project, counts):
            return "Awarded"
        if project < PINNED:
            return "Contract signed"
        return _draw(seed, "procurement_projects", project,
                     {"Contract signed": 80, "Notice to proceed": 20})  # fmt: skip
    weights = {
        "evaluation": {"Under evaluation": 40, "Bids opened": 25, "Post-qualification": 20,
                       "Recommended for award": 15},
        "failed": {"Failed bidding": 60, "Re-bid posted": 30, "Second failure, negotiated": 10},
        "early": {"Posted": 60, "Pre-procurement conference": 25, "Pre-bid held": 15},
    }.get(label, {"Cancelled": 1})  # fmt: skip
    return _draw(seed, "procurement_projects", project, weights)


def po_status(po: int, seed: int, counts: Counts) -> str:
    label = finance.po_class(po)
    if label == "terminated":
        return "Terminated"
    if not finance.order_iars(po, counts):
        return "Conformed" if po % 2 else "Issued"
    if not finance.po_accepted(po, counts):
        return "Partially delivered"
    vouchers = finance.obligation_vouchers(po, counts)
    if any(voucher_paid(dv, counts) for dv in vouchers):
        if po >= PINNED and random.Random(f"{seed}:po:{po}:damages").random() < 0.04:
            return "Liquidated damages applied"
        return "Paid"
    return "Accepted" if vouchers else "Delivered"


def supplier_status(supplier: int, seed: int, counts: Counts) -> str:
    orders = counts["purchase_orders"]
    if supplier < PINNED or any(finance.po_supplier(po, counts) == supplier
                                for po in range(orders)):  # fmt: skip
        return "Active"
    return _draw(seed, "suppliers", supplier, _weights("suppliers"))


def civil_event(entry: int) -> str:
    if entry < PINNED:
        return ("Birth", "Birth", "Death", "Marriage", "Birth")[entry % 5]
    return weighted_label(random.Random(f"lg:civil-event:{entry}"),
                          {"Birth": 58, "Death": 18, "Marriage": 16,
                           "Marriage license application": 8})  # fmt: skip


def civil_delayed(entry: int) -> bool:
    """A birth registered after 30 days needs a delayed registration (posted 10 days)."""
    if entry < PINNED:
        return entry == 0  # The live rule flags it for posting.
    rate = 0.18 if civil_event(entry) == "Birth" else 0.04
    return random.Random(f"lg:civil-delayed:{entry}").random() < rate


def civil_status(entry: int, seed: int, _counts: Counts) -> str:
    if entry < PINNED:
        return "Registered" if entry == 0 else _top("civil_registry")
    if civil_event(entry) == "Marriage license application" or civil_delayed(entry):
        return _draw(
            seed,
            "civil_registry",
            entry,
            {"Posted for 10 days": 60, "Registered": 25, "Transmitted to national registry": 15},
        )
    return _draw(seed, "civil_registry", entry, _weights("civil_registry"))


def _seeded(module: str) -> Callable[[int, int, Counts], str]:
    def label(index: int, seed: int, _counts: Counts) -> str:
        return _top(module) if index < PINNED else _draw(seed, module, index, _weights(module))

    return label


_STATUS: dict[str, Callable[[int, int, Counts], str]] = {
    "business_establishments": lambda index, _seed, counts: establishment_status(index, counts),
    "permit_applications": application_status,
    "business_inspections": lambda index, _seed, _counts: links.inspection_result(index),
    "enforcement_notices": lambda index, _seed, _counts: notice_status(index),
    "building_permits": lambda index, _seed, counts: permit_status(index, counts),
    "building_inspections": _seeded("building_inspections"),
    "service_requests": request_status,
    "work_orders": lambda index, _seed, _counts: work_order_status(index),
    "payment_orders": lambda index, _seed, counts: order_status(index, counts),
    "official_receipts": lambda index, _seed, counts: (
        "Issued" if links.receipt_slot(index, counts) or index % 3 else "Cancelled"
    ),
    "deposit_reports": deposit_status,
    "payment_releases": lambda index, _seed, _counts: release_status(index),
    "appropriations": _seeded("appropriations"),
    "obligation_requests": lambda index, _seed, counts: finance.obr_stage(index, counts),
    "disbursement_vouchers": lambda index, _seed, counts: voucher_status(index, counts),
    "suppliers": supplier_status,
    "purchase_requests": lambda index, _seed, _counts: finance.request_stage(index),
    "procurement_projects": project_status,
    "bids": lambda index, seed, counts: (
        "Opened" if finance.bid_rank(index, counts) == 1 else _seeded("bids")(index, seed, counts)
    ),
    "purchase_orders": po_status,
    "acceptance_reports": lambda index, _seed, counts: finance.iar_slot(index, counts)[1],
    "communications": _seeded("communications"),
    "legislative_measures": lambda index, _seed, _counts: finance.measure_stage(index),
    "civil_registry": civil_status,
}


def status_label(module_key: str, index: int, seed: int, counts: Counts) -> str:
    return _status_label(module_key, index, seed, tuple(sorted(counts.items())))


@lru_cache(maxsize=262_144)
def _status_label(module_key: str, index: int, seed: int,
                  frozen: tuple[tuple[str, int], ...]) -> str:  # fmt: skip
    return _STATUS[module_key](index, seed, dict(frozen))
