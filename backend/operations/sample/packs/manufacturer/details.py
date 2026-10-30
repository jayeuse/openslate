"""Business dates, quantities and texts of plant records; ``OMIT`` leaves a field empty."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, timedelta

from operations.sample.packs.manufacturer import dates, money, timeline
from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer import vocabulary as words
from operations.sample.packs.manufacturer.plan_base import rng
from operations.sample.packs.manufacturer.values import supplier_lot
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec

Counts = Mapping[str, int]
_MAIN_DATES = frozenset({
    "order_date", "po_date", "planned_start", "received_date", "ship_date", "batch_date",
    "report_date", "event_date", "production_date", "log_date", "ncr_opened", "capa_opened",
    "requested_on", "supplier_invoice_date", "invoice_date", "payment_date", "last_pm",
    "promised_date",
})  # fmt: skip
_RELEASED = frozenset({"Released", "Shipped out", "Recalled"})


def _main(module: str, index: int, anchor: date, counts: Counts) -> date:
    return dates.working_day(timeline.main_wd(module, index, counts), anchor)


def date_value(
    module: ModuleSpec, field: FieldSpec, index: int, anchor: date, counts: Counts, status: str
) -> date | str | None:
    """A Date field's day, or a Date/Time field's stamp; ``None`` leaves it empty."""
    key, kind = module.key, field.value_kind
    salt = f"mfg:{key}:{index}:{field.key}"
    if kind in _MAIN_DATES:
        if kind == "last_pm" and status == "Retired":
            return None
        return _main(key, index, anchor, counts)
    main = _main(key, index, anchor, counts)
    if kind == "requested_ship":
        lead = rng(key, index, "ship").randint(3, 10)
        return dates.working_day(timeline.main_wd(key, index, counts) - lead, anchor)
    if kind in {"po_due", "wo_due"}:
        low, high = (5, 21) if kind == "po_due" else (2, 6)
        return dates.days_after(main, low, high, salt, anchor)
    if kind == "release_date":
        if status not in _RELEASED:
            return None
        released = plant.finished_wd(index, counts) - rng(key, index, "release").randint(1, 2)
        return dates.working_day(max(0, released), anchor)
    if kind == "started_at":
        report = plant.downtime_report(index, counts)
        return dates.shift_stamp(main, plant.report_slot(report, counts)[2], salt)
    if kind == "scheduled_on":
        if status in {"Requested", "Cancelled"}:
            return None
        if status in {"Scheduled", "Approved"}:
            return dates.working_day(-rng(key, index, "plan").randint(1, 10), anchor)
        return main
    if kind == "capa_due":
        return dates.days_after(main, 30, 60, salt, anchor)
    if kind == "capa_check":
        if status not in {"Effectiveness check", "Closed, effective", "Reopened"}:
            return None
        return dates.days_after(main, 20, 45, salt, anchor)
    if kind in {"supplier_due", "invoice_due"}:
        terms = 45 if kind == "invoice_due" and index % 4 == 1 else 30
        return main + timedelta(days=terms) if main + timedelta(days=terms) <= anchor + \
            timedelta(days=88) else anchor + timedelta(days=88)  # fmt: skip
    raise ValueError(f"Unsupported sauce plant date {key}.{field.key}")


def detail_value(
    module: ModuleSpec, field: FieldSpec, index: int, seed: int, anchor: date,
    counts: Counts, status: str,
) -> JsonValue | object:  # fmt: skip
    kind, key = field.value_kind, module.key
    stream = rng(key, index, field.key, "detail")
    if kind == "ship_region":
        return words.REGIONS[(index * 7) % len(words.REGIONS)]
    if kind == "credit_limit":
        return money.credit_limit(index)
    if kind == "since_year":
        return anchor.year - (min(30, int(stream.expovariate(1 / 7))) if index else 12)
    if kind == "customer_po":
        channel = base.customer_channel(base.customer_of_order(index, counts))
        if channel == "Retail":
            return f"45{(index * 104_729 + 123_987) % 10**8:08d}"
        return OMIT if stream.random() < 0.2 else f"PO {(index * 613 + 2_210) % 90_000 + 10_000}"
    if kind == "order_value":
        return money.order_value(index, counts)
    if kind == "line_no":
        return sales.line_slot(index, counts)[1]
    if kind == "qty_cases":
        return money.line_cases(index, counts)
    if kind == "case_price":
        return money.line_price(index, counts)
    if kind == "customer_item":
        if stream.random() < 0.5:
            return OMIT
        return f"{(index * 271 + 1_004) % 9_000 + 1_000}-{index % 7}"
    if kind == "pack_size":
        return base.product_pack(index)[0]
    if kind == "units_per_case":
        return base.product_pack(index)[1]
    if kind == "shelf_life":
        return base.product_line(index)[5]
    if kind == "allergens":
        return base.product_line(index)[4] or "None declared"
    if kind == "list_price":
        return money.cents(base.list_price(index))
    if kind == "standard_cost":
        return money.standard_cost(index)
    if kind == "on_hand":
        return _on_hand(index)
    if kind == "reorder_point":
        return 6 if base.material_info(index)[2] == "tote" else money.cents(_on_hand(index) * 0.3)
    if kind == "lead_time":
        return base.material_info(index)[5]
    if kind == "contract_price":
        return money.cents(base.material_info(index)[3])
    return _later_detail(module, field, index, seed, anchor, counts, status)


def _on_hand(material: int) -> int | float:
    if material == 2:
        return 14  # Paste totes: the live input lowers it below 6, which flags a reorder.
    stream = rng("materials", material, "on-hand")
    unit = base.material_info(material)[2]
    low, high = {"tote": (8, 30), "kg": (200, 9_000), "L": (500, 12_000), "ea": (2_000, 90_000),
                 "roll": (5, 80), "case": (10, 300)}[unit]  # fmt: skip
    return stream.randint(low, high)


def _later_detail(
    module: ModuleSpec, field: FieldSpec, index: int, seed: int, anchor: date,
    counts: Counts, status: str,
) -> JsonValue | object:  # fmt: skip
    del seed
    kind, key = field.value_kind, module.key
    stream = rng(key, index, field.key, "detail")
    if kind == "version":
        from operations.sample.packs.manufacturer.states import bom_version

        return bom_version(index, counts)
    if kind == "batch_size":
        return stream.choice((900, 1_200, 1_500, 1_800, 1_850, 2_000))
    if kind == "yield_pct":
        return round(stream.uniform(94.0, 98.8), 1)
    if kind == "effective_since":
        return dates.month_year(anchor, -stream.randint(1, 40))
    if kind == "formula":
        return _formula(index, counts)
    if kind == "country":
        return words.SUPPLIER_COUNTRIES[index % len(words.SUPPLIER_COUNTRIES)]
    if kind == "on_time":
        return round(stream.uniform(82, 99.5), 1)
    if kind == "certification":
        if base.supplier_category(index) in {"MRO", "Service"}:
            return OMIT
        cert = words.CERTIFICATIONS[index % len(words.CERTIFICATIONS)]
        return f"{cert}, expires {dates.month_year(anchor, stream.randint(2, 20))}"
    if kind == "po_qty":
        return money.po_qty(index, counts)
    if kind == "po_price":
        return money.po_price(index, counts)
    if kind == "po_total":
        return money.po_total(index, counts)
    if kind == "planned_cases":
        return _planned_cases(index)
    if kind in {"completed_cases", "scrap_cases"}:
        return _cases(index, kind, status)
    if kind == "supplier_lot":
        return supplier_lot(index, counts)
    if kind == "qty_received":
        po = supply.lot_po(index, counts)
        return money.po_qty(po, counts) if po is not None else 10
    if kind == "best_before":
        material = base.material_info(supply.lot_material(index, counts))
        if material[1] not in {"Ingredient"}:
            return OMIT
        months = stream.randint(6, 20) - timeline.main_wd(key, index, counts) // 21
        return dates.month_year(anchor, months)
    if kind == "location":
        return words.LOCATIONS[(index * 5) % len(words.LOCATIONS)]
    if kind == "carrier":
        return words.CARRIERS[(index * 3) % len(words.CARRIERS)]
    if kind == "pallets":
        return stream.choice((4, 6, 8, 12, 18, 22, 24, 26))
    if kind == "seal_number":
        if status in {"Planned", "Picking"}:
            return OMIT
        return f"{(index * 7_877 + 310_442) % 10**6:06d}"
    if kind == "freight_cost":
        return money.freight_cost(index)
    if kind == "rated_speed":
        speed = {"Filling line": 140, "Packing": 60, "Blending": 45}.get(base.work_center(index)[2])
        return OMIT if speed is None else speed
    if kind == "shift_pattern":
        return "2 shifts, 5 days; Saturday overtime in peak season"
    return _floor_detail(module, field, index, anchor, counts, status)


def _planned_cases(wo: int) -> int:
    return rng("production_orders", wo, "cases").choice((800, 1_200, 1_500, 2_000, 2_400, 3_000,
                                                         4_000, 5_000))  # fmt: skip


def _cases(wo: int, kind: str, status: str) -> int | object:
    planned = _planned_cases(wo)
    stream = rng("production_orders", wo, kind)
    if status in {"Created", "Released", "Cancelled"}:
        return OMIT
    share = {"In progress": 0.35, "Partially confirmed": 0.6, "On hold": 0.2}.get(status, 0.98)
    done = int(planned * share * stream.uniform(0.95, 1.03))
    return done if kind == "completed_cases" else max(0, int(done * stream.uniform(0.002, 0.02)))


def _formula(bom: int, counts: Counts) -> str:
    from operations.sample.packs.manufacturer.states import bom_product

    product = bom_product(bom, counts)
    family = base.product_line(product)[1]
    if family == "Dry seasoning":
        return "Salt 32%; spice blend 41%; dextrose 15%; garlic and onion 10%; silica 2%."
    return ("Tomato paste 28%; vinegar 120 grain 18%; sugar 16%; water 30%; salt 2.4%; "
            "spices and flavor 5.6%. Jar, cap, label and 12-count case.")  # fmt: skip


def _floor_detail(
    module: ModuleSpec, field: FieldSpec, index: int, anchor: date, counts: Counts, status: str,
) -> JsonValue | object:  # fmt: skip
    from operations.sample.packs.manufacturer.floor import floor_value

    return floor_value(module, field, index, anchor, counts, status)


