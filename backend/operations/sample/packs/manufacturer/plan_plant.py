"""Plan to produce: production orders, kettle batches, finished lots, shift reports,
downtime and food safety logs, with positive release before a lot ships."""

from __future__ import annotations

from functools import cache, lru_cache

from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer.catalog_fields import REASON_LOSS
from operations.sample.packs.manufacturer.plan_base import (
    PINNED,
    Counts,
    Frozen,
    between,
    counted,
    draw,
    filling_lines,
    frozen,
    product_class,
    product_line,
    product_work_centers,
    products_with,
    rng,
)
from operations.sample.packs.manufacturer.plan_supply import lot_wd, lots_received
from operations.sample.packs.manufacturer.realism import (
    FINISHED_CLOSED,
    REASON_WEIGHTS,
    WO_CLASSES,
)
from operations.sample.realism import skewed_parent

PRODUCING = frozenset({"Closed", "Technically complete", "Completed", "Partially confirmed",
                       "In progress", "On hold"})  # fmt: skip
_WO_WD = {
    "Closed": (8, 30), "Technically complete": (4, 18), "Completed": (2, 10),
    "Partially confirmed": (1, 6), "In progress": (0, 2), "Released": (-8, -1),
    "Created": (-12, -3), "On hold": (2, 15), "Cancelled": (1, 20),
}  # fmt: skip
SLOTS_PER_SHIFT_DAY = 2  # Shifts A and B on every filling line.
CHECKS = ("PRP, pre-op sanitation", "CCP, pH", "CCP, fill temperature", "CCP, metal detection",
          "PRP, label verification")  # fmt: skip
DRY_CHECKS = ("PRP, pre-op sanitation", "PRP, allergen changeover", "PRP, label verification",
              "CCP, metal detection", "PRP, allergen changeover")  # fmt: skip


@cache
def wo_class(wo: int) -> str:
    return "Closed" if wo < PINNED else draw("production_orders", wo, WO_CLASSES)


@cache
def wo_wd(wo: int) -> int:
    return between("production_orders", wo, *_WO_WD[wo_class(wo)])


@lru_cache(maxsize=16)
def _mto_orders(frozen_counts: Frozen) -> tuple[int, ...]:
    counts = dict(frozen_counts)
    return tuple(order for order in range(counts["sales_orders"])
                 if sales.order_mto(order, counts)
                 and sales.order_class(order) not in {"Draft", "Cancelled"})  # fmt: skip


@counted
def wo_sales_order(wo: int, counts: Counts) -> int | None:
    """The make-to-order sales order an order is planned for, placed before it starts."""
    if wo < PINNED or rng("production_orders", wo, "mto").random() >= 0.35:
        return None
    start = wo_wd(wo)
    pool = [order for order in _mto_orders(frozen(counts))
            if start + 1 <= sales.order_wd(order) <= start + 15]  # fmt: skip
    return rng("production_orders", wo, "sales-order").choice(pool) if pool else None


@counted
def wo_product(wo: int, counts: Counts) -> int:
    order = wo_sales_order(wo, counts)
    lines = () if order is None else sales.order_lines(order, counts)
    if lines:
        return sales.line_product(lines[0], counts)
    pool = products_with(counts["products"], frozenset({"Active", "Development", "Phase-out"}))
    if wo < PINNED:  # The named batches are acidified sauces with a pH reading.
        pool = tuple(item for item in pool if product_line(item)[3]) or pool
    return pool[skewed_parent("product_production_orders", wo, len(pool), pinned=0)]


def wo_trial(wo: int, counts: Counts) -> bool:
    return product_class(wo_product(wo, counts)) == "Development"


@counted
def wo_line(wo: int, counts: Counts) -> int:
    lines = product_work_centers(wo_product(wo, counts), counts)
    return lines[skewed_parent("order_work_center", wo, len(lines), pinned=0, dormant_share=0)]


def _per_order(module: str, total: int, wos: list[int]) -> tuple[tuple[int, int], ...]:
    """(order, sequence) rows: each order once, then extra rows for the larger orders."""
    rows = [(wo, 0) for wo in wos]
    stream = rng(module, total, len(wos))
    counts = dict.fromkeys(wos, 1)
    extra = [wo for wo in wos if wo >= PINNED]
    while len(rows) < total and extra:
        wo = stream.choice(extra)
        rows.append((wo, counts[wo]))
        counts[wo] += 1
    return tuple(rows[:total])


