"""Issue to resolution and breakdown to repair: NCRs, CAPAs, equipment, work orders."""

from __future__ import annotations

from functools import cache, lru_cache

from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer import vocabulary as words
from operations.sample.packs.manufacturer.plan_base import (
    PINNED,
    Counts,
    Frozen,
    between,
    counted,
    draw,
    frozen,
    rng,
    work_center,
)
from operations.sample.packs.manufacturer.realism import MWO_STATUS, MWO_TYPES, NCR_SOURCES
from operations.sample.realism import skewed_parent

_HELD_BATCHES = ("QA hold", "Reprocess", "Destroyed")
_HELD_LOTS = ("Rejected", "On hold")
_HELD_FINISHED = ("Quality hold", "Rework", "Destroyed", "Recalled")


@cache
def ncr_source(ncr: int) -> str:
    if ncr < PINNED:
        return ("Incoming", "Customer complaint", "In-process", "Final", "In-process",
                "Incoming", "Customer complaint", "Audit", "In-process", "Final")[ncr]  # fmt: skip
    return draw("ncrs", ncr, NCR_SOURCES, "source")


@lru_cache(maxsize=16)
def _pools(frozen_counts: Frozen) -> dict[str, tuple[int, ...]]:
    counts = dict(frozen_counts)
    return {
        "batches": tuple(batch for batch in range(counts["batch_records"])
                         if plant.batch_class(batch, counts) in _HELD_BATCHES),
        "lots": tuple(lot for lot in range(counts["material_lots"])
                      if supply.lot_class(lot, counts) in _HELD_LOTS),
        "held": tuple(lot for lot in range(counts["finished_goods_lots"])
                      if plant.finished_class(lot, counts) in _HELD_FINISHED),
        "shipped": tuple(lot for lot in range(counts["finished_goods_lots"])
                         if plant.finished_class(lot, counts) == "Shipped out"),
    }  # fmt: skip


def _pick(ncr: int, pool: tuple[int, ...]) -> tuple[int, ...]:
    return (pool[rng("ncrs", ncr, "record").randrange(len(pool))],) if pool else ()


def ncr_links(ncr: int, counts: Counts) -> dict[str, tuple[int, ...]]:
    """The affected batches, material lots and finished lots an NCR names."""
    pools = _pools(frozen(counts))
    source = ncr_source(ncr)
    if ncr == 0:
        return {"lots": (0,)}  # The rejected receipt flagged on arrival.
    if ncr == 1:
        return {"finished": (1,)}  # The customer's glass fragment complaint.
    if source in {"Incoming", "Supplier"}:
        return {"lots": _pick(ncr, pools["lots"])}
    if source == "In-process":
        return {"batches": _pick(ncr, pools["batches"])}
    if source == "Final":
        return {"finished": _pick(ncr, pools["held"])}
    if source == "Customer complaint":
        return {"finished": _pick(ncr, pools["shipped"])}
    return {}


@cache
def ncr_severity(ncr: int) -> str:
    if ncr == 1:
        return "Critical"
    if ncr < PINNED:
        return "Major"
    weights = ({"Major": 60, "Minor": 25, "Critical": 15}
               if ncr_source(ncr) in {"Final", "Customer complaint"}
               else {"Minor": 55, "Major": 40, "Critical": 5})  # fmt: skip
    return draw("ncrs", ncr, weights, "severity")


@counted
def ncr_wd(ncr: int, counts: Counts) -> int:
    links = ncr_links(ncr, counts)
    days = [supply.lot_wd(item, counts) for item in links.get("lots", ())]
    days += [plant.batch_wd(item, counts) for item in links.get("batches", ())]
    days += [plant.finished_wd(item, counts) for item in links.get("finished", ())]
    if ncr_source(ncr) == "Customer complaint" and days:
        days = [max(0, days[0] - between("ncrs", ncr, 8, 20, "complaint"))]
    if not days:
        return between("ncrs", ncr, 0, 28)
    return max(0, days[0] - between("ncrs", ncr, 0, 2))


@counted
def ncr_status(ncr: int, counts: Counts) -> str:
    if ncr == 1:
        return "Under review"
    if ncr < PINNED:
        return "Closed"
    if ncr_wd(ncr, counts) <= 2:
        return draw("ncrs", ncr, {"Open": 60, "Contained": 40})
    from operations.sample.packs.manufacturer.realism import NCR_STATUS

    return draw("ncrs", ncr, NCR_STATUS)


def capa_ncrs(capa: int, counts: Counts) -> tuple[int, ...]:
    if capa == 0:
        return (1,)  # The critical complaint that the create rule flags for a CAPA.
    pool = [ncr for ncr in range(2, counts["ncrs"]) if ncr_severity(ncr) != "Minor"]
    if not pool:
        return ()
    first = pool[(capa * 2) % len(pool)]
    second = pool[(capa * 2 + 1) % len(pool)]
    return tuple(sorted({first, second})) if capa % 3 == 0 else (first,)


