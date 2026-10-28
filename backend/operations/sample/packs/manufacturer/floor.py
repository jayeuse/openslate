"""Shop-floor, quality, maintenance and finance details: readings, counts and texts."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from operations.sample.packs.manufacturer import dates, money
from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_quality as quality
from operations.sample.packs.manufacturer import vocabulary as words
from operations.sample.packs.manufacturer.plan_base import PINNED, rng
from operations.sample.packs.manufacturer.text import supplier_invoice_no
from operations.sample.packs.manufacturer.values import capa_problem, mwo_task
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec

Counts = Mapping[str, int]
_HELD = frozenset({"QA hold", "Reprocess", "Destroyed"})
PLANNED_MIN = 450  # A 7.5-hour shift after breaks.


def batch_ph(batch: int, counts: Counts, status: str) -> float:
    stream = rng("batch_records", batch, "ph")
    if base.product_line(plant.batch_product(batch, counts))[1] == "Dry seasoning":
        return round(stream.uniform(5.6, 6.4), 2)  # A dry blend slurry; not acidified.
    if status in _HELD and batch >= PINNED:
        return round(stream.uniform(4.42, 4.58), 2)
    return round(stream.uniform(3.55, 4.25), 2)


def _report_minutes(report: int, counts: Counts) -> int:
    events = plant.report_downtime(base.frozen(counts)).get(report, ())
    return min(PLANNED_MIN - 60, sum(plant.downtime_minutes(event) for event in events))


def report_figures(report: int, counts: Counts) -> dict[str, int | float]:
    """Run minutes, units and OEE = availability x performance x quality."""
    line = plant.report_slot(report, counts)[1]
    speed = (140, 120, 60, 45)[(line // 2) % 4]
    run = PLANNED_MIN - _report_minutes(report, counts)
    stream = rng("shift_reports", report, "figures")
    performance = stream.uniform(0.82, 0.97)
    total = int(speed * run * performance)
    scrap = int(total * stream.uniform(0.004, 0.03))
    oee = 100 * (run / PLANNED_MIN) * performance * ((total - scrap) / max(1, total))
    if report == 2:
        oee = max(oee, 68.0)  # The live input lowers it below 55, which flags a review.
    return {"planned_min": PLANNED_MIN, "run_min": run, "total_units": total,
            "good_units": total - scrap, "scrap_units": scrap, "oee": round(oee, 1)}  # fmt: skip


def _log_reading(log: int, counts: Counts) -> float | None:
    check = plant.log_slot(log, counts)[2]
    stream = rng("food_safety_logs", log, "reading")
    deviation = plant.log_deviation(log)
    if check == "CCP, pH":
        return round(stream.uniform(4.41, 4.52) if deviation else stream.uniform(3.6, 4.2), 2)
    if check == "CCP, fill temperature":
        return round(stream.uniform(82.0, 84.5) if deviation else stream.uniform(85.5, 91.5), 1)
    if check == "PRP, pre-op sanitation":
        return float(stream.randint(160, 420) if deviation else stream.randint(12, 140))
    return None


def floor_value(
    module: ModuleSpec, field: FieldSpec, index: int, anchor: date, counts: Counts, status: str,
) -> JsonValue | object:  # fmt: skip
    kind, key = field.value_kind, module.key
    stream = rng(key, index, field.key, "floor")
    if kind == "cook_temp":
        return round(stream.uniform(88, 96), 1)
    if kind == "ph":
        return batch_ph(index, counts, status)
    if kind == "brix":
        if status in {"Weighing"}:
            return OMIT
        return round(stream.uniform(24, 36) if index % 3 else stream.uniform(8, 18), 1)
    if kind == "viscosity":
        return OMIT if status == "Weighing" else stream.randrange(2_400, 9_800, 50)
    if kind in {"good_units", "total_units", "planned_min", "run_min", "scrap_units", "oee"}:
        return report_figures(index, counts)[kind]
    if kind == "duration":
        return plant.downtime_minutes(index)
    if kind == "lot_code":
        return _lot_code(index, anchor, counts)
    if kind == "best_by":
        slot = plant.finished_slot(index, counts)
        product = plant.wo_product(slot[0], counts) if slot else 0
        day = dates.working_day(plant.finished_wd(index, counts), anchor)
        return dates.best_by(day, base.product_line(product)[5])
    if kind == "cases_produced":
        return rng(key, index, "cases").choice((312, 480, 640, 800, 960, 1_120, 1_440, 1_600))
    if kind == "cases_on_hand":
        produced = int(floor_value(module, _CASES, index, anchor, counts, status))  # type: ignore[call-overload]
        if status in {"Shipped out", "Destroyed"}:
            return 0
        return produced if status != "Released" else int(produced * stream.uniform(0.3, 1.0))
    if kind == "fg_location":
        if status in {"Quality hold", "Rework", "Recalled"}:
            return "Hold cage"
        return OMIT if status == "Shipped out" else words.FG_LOCATIONS[index % 3]
    if kind == "reading":
        reading = _log_reading(index, counts)
        return OMIT if reading is None else reading
    if kind == "qty_affected":
        return stream.choice((12, 40, 96, 160, 312, 480, 1_200))
    if kind == "containment":
        return _containment(index, status)
    if kind == "ncr_cost":
        if status not in {"Dispositioned", "Closed"}:
            return OMIT
        from operations.sample.packs.manufacturer.realism import NCR_COST
        from operations.sample.realism import long_tail_amount

        return long_tail_amount(rng("ncrs", index, "cost"), NCR_COST)
    if kind == "problem":
        return capa_problem(index, counts)[1]
    if kind == "root_cause":
        if status in {"Open", "Root cause"}:
            return OMIT
        return ("Worn chuck inserts let caps cross-thread.", "Paste lot from one supplier had "
                "a low NTSS.", "Label rolls were stored with the house labels.",
                "The 5 Whys traced it to a missed changeover check.")[index % 4]  # fmt: skip
    if kind == "action_plan":
        if status == "Open":
            return OMIT
        plans = ("Replace inserts every 500 hours; add a torque check to the start-up list.",
                 "Add a second signature to the label changeover form; retrain line leads.",
                 "Tighten the incoming spec and ask the supplier for a CAPA.")  # fmt: skip
        return plans[index % 3]
    return _support_value(module, field, index, anchor, counts, status)


_CASES = FieldSpec("cases_produced", "Cases produced", "Integer", "cases_produced")


def _lot_code(lot: int, anchor: date, counts: Counts) -> str:
    """Plant A, year digit, day of the year, line and shift, as 21 CFR 114.80 asks."""
    day = dates.working_day(plant.finished_wd(lot, counts), anchor)
    slot = plant.finished_slot(lot, counts)
    line = base.work_center(plant.wo_line(slot[0], counts))[0] if slot else "L1"
    shift = "AB"[lot % 2]
    return f"A{day.year % 10}{day.timetuple().tm_yday:03d}{line}{shift}"


def _containment(ncr: int, status: str) -> str | object:
    if status == "Voided":
        return "Raised in error, same lot as an earlier NCR."
    source = quality.ncr_source(ncr)
    return {
        "Incoming": "Totes tagged and moved to the hold area; supplier notified.",
        "Supplier": "Remaining stock tagged on hold; supplier asked for a COA review.",
        "In-process": "Batch held in the kettle, pH retest ordered before release.",
        "Final": "Pallets moved to the hold cage; retain samples pulled.",
        "Customer complaint": "Retain samples pulled; distribution checked for the same lot.",
        "Audit": "Records corrected and the team briefed.",
    }[source]


def _support_value(
    module: ModuleSpec, field: FieldSpec, index: int, anchor: date, counts: Counts, status: str,
) -> JsonValue | object:  # fmt: skip
    kind, key = field.value_kind, module.key
    stream = rng(key, index, field.key, "support")
    if kind == "asset_tag":
        return quality.equipment_tag(index, counts)
    if kind == "make_model":
        return quality.equipment_slot(index, counts)[1][2]
    if kind == "install_year":
        return anchor.year - stream.randint(1, 24)
    if kind == "runtime_hours":
        return stream.randrange(1_200, 48_000, 10)
    if kind == "task":
        return mwo_task(index, counts)
    if kind == "labor_hours":
        if status not in {"Completed", "Closed", "In progress", "Waiting parts"}:
            return OMIT
        return stream.choice((0.5, 1, 1.5, 2, 2, 3, 4, 6, 8, 12))
    if kind == "parts_cost":
        if status not in {"Completed", "Closed"} or stream.random() < 0.4:
            return OMIT
        from operations.sample.packs.manufacturer.realism import PARTS
        from operations.sample.realism import long_tail_amount

        return long_tail_amount(rng(key, index, "parts"), PARTS)
    if kind == "supplier_invoice_no":
        return supplier_invoice_no(index)
    if kind == "supplier_invoice_amount":
        return money.supplier_invoice_amount(index, counts)
    if kind == "variance":
        return money.price_variance(index, counts)
    if kind == "invoice_amount":
        return money.invoice_amount(index, counts)
    if kind == "invoice_balance":
        return money.invoice_balance(index, counts)
    if kind == "payment_amount":
        return money.payment_amount(index, counts)
    raise ValueError(f"Unsupported sauce plant field {key}.{field.key}")