@lru_cache(maxsize=16)
def _batch_table(frozen_counts: Frozen) -> tuple[tuple[int, int], ...]:
    counts = dict(frozen_counts)
    wos = [wo for wo in range(counts["production_orders"]) if wo_class(wo) in PRODUCING]
    return _per_order("batch_records", counts["batch_records"], wos)


def batch_slot(batch: int, counts: Counts) -> tuple[int, int] | None:
    table = _batch_table(frozen(counts))
    return table[batch] if batch < len(table) else None


@counted
def batch_wd(batch: int, counts: Counts) -> int:
    slot = batch_slot(batch, counts)
    if slot is None:
        return between("batch_records", batch, 0, 20)
    wo, sequence = slot
    return max(0, wo_wd(wo) - sequence // 2)


@lru_cache(maxsize=16)
def _last_batches(frozen_counts: Frozen) -> frozenset[int]:
    last: dict[int, int] = {}
    for batch, (wo, _sequence) in enumerate(_batch_table(frozen_counts)):
        last[wo] = batch
    return frozenset(last.values())


@counted
def batch_class(batch: int, counts: Counts) -> str:
    slot = batch_slot(batch, counts)
    if batch < PINNED or slot is None:
        return "Consumed"
    label = wo_class(slot[0])
    if label == "In progress" and batch in _last_batches(frozen(counts)):
        return draw("batch_records", batch, {"Released to filler": 40, "Awaiting QA": 25,
                                             "Cooking": 20, "Weighing": 15})  # fmt: skip
    if label == "On hold":
        return draw("batch_records", batch, {"QA hold": 60, "Reprocess": 40})
    return draw("batch_records", batch, {"Consumed": 95, "Reprocess": 2.5, "QA hold": 1,
                                         "Destroyed": 1, "Released to filler": 0.5})  # fmt: skip


def batch_product(batch: int, counts: Counts) -> int:
    slot = batch_slot(batch, counts)
    return wo_product(slot[0], counts) if slot is not None else 0


@counted
def batch_lots(batch: int, counts: Counts) -> tuple[int, ...]:
    """One or two ingredient lots received on or before the batch day (genealogy)."""
    if product_line(batch_product(batch, counts))[1] == "Dry seasoning" and batch >= PINNED:
        return ()  # Dry blends use bagged spices that are not lot-tracked here.
    day = batch_wd(batch, counts)
    eligible = [lot for lot in lots_received(frozen(counts)) if lot_wd(lot, counts) >= day]
    if not eligible:
        return ()
    recent = eligible[-12:]
    stream = rng("batch_records", batch, "lots")
    first = stream.choice(recent)
    if stream.random() < 0.45 and len(recent) > 1:
        second = stream.choice([lot for lot in recent if lot != first])
        return tuple(sorted((first, second)))
    return (first,)


# Finished goods lots: a new lot at each shift or code change (research §5).
@lru_cache(maxsize=16)
def _finished_table(frozen_counts: Frozen) -> tuple[tuple[int, int], ...]:
    counts = dict(frozen_counts)
    wos = [wo for wo in range(counts["production_orders"])
           if wo_class(wo) in PRODUCING - {"On hold"}]  # fmt: skip
    return _per_order("finished_goods_lots", counts["finished_goods_lots"], wos)


def finished_slot(lot: int, counts: Counts) -> tuple[int, int] | None:
    table = _finished_table(frozen(counts))
    return table[lot] if lot < len(table) else None


@counted
def finished_wd(lot: int, counts: Counts) -> int:
    slot = finished_slot(lot, counts)
    if slot is None:
        return between("finished_goods_lots", lot, 0, 20)
    wo, sequence = slot
    return max(0, wo_wd(wo) - sequence)


@counted
def finished_class(lot: int, counts: Counts) -> str:
    slot = finished_slot(lot, counts)
    if lot < PINNED or slot is None:
        return "Shipped out"
    label = wo_class(slot[0])
    if label == "In progress":
        return draw("finished_goods_lots", lot, {"QA hold, awaiting release": 80, "Released": 20})
    if label == "Partially confirmed":
        return draw("finished_goods_lots", lot, {"Released": 60, "QA hold, awaiting release": 40})
    if label == "Completed":
        return draw("finished_goods_lots", lot, {"Released": 70, "Shipped out": 30})
    return draw("finished_goods_lots", lot, FINISHED_CLOSED)


@lru_cache(maxsize=16)
def _finished_by_class(frozen_counts: Frozen, label: str) -> tuple[int, ...]:
    counts = dict(frozen_counts)
    lots = [lot for lot in range(counts["finished_goods_lots"])
            if finished_class(lot, counts) == label]  # fmt: skip
    return tuple(sorted(lots, key=lambda lot: (-finished_wd(lot, counts), lot)))


@counted
def shipment_lots(shipment: int, counts: Counts) -> tuple[int, ...]:
    """The released lots a load carries, produced on or before its ship day (FEFO)."""
    label = sales.shipment_class(shipment, counts)
    shipped = label in sales.SHIPPED
    pool = _finished_by_class(frozen(counts), "Shipped out" if shipped else "Released")
    day = sales.shipment_wd(shipment, counts)
    eligible = [lot for lot in pool if finished_wd(lot, counts) >= day]
    if not eligible:
        return ()
    window = eligible[-12:]
    stream = rng("shipments", shipment, "lots")
    first = stream.choice(window)
    if stream.random() < 0.3 and len(window) > 1:
        return tuple(sorted((first, stream.choice([lot for lot in window if lot != first]))))
    return (first,)


# Shift reports and food safety logs follow the plant calendar: every working day, each
# filling line runs shifts A and B and logs its checks. Index 0 is the oldest.
def _slots(counts: Counts, module: str, per_line: int) -> tuple[int, int, int]:
    lines = len(filling_lines(counts))
    per_day = lines * per_line
    days = -(-counts[module] // per_day)
    return lines, per_day, days


@counted
def report_slot(report: int, counts: Counts) -> tuple[int, int, str]:
    """(working-day offset, work center, shift) of a shift report."""
    _lines, per_day, days = _slots(counts, "shift_reports", SLOTS_PER_SHIFT_DAY)
    position = report % per_day
    line = filling_lines(counts)[position // SLOTS_PER_SHIFT_DAY]
    return days - 1 - report // per_day, line, "AB"[position % SLOTS_PER_SHIFT_DAY]


@counted
def downtime_report(event: int, counts: Counts) -> int:
    return skewed_parent("report_downtime", event, counts["shift_reports"])


@cache
def downtime_reason(event: int) -> int:
    if event == 0:
        return 3  # Capper torque fault: the breakdown that the create rule flags.
    if event < PINNED:
        return (2, 0, 10, 4, 14, 2, 1, 13, 2)[event - 1]
    return rng("downtime_events", event, "reason").choices(
        range(len(REASON_WEIGHTS)), weights=REASON_WEIGHTS)[0]  # fmt: skip


@cache
def downtime_minutes(event: int) -> int:
    if event == 0:
        return 45
    loss = REASON_LOSS[downtime_reason(event)]
    low, high = {"Minor stop": (5, 15), "Setup or changeover": (20, 60), "Breakdown": (15, 120),
                 "Planned": (30, 240), "Quality loss": (10, 45),
                 "Reduced speed": (10, 60)}[loss]  # fmt: skip
    stream = rng("downtime_events", event, "minutes")
    return min(high, low + int(stream.expovariate(3 / (high - low))))


@cache
def is_breakdown(event: int) -> bool:
    return REASON_LOSS[downtime_reason(event)] == "Breakdown" and downtime_minutes(event) >= 30


@lru_cache(maxsize=16)
def report_downtime(frozen_counts: Frozen) -> dict[int, tuple[int, ...]]:
    counts = dict(frozen_counts)
    found: dict[int, list[int]] = {}
    for event in range(counts["downtime_events"]):
        found.setdefault(downtime_report(event, counts), []).append(event)
    return {key: tuple(value) for key, value in found.items()}


@counted
def log_slot(log: int, counts: Counts) -> tuple[int, int, str, str]:
    """(working-day offset, work center, check type, shift) of a food safety log."""
    _lines, per_day, days = _slots(counts, "food_safety_logs", len(CHECKS))
    position = log % per_day
    line = filling_lines(counts)[position // len(CHECKS)]
    checks = DRY_CHECKS if (line // 2) % 4 == 3 else CHECKS
    check = checks[position % len(CHECKS)]
    shift = "A" if check.startswith("PRP, pre-op") or (log // per_day) % 2 == 0 else "B"
    return days - 1 - log // per_day, line, check, shift


@cache
def log_deviation(log: int) -> bool:
    return log >= PINNED and rng("food_safety_logs", log, "deviation").random() < 0.025
