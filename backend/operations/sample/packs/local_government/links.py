"""City government relationship rules, planned from record indexes and counts only.

Statuses that a link depends on (an application with a paid order of payment, a request
with a work order, a paid voucher) are drawn from the same index rules here and in
``states``, so the two sides always agree. Seedless draws use the ``lg:`` key prefix.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.local_government.realism import OOP_CLASSES, STATUS_WEIGHTS
from operations.sample.realism import skewed_parent, weighted_label

# Records below this index carry named business cases; the realism rules leave them alone.
PINNED = 10

# A typed code that repeats a link the department already has as a relationship.
REFERENCE_FIELDS = (("official_receipts", "oop_reference"),)

# The named follow-ups: an order of payment for application 5, a transmittal for measure 5.
ASSESSED_APPLICATION = 4
THIRD_READING_MEASURE = 4


def _draw(key: str, weights: Mapping[str, float]) -> str:
    return weighted_label(random.Random(f"lg:{key}"), weights)


def _n(counts: Mapping[str, int], *keys: str) -> tuple[int, ...]:
    return tuple(counts[key] for key in keys)


# Business Permits and Licensing.


@lru_cache(maxsize=64)
def _eligible(key: str, parents: int, dormant_share: float) -> tuple[int, ...]:
    """A steady share of dormant parents: about one in ``1 / dormant_share``."""
    offset = sum(map(ord, key)) % 100
    return tuple(item for item in range(parents)
                 if item < PINNED or (item * 37 + offset) % 100 >= dormant_share * 100)  # fmt: skip


def spread_parent(key: str, child: int, parents: int, dormant_share: float = 0.08) -> int:
    """Each active parent gets one child first, then a few get more; dormant ones get none."""
    eligible = _eligible(key, parents, dormant_share)
    if child < len(eligible):
        return eligible[child]
    return eligible[skewed_parent(key, child, len(eligible), dormant_share=0.0, alpha=0.6)]


def application_establishment(app: int, counts: Mapping[str, int]) -> int:
    """A year's renewal or new permit for each active business; then amendments and closures."""
    return spread_parent("establishment_applications", app, counts["business_establishments"])


@lru_cache(maxsize=16)
def _establishment_apps(apps: int, establishments: int) -> dict[int, tuple[int, ...]]:
    counts = {"permit_applications": apps, "business_establishments": establishments}
    found: dict[int, list[int]] = {}
    for app in range(apps):
        found.setdefault(application_establishment(app, counts), []).append(app)
    return {key: tuple(value) for key, value in found.items()}