@counted
def capa_wd(capa: int, counts: Counts) -> int:
    days = [ncr_wd(ncr, counts) for ncr in capa_ncrs(capa, counts)]
    return max(0, min(days, default=20) - between("capas", capa, 1, 3))


# Equipment: each kettle and filling line has its machines; utilities serve the plant.
def equipment_slot(item: int, counts: Counts) -> tuple[int | None, tuple[str, str, str, str]]:
    """(work center or None, equipment type) of one asset."""
    centers = counts["work_centers"]
    position = item % (centers + 2)
    rank = item // (centers + 2)
    if position >= centers:
        utilities = words.UTILITY_EQUIPMENT
        return None, utilities[(rank * 2 + position - centers) % len(utilities)]
    machines = words.KETTLE_EQUIPMENT if position % 2 == 0 else words.LINE_EQUIPMENT
    return position, machines[rank % len(machines)]


def equipment_tag(item: int, counts: Counts) -> str:
    center, (_name, code, _model, _grade) = equipment_slot(item, counts)
    serial = item // (counts["work_centers"] + 2) + 1
    if center is None:
        return f"{code}-{serial:02d}"
    return f"{work_center(center)[0]}-{code}-{serial:02d}"


@lru_cache(maxsize=16)
def _center_equipment(frozen_counts: Frozen) -> dict[int, tuple[int, ...]]:
    counts = dict(frozen_counts)
    found: dict[int, list[int]] = {}
    for item in range(counts["equipment"]):
        center = equipment_slot(item, counts)[0]
        if center is not None:
            found.setdefault(center, []).append(item)
    return {key: tuple(value) for key, value in found.items()}


@cache
def equipment_status(item: int) -> str:
    if item < PINNED:
        return "In service"
    from operations.sample.packs.manufacturer.realism import EQUIPMENT_STATUS

    return draw("equipment", item, EQUIPMENT_STATUS)


# Maintenance work orders: corrective orders answer the flagged breakdowns, in order.
@cache
def mwo_type(mwo: int) -> str:
    if mwo < 2:
        return "Corrective"
    return draw("maintenance_work_orders", mwo, MWO_TYPES, "type")


@lru_cache(maxsize=16)
def _breakdown_pairs(frozen_counts: Frozen) -> dict[int, int]:
    counts = dict(frozen_counts)
    events = [item for item in range(counts["downtime_events"]) if plant.is_breakdown(item)]
    orders = [mwo for mwo in range(counts["maintenance_work_orders"])
              if mwo_type(mwo) in {"Corrective", "Emergency"}]  # fmt: skip
    return dict(zip(orders, events, strict=False))


@counted
def mwo_downtime(mwo: int, counts: Counts) -> int | None:
    return _breakdown_pairs(frozen(counts)).get(mwo)


@counted
def mwo_equipment(mwo: int, counts: Counts) -> int:
    event = mwo_downtime(mwo, counts)
    if event is not None:
        center = plant.report_slot(plant.downtime_report(event, counts), counts)[1]
        machines = _center_equipment(frozen(counts)).get(center, ())
        if machines:
            return machines[rng("maintenance_work_orders", mwo, "machine").randrange(len(machines))]
    return skewed_parent("equipment_work_orders", mwo, counts["equipment"])


@counted
def mwo_wd(mwo: int, counts: Counts) -> int:
    event = mwo_downtime(mwo, counts)
    if event is not None:
        report = plant.downtime_report(event, counts)
        return plant.report_slot(report, counts)[0]
    status = mwo_status(mwo, counts)
    low, high = {"Requested": (0, 3), "Approved": (0, 4), "Scheduled": (0, 5),
                 "In progress": (0, 2), "Waiting parts": (2, 10), "Completed": (0, 4),
                 "Closed": (3, 30), "Cancelled": (2, 30)}[status]  # fmt: skip
    return between("maintenance_work_orders", mwo, low, high)


@counted
def mwo_status(mwo: int, counts: Counts) -> str:
    event = mwo_downtime(mwo, counts)
    if mwo < PINNED:
        return "Closed"
    if event is not None:
        day = plant.report_slot(plant.downtime_report(event, counts), counts)[0]
        if day <= 1:
            return draw("maintenance_work_orders", mwo, {"In progress": 50, "Waiting parts": 25,
                                                         "Completed": 25})  # fmt: skip
        return "Completed" if day <= 3 else "Closed"
    return draw("maintenance_work_orders", mwo, MWO_STATUS)
