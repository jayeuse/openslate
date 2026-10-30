"""Index rules for assessments, procurement, obligations and council records.

Like ``links``, every rule reads record indexes and counts only, never the seed.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.local_government import items
from operations.sample.packs.local_government.links import (
    ASSESSED_APPLICATION,
    PINNED,
    THIRD_READING_MEASURE,
    _draw,
    _n,
    installments,
    oop_source,
    paid_installments,
    permit_inspections,
)
from operations.sample.packs.local_government.realism import (
    APPLICATION_OPEN,
    PERMIT_ACTIVE,
    PERMIT_DORMANT,
    PROJECT_CLASSES,
    PURCHASE_ORDER_CLASSES,
    REQUEST_PENDING,
    STATUS_WEIGHTS,
)
from operations.sample.realism import skewed_parent

# The trigger inputs: records that start one step before the change the live run makes.
VERIFIED_APPLICATION = 2
EVALUATED_PERMIT = 2
APPROVED_REQUEST = 2
SECOND_READING_MEASURE = 2

_PAYABLE_PERMITS = frozenset({"For payment", "Paid", "Permit issued", "Under construction",
                              "Completed", "Deemed approved", "Expired"})  # fmt: skip


def application_stage(app: int) -> str:
    """``assessed`` once the Treasury has assessed it; otherwise the open status."""
    if app == VERIFIED_APPLICATION:
        return "Verified"
    if app < PINNED:
        return "assessed"
    if random.Random(f"lg:app-stage:{app}").random() < 0.9:
        return "assessed"
    return _draw(f"app-open:{app}", APPLICATION_OPEN)


def permit_stage(permit: int, counts: Mapping[str, int]) -> str:
    if permit == EVALUATED_PERMIT:
        return "Under evaluation"
    if permit < PINNED:
        return "Permit issued"
    if not permit_inspections(permit, counts):
        return _draw(f"permit-dormant:{permit}", PERMIT_DORMANT)
    return _draw(f"permit:{permit}", PERMIT_ACTIVE)


@lru_cache(maxsize=16)
def _assessed(apps: int) -> tuple[int, ...]:
    rest = (app for app in range(apps)
            if app != ASSESSED_APPLICATION and application_stage(app) == "assessed")  # fmt: skip
    return (ASSESSED_APPLICATION, *rest)


@lru_cache(maxsize=16)
def _payable(permits: int, inspections: int) -> tuple[int, ...]:
    counts = {"building_permits": permits, "building_inspections": inspections}
    return tuple(item for item in range(permits)
                 if permit_stage(item, counts) in _PAYABLE_PERMITS)  # fmt: skip


@lru_cache(maxsize=16)
def _sources(orders: int) -> tuple[dict[int, int], dict[int, int]]:
    """Each order's position among the business orders and among the building orders."""
    business: dict[int, int] = {}
    building: dict[int, int] = {}
    for order in range(orders):
        source = oop_source(order)
        if source == "Business permit":
            business[order] = len(business)
        elif source in {"Building permit", "Occupancy"}:
            building[order] = len(building)
    return business, building


def oop_application(order: int, counts: Mapping[str, int]) -> int | None:
    position = _sources(counts["payment_orders"])[0].get(order)
    if position is None:
        return None
    assessed = _assessed(counts["permit_applications"])
    return assessed[position % len(assessed)]


def oop_permit(order: int, counts: Mapping[str, int]) -> int | None:
    position = _sources(counts["payment_orders"])[1].get(order)
    payable = _payable(*_n(counts, "building_permits", "building_inspections"))
    if position is None or not payable:
        return None
    return payable[position % len(payable)]


@lru_cache(maxsize=16)
def _application_orders(orders: int, apps: int) -> dict[int, tuple[int, ...]]:
    counts = {"payment_orders": orders, "permit_applications": apps}
    found: dict[int, list[int]] = {}
    for order in range(orders):
        app = oop_application(order, counts)
        if app is not None:
            found.setdefault(app, []).append(order)
    return {key: tuple(value) for key, value in found.items()}