def establishment_apps(establishment: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    table = _establishment_apps(*_n(counts, "permit_applications", "business_establishments"))
    return table.get(establishment, ())


def new_business(establishment: int) -> bool:
    """About one establishment in six registered this year."""
    return establishment >= PINNED and establishment % 6 == 5


def application_type(app: int, counts: Mapping[str, int]) -> str:
    establishment = application_establishment(app, counts)
    if establishment_apps(establishment, counts)[0] == app:
        return "New" if new_business(establishment) else "Renewal"
    return _draw(f"app-type:{app}", {"Amendment": 45, "Special permit": 30, "Retirement": 25})


def inspection_establishment(inspection: int, counts: Mapping[str, int]) -> int:
    return skewed_parent("establishment_inspections", inspection,
                         counts["business_establishments"], alpha=0.6)  # fmt: skip


def inspection_result(inspection: int) -> str:
    if inspection == 0:
        return "Failed"  # The live rule flags it; a notice follows (plan rule 5).
    if inspection < PINNED:
        return "Complied"
    return _draw(f"inspection:{inspection}", STATUS_WEIGHTS["business_inspections"])


@lru_cache(maxsize=16)
def _findings(inspections: int) -> tuple[int, ...]:
    return tuple(item for item in range(inspections)
                 if inspection_result(item) in {"Failed", "With findings"})  # fmt: skip


def delinquency_notice(notice: int) -> bool:
    """Notices for unpaid tax come from the books, not from an inspection."""
    return notice >= PINNED and notice % 5 == 4


def notice_inspection(notice: int, counts: Mapping[str, int]) -> int | None:
    if notice == 0:
        return 0
    if delinquency_notice(notice):
        return None
    findings = _findings(counts["business_inspections"])
    return findings[notice % len(findings)] if findings else None


def notice_establishment(notice: int, counts: Mapping[str, int]) -> int:
    inspection = notice_inspection(notice, counts)
    if inspection is not None:
        return inspection_establishment(inspection, counts)
    return skewed_parent("delinquency_notices", notice, counts["business_establishments"])


@lru_cache(maxsize=16)
def _notice_rounds(notices: int, inspections: int) -> tuple[int, ...]:
    counts = {"enforcement_notices": notices, "business_inspections": inspections,
              "business_establishments": 1}  # fmt: skip
    seen: dict[int | None, int] = {}
    rounds = []
    for notice in range(notices):
        inspection = notice_inspection(notice, counts)
        rounds.append(seen.get(inspection, 0) if inspection is not None else 0)
        if inspection is not None:
            seen[inspection] = seen.get(inspection, 0) + 1
    return tuple(rounds)


def notice_type(notice: int, counts: Mapping[str, int]) -> str:
    if delinquency_notice(notice):
        return "Notice of delinquency"
    rounds = _notice_rounds(*_n(counts, "enforcement_notices", "business_inspections"))
    stage = rounds[notice % len(rounds)]
    return ("Notice of violation", "Cease and desist", "Closure order", "Lifting order")[
        min(stage, 3)
    ]


# Building Official.


def inspection_permit(inspection: int, counts: Mapping[str, int]) -> int:
    """A site inspection for each evaluated permit, then the construction-stage visits."""
    return spread_parent("permit_inspections", inspection, counts["building_permits"], 0.1)


@lru_cache(maxsize=16)
def _permit_inspections(inspections: int, permits: int) -> dict[int, tuple[int, ...]]:
    counts = {"building_inspections": inspections, "building_permits": permits}
    found: dict[int, list[int]] = {}
    for inspection in range(inspections):
        found.setdefault(inspection_permit(inspection, counts), []).append(inspection)
    return {key: tuple(value) for key, value in found.items()}


def permit_inspections(permit: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _permit_inspections(*_n(counts, "building_inspections", "building_permits")).get(
        permit, ()
    )


def inspection_round(inspection: int, counts: Mapping[str, int]) -> int:
    permit = inspection_permit(inspection, counts)
    return permit_inspections(permit, counts).index(inspection)


# Engineering and Public Works: one crew job clears one or two nearby requests.

_CREW_WORK = {
    "Clogged drainage or canal": "Declogging and desilting",
    "Street flooding": "Declogging and desilting",
    "Pothole": "Pothole patching",
    "Streetlight out": "Streetlight repair",
    "Streetlight flickering": "Streetlight repair",
    "Fallen tree or branch": "Tree trimming",
    "Damaged sidewalk": "Sidewalk repair",
    "Open or missing manhole cover": "Manhole cover replacement",
    "Uncollected garbage": "Special garbage pickup",
    "Illegal dumping": "Special garbage pickup",
    "Damaged road sign": "Sign repair",
}
_SERVICE_WEIGHTS = {
    "Clogged drainage or canal": 18, "Pothole": 14, "Streetlight out": 11,
    "Uncollected garbage": 10, "Street flooding": 8, "Fallen tree or branch": 6,
    "Streetlight flickering": 5, "Damaged sidewalk": 5, "Illegal dumping": 5,
    "Open or missing manhole cover": 4, "Damaged road sign": 3, "Road obstruction": 3,
    "Illegal construction report": 3, "Stray animals": 2, "Leaking water main": 2,
    "Graffiti": 1,
}  # fmt: skip
_PINNED_SERVICE = ("Clogged drainage or canal", "Pothole", "Streetlight out",
                   "Uncollected garbage", "Fallen tree or branch")  # fmt: skip


def service_type(request: int) -> str:
    if request < PINNED:
        return _PINNED_SERVICE[request % len(_PINNED_SERVICE)]
    return _draw(f"service:{request}", _SERVICE_WEIGHTS)


def work_type(request: int) -> str | None:
    return _CREW_WORK.get(service_type(request))


@lru_cache(maxsize=16)
def _crew_requests(requests: int) -> tuple[int, ...]:
    return tuple(item for item in range(requests) if work_type(item) is not None
                 and (item < PINNED or item % 7 != 3))  # fmt: skip


def work_order_requests(order: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    crew = _crew_requests(counts["service_requests"])
    orders = counts["work_orders"]
    if order < PINNED:
        position = order
    else:
        position = PINNED + (order - PINNED) * (len(crew) - PINNED) // max(1, orders - PINNED)
    first = crew[position % len(crew)]
    following = crew[(position + 1) % len(crew)]
    if order >= PINNED and order % 4 == 3 and work_type(following) == work_type(first):
        return (first, following)
    return (first,)


@lru_cache(maxsize=16)
def _request_orders(requests: int, orders: int) -> dict[int, int]:
    counts = {"service_requests": requests, "work_orders": orders}
    found: dict[int, int] = {}
    for order in range(orders):
        for request in work_order_requests(order, counts):
            found.setdefault(request, order)
    return found


def request_work_order(request: int, counts: Mapping[str, int]) -> int | None:
    return _request_orders(*_n(counts, "service_requests", "work_orders")).get(request)


# Treasury: orders of payment for assessed applications and permits, paid in receipts.


def oop_source(order: int) -> str:
    if order < PINNED:
        return "Business permit" if order % 4 != 3 else "Building permit"
    return _draw(f"oop-source:{order}", {"Business permit": 66, "Building permit": 21,
                                         "Occupancy": 6, "Civil registry": 3,
                                         "Real property tax": 2, "Other": 2})  # fmt: skip


def oop_class(order: int) -> str:
    if order == 0:
        return "Partially paid"  # The named first-quarter installment.
    if order < PINNED:
        return "Paid"
    return _draw(f"oop-class:{order}", OOP_CLASSES)


def installments(order: int) -> tuple[int, int]:
    """Planned and paid installments: business tax may be paid quarterly (LGC §165)."""
    if order == 0:
        return 4, 1
    quarterly = oop_source(order) == "Business permit" and (
        random.Random(f"lg:quarterly:{order}").random() < 0.08
    )
    planned = 4 if quarterly else 1
    label = oop_class(order)
    if label == "Paid":
        return planned, planned
    if label == "Partially paid":
        planned = max(planned, 2)
        return planned, random.Random(f"lg:paid-part:{order}").randint(1, planned - 1)
    return planned, 0


@lru_cache(maxsize=16)
def _receipt_slots(orders: int) -> tuple[tuple[int, int], ...]:
    return tuple((order, step) for order in range(orders)
                 for step in range(installments(order)[1]))  # fmt: skip


def receipt_slot(receipt: int, counts: Mapping[str, int]) -> tuple[int, int] | None:
    """The order of payment and installment a receipt pays; ``None`` for a walk-in fee."""
    slots = _receipt_slots(counts["payment_orders"])
    return slots[receipt] if receipt < len(slots) else None


@lru_cache(maxsize=16)
def _paid(orders: int, receipts: int) -> dict[int, int]:
    paid: dict[int, int] = {}
    for order, _step in _receipt_slots(orders)[:receipts]:
        paid[order] = paid.get(order, 0) + 1
    return paid


def paid_installments(order: int, counts: Mapping[str, int]) -> int:
    """The installments receipts in the plan actually paid; the last orders may have none."""
    return _paid(*_n(counts, "payment_orders", "official_receipts")).get(order, 0)


def order_receipts(order: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _order_receipts(*_n(counts, "payment_orders", "official_receipts")).get(order, ())


@lru_cache(maxsize=16)
def _order_receipts(orders: int, receipts: int) -> dict[int, tuple[int, ...]]:
    found: dict[int, list[int]] = {}
    for receipt, (order, _step) in enumerate(_receipt_slots(orders)[:receipts]):
        found.setdefault(order, []).append(receipt)
    return {key: tuple(value) for key, value in found.items()}