def application_orders(app: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _application_orders(*_n(counts, "payment_orders", "permit_applications")).get(app, ())


def application_paid(app: int, counts: Mapping[str, int]) -> bool | None:
    """Whether a receipt paid an order for the application; ``None`` when it has no order."""
    orders = application_orders(app, counts)
    if not orders:
        return None
    return any(paid_installments(order, counts) for order in orders)


def amount_installment(order: int) -> int:
    return installments(order)[0]


# Procurement: requests consolidated into projects, bids, awards, deliveries.


def request_stage(request: int) -> str:
    if request == APPROVED_REQUEST:
        return "Approved"
    if request < PINNED or random.Random(f"lg:pr-stage:{request}").random() < 0.78:
        return "Consolidated"
    return _draw(f"pr-open:{request}", REQUEST_PENDING)


@lru_cache(maxsize=16)
def _consolidated(requests: int) -> tuple[int, ...]:
    return tuple(item for item in range(requests) if request_stage(item) == "Consolidated")


def project_requests(project: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    pool, projects = _consolidated(counts["purchase_requests"]), counts["procurement_projects"]
    project %= projects
    return pool[project * len(pool) // projects : (project + 1) * len(pool) // projects]


def project_class(project: int) -> str:
    return "awarded" if project < PINNED else _draw(f"project:{project}", PROJECT_CLASSES)


@lru_cache(maxsize=16)
def _bidded(projects: int) -> tuple[int, ...]:
    return tuple(item for item in range(projects)
                 if project_class(item) in {"awarded", "evaluation"})  # fmt: skip


def bid_project(bid: int, counts: Mapping[str, int]) -> int:
    bidded = _bidded(counts["procurement_projects"])
    return bidded[bid % len(bidded)]


@lru_cache(maxsize=16)
def _bid_tables(
    bids: int, projects: int, suppliers: int, requests: int
) -> tuple[dict[int, tuple[int, ...]], tuple[int, ...]]:
    counts = {"bids": bids, "procurement_projects": projects, "purchase_requests": requests}
    by_kind: dict[str, list[int]] = {}
    for supplier in range(suppliers):
        by_kind.setdefault(items.supplier_type(supplier), []).append(supplier)
    by_project: dict[int, list[int]] = {}
    chosen: list[int] = []
    for bid in range(bids):
        project = bid_project(bid, counts)
        pool = by_kind.get(project_kind(project, counts)) or list(range(suppliers))
        position = skewed_parent(f"supplier_bids:{len(pool)}", bid, len(pool),
                                 dormant_share=0.12, alpha=0.7)  # fmt: skip
        taken = {chosen[other] for other in by_project.get(project, [])}
        for step in range(len(pool)):
            if pool[(position + step) % len(pool)] not in taken:
                position = (position + step) % len(pool)
                break
        supplier = pool[position]
        if supplier in taken:  # A small trade: a general supplier quotes as well.
            supplier = next(item for item in range(suppliers) if item not in taken)
        chosen.append(supplier)
        by_project.setdefault(project, []).append(bid)
    return {key: tuple(value) for key, value in by_project.items()}, tuple(chosen)


def project_kind(project: int, counts: Mapping[str, int]) -> str:
    """The kind of supplier that can bid: the project's first request decides it."""
    requests = project_requests(project, counts)
    return items.item(requests[0] if requests else project + 500)[2]


def _bids(counts: Mapping[str, int]) -> tuple[dict[int, tuple[int, ...]], tuple[int, ...]]:
    return _bid_tables(*_n(counts, "bids", "procurement_projects", "suppliers",
                           "purchase_requests"))  # fmt: skip


def project_bids(project: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _bids(counts)[0].get(project, ())


def bid_supplier(bid: int, counts: Mapping[str, int]) -> int:
    chosen = _bids(counts)[1]
    return chosen[bid % len(chosen)]


def bid_rank(bid: int, counts: Mapping[str, int]) -> int:
    return project_bids(bid_project(bid, counts), counts).index(bid) + 1


@lru_cache(maxsize=16)
def _awarded(projects: int) -> tuple[int, ...]:
    return tuple(item for item in range(projects) if project_class(item) == "awarded")


def po_project(po: int, counts: Mapping[str, int]) -> int:
    awarded = _awarded(counts["procurement_projects"])
    return awarded[po % len(awarded)]


def po_lot(po: int, counts: Mapping[str, int]) -> tuple[int, int]:
    """This order's lot and the project's number of lots."""
    awarded, orders = len(_awarded(counts["procurement_projects"])), counts["purchase_orders"]
    position = po % awarded
    lots = len(range(position, orders, awarded))
    return po // awarded, lots


def project_orders(project: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    awarded = _awarded(counts["procurement_projects"])
    if project not in awarded:
        return ()
    return tuple(range(awarded.index(project), counts["purchase_orders"], len(awarded)))


def po_supplier(po: int, counts: Mapping[str, int]) -> int:
    return bid_supplier(project_bids(po_project(po, counts), counts)[0], counts)


def po_class(po: int) -> str:
    return "delivered" if po < PINNED else _draw(f"po:{po}", PURCHASE_ORDER_CLASSES)


@lru_cache(maxsize=16)
def _iar_slots(orders: int) -> tuple[tuple[int, str], ...]:
    slots: list[tuple[int, str]] = []
    for po in range(orders):
        if po_class(po) == "delivered":
            if po >= PINNED and po % 5 == 2:
                slots.append((po, "Partial"))
            slots.append((po, "Complete and conforming"))
    return tuple(slots)


def iar_slot(iar: int, counts: Mapping[str, int]) -> tuple[int, str]:
    """The order a delivery is for and its result; deliveries past the plan are refused."""
    slots = _iar_slots(counts["purchase_orders"])
    if iar < len(slots):
        return slots[iar]
    delivered = sorted({po for po, _result in slots})
    rejected = ("Rejected, nonconforming", "Rejected, short delivery")[iar % 2]
    return delivered[(iar - len(slots)) % len(delivered)], rejected


@lru_cache(maxsize=16)
def _order_iars(orders: int, iars: int) -> dict[int, tuple[int, ...]]:
    counts = {"purchase_orders": orders}
    found: dict[int, list[int]] = {}
    for iar in range(iars):
        found.setdefault(iar_slot(iar, counts)[0], []).append(iar)
    return {key: tuple(value) for key, value in found.items()}


def order_iars(po: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _order_iars(*_n(counts, "purchase_orders", "acceptance_reports")).get(po, ())


def accepted_iars(po: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return tuple(iar for iar in order_iars(po, counts)
                 if iar_slot(iar, counts)[1] in {"Partial", "Complete and conforming"})  # fmt: skip


def po_accepted(po: int, counts: Mapping[str, int]) -> bool:
    return any(iar_slot(iar, counts)[1] == "Complete and conforming"
               for iar in order_iars(po, counts))  # fmt: skip


# Budget and Accounting: obligations against appropriations, vouchers, releases.


def obr_po(obr: int, counts: Mapping[str, int]) -> int | None:
    """The first obligation requests obligate the purchase orders, one each."""
    return obr if obr < counts["purchase_orders"] else None


def obr_kind(obr: int, counts: Mapping[str, int]) -> str:
    if obr_po(obr, counts) is not None:
        return "Purchase order"
    return _draw(f"obr-kind:{obr}", {"Payroll": 46, "Utilities": 23, "Travel": 12, "Other": 19})


def obr_stage(obr: int, counts: Mapping[str, int]) -> str:
    if obr < PINNED or obr_po(obr, counts) is not None:
        return "Obligated"
    return _draw(f"obr:{obr}", STATUS_WEIGHTS["obligation_requests"])


def expense_class(appropriation: int) -> str:
    if appropriation < PINNED:
        return ("MOOE", "Personal services", "Capital outlay")[appropriation % 3]
    return _draw(f"expense:{appropriation}", {"MOOE": 50, "Personal services": 30,
                                              "Capital outlay": 15,
                                              "Financial expenses": 5})  # fmt: skip


@lru_cache(maxsize=16)
def _lines(appropriations: int) -> dict[str, tuple[int, ...]]:
    found: dict[str, list[int]] = {}
    for item in range(appropriations):
        found.setdefault(expense_class(item), []).append(item)
    return {key: tuple(value) for key, value in found.items()}


def obr_appropriation(obr: int, counts: Mapping[str, int]) -> int:
    lines = _lines(counts["appropriations"])
    kind = obr_kind(obr, counts)
    wanted = {"Payroll": ("Personal services",), "Purchase order": ("Capital outlay", "MOOE")}
    pool = tuple(sorted(item for label in wanted.get(kind, ("MOOE",))
                        for item in lines.get(label, ())))  # fmt: skip
    pool = pool or tuple(range(counts["appropriations"]))
    return pool[skewed_parent(f"obligation-line:{kind}", obr, len(pool), alpha=0.7)]


@lru_cache(maxsize=16)
def _ready(obrs: int, orders: int, iars: int) -> tuple[int, ...]:
    counts = {"obligation_requests": obrs, "purchase_orders": orders, "acceptance_reports": iars}
    ready = []
    for obr in range(obrs):
        po = obr_po(obr, counts)
        if obr_stage(obr, counts) == "Obligated" and (po is None or po_accepted(po, counts)):
            ready.append(obr)
    return tuple(ready)


def _ready_list(counts: Mapping[str, int]) -> tuple[int, ...]:
    return _ready(*_n(counts, "obligation_requests", "purchase_orders", "acceptance_reports"))


def dv_obligation(dv: int, counts: Mapping[str, int]) -> int:
    ready = _ready_list(counts)
    return ready[dv % len(ready)]


def dv_part(dv: int, counts: Mapping[str, int]) -> tuple[int, int]:
    """This voucher's place among the vouchers of its obligation, and their number."""
    ready, vouchers = _ready_list(counts), counts["disbursement_vouchers"]
    position = dv % len(ready)
    return dv // len(ready), len(range(position, vouchers, len(ready)))


def obligation_vouchers(obr: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    ready = _ready_list(counts)
    if obr not in ready:
        return ()
    return tuple(range(ready.index(obr), counts["disbursement_vouchers"], len(ready)))


def dv_iars(dv: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    po = obr_po(dv_obligation(dv, counts), counts)
    if po is None:
        return ()
    accepted, part = accepted_iars(po, counts), dv_part(dv, counts)[0]
    return (accepted[part],) if part < len(accepted) else ()


def release_voucher(release: int, counts: Mapping[str, int]) -> int:
    return release % counts["disbursement_vouchers"]


# City Clerk, Records and Council.


def measure_stage(measure: int) -> str:
    if measure == SECOND_READING_MEASURE:
        return "Second reading"
    if measure < PINNED:
        return "Signed"
    return _draw(f"measure:{measure}", STATUS_WEIGHTS["legislative_measures"])


def communication_measures(communication: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    if communication == 0:
        return (THIRD_READING_MEASURE,)  # The transmittal the clerk sends after third reading.
    if communication >= PINNED and communication % 5 == 0:
        return (skewed_parent("measure_communications", communication,
                              counts["legislative_measures"]),)  # fmt: skip
    return ()
