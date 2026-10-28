"""Select choices of plant records, and the facts that titles and details share."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_quality as quality
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer import vocabulary as words
from operations.sample.packs.manufacturer.catalog_fields import (
    DEFECT_TYPES,
    FAILURE_CODES,
    KETTLES,
    REASON_CODES,
    REASON_LOSS,
)
from operations.sample.packs.manufacturer.plan_base import PINNED, draw, rng
from operations.sample.packs.types import FieldSpec, ModuleSpec
from operations.sample.realism import ordered_skew

Counts = Mapping[str, int]
_FAMILY_DEFECTS = {
    "In-process": (13,),
    "Incoming": (2, 4, 0),
    "Supplier": (12, 9, 0),
    "Final": (10, 3, 7, 11, 9),
    "Customer complaint": (0, 5, 4, 1, 11),
    "Audit": (9, 7),
}


def payment_method(payment: int) -> str:
    if payment < PINNED:
        return "ACH"
    return draw("customer_payments", payment, {"ACH": 70, "Check": 20, "Wire": 8, "Card": 2})


def ncr_defect(ncr: int, counts: Counts) -> str:
    if ncr == 1:
        return DEFECT_TYPES[0]
    if ncr == 0:
        return DEFECT_TYPES[2]
    options = _FAMILY_DEFECTS[quality.ncr_source(ncr)]
    return DEFECT_TYPES[options[rng("ncrs", ncr, "defect").randrange(len(options))]]


_PROBLEMS = (
    ("Glass fragment in a shipped jar", "Customer found glass in a jar from a shipped lot."),
    ("Repeat pH holds on K2", "Three batches on K2 held for pH above the action limit."),
    ("Short fills on L2", "Checkweigher rejects above 2% on L2 for two weeks."),
    ("Wrong back label on private label run", "Private label run used the house back label."),
    ("Mold on incoming tomato paste", "Two totes of paste rejected for mold at receiving."),
    ("Missing codes on L3 pouches", "Inkjet coder skipped codes on L3 pouches."),
    ("Loss of vacuum on L1 jars", "Duds found in the cooling tunnel on L1."),
)


def capa_problem(capa: int, counts: Counts) -> tuple[str, str]:
    del counts
    return _PROBLEMS[capa % len(_PROBLEMS)]


def mwo_task(mwo: int, counts: Counts) -> str:
    event = quality.mwo_downtime(mwo, counts)
    tag = quality.equipment_tag(quality.mwo_equipment(mwo, counts), counts)
    if event is not None:
        reason = plant.downtime_reason(event)
        return words.CORRECTIVE_TASKS.get(reason, f"Breakdown on {tag}, find and fix the cause")
    kind = quality.mwo_type(mwo)
    if kind == "Calibration":
        return f"{tag}: calibrate and record the check"
    if kind == "Improvement":
        return f"{tag}: install guard and update the SOP"
    if kind in {"Corrective", "Emergency"}:
        return f"{tag}: repair the fault found on the GMP walk"
    template = words.PM_TASKS[rng("maintenance_work_orders", mwo, "task").randrange(6)]
    return template.format(tag=tag)


def vessel(batch: int, counts: Counts) -> str:
    family = base.product_line(plant.batch_product(batch, counts))[1]
    if family == "Dry seasoning":
        return "RB1"
    if family == "Mustard and dressing":
        return "HS1"
    return KETTLES[rng("batch_records", batch, "kettle").randrange(4)]


def choice_label(
    module: ModuleSpec, field: FieldSpec, index: int, counts: Counts, status: str
) -> str | None:
    """The option a person picks; ``None`` leaves an optional Select empty."""
    kind, key = field.value_kind, module.key
    stream = rng(key, index, field.key)
    if kind == "channel":
        return base.customer_channel(index)
    if kind == "terms":
        channel = base.customer_channel(index)
        if channel == "Retail":
            return "Net 30" if stream.random() < 0.6 else "2/10 Net 30"
        return {"Foodservice": "Net 30", "Wholesale": "Net 45",
                "Private label": "Net 45"}.get(channel, "Prepaid")  # fmt: skip
    if kind == "fulfilment":
        return "Make-to-order" if sales.order_mto(index, counts) else "Make-to-stock"
    if kind == "family":
        return base.product_line(index)[1]
    if kind == "material_type":
        return base.material_info(index)[1]
    if kind == "uom":
        return base.material_info(index)[2]
    if kind == "allergen":
        return base.material_info(index)[4]
    if kind == "supplier_category":
        return base.supplier_category(index)
    if kind == "priority":
        return "Rush" if index >= PINNED and stream.random() < 0.12 else "Normal"
    if kind == "wc_type":
        return base.work_center(index)[2]
    if kind == "kettle":
        return vessel(index, counts)
    if kind == "shift":
        return plant.report_slot(index, counts)[2]
    if kind == "log_shift":
        return plant.log_slot(index, counts)[3]
    if kind == "reason_code":
        return REASON_CODES[plant.downtime_reason(index)]
    if kind == "loss_category":
        return REASON_LOSS[plant.downtime_reason(index)]
    if kind == "check_type":
        return plant.log_slot(index, counts)[2]
    if kind == "ncr_source":
        return quality.ncr_source(index)
    if kind == "defect_type":
        return ncr_defect(index, counts)
    if kind == "severity":
        return quality.ncr_severity(index)
    if kind == "disposition":
        return _disposition(index, status)
    if kind == "rca_method":
        if status in {"Open"}:
            return None
        return ("5 Whys", "Fishbone", "Fault tree")[index % 3 if index % 4 else 0]
    if kind == "criticality":
        return quality.equipment_slot(index, counts)[1][3]
    if kind == "mwo_type":
        return quality.mwo_type(index)
    if kind == "mwo_priority":
        if quality.mwo_downtime(index, counts) is not None:
            return "High" if index % 3 else "Urgent"
        if quality.mwo_type(index) == "Emergency":
            return "Urgent"
        weights = ordered_skew(field.options, 1.3)
        return draw(key, index, weights, "priority")
    if kind == "failure_code":
        if quality.mwo_type(index) not in {"Corrective", "Emergency"} or status not in {
            "Completed", "Closed"}:  # fmt: skip
            return None
        event = quality.mwo_downtime(index, counts)
        reason = plant.downtime_reason(event) if event is not None else -1
        fixed = {3: 0, 5: 2, 16: 3, 17: 5, 7: 4, 8: 9}.get(reason)
        return FAILURE_CODES[fixed if fixed is not None else stream.randrange(len(FAILURE_CODES))]
    if kind == "invoice_type":
        return sales.invoice_type(index, counts)
    if kind == "method":
        return payment_method(index)
    raise ValueError(f"Unsupported sauce plant choice {key}.{field.key}")


def _disposition(ncr: int, status: str) -> str | None:
    if status in {"Open", "Contained", "Voided"}:
        return None
    if status == "Under review":
        return "Pending"
    source = quality.ncr_source(ncr)
    if source in {"Incoming", "Supplier"}:
        return "Return to vendor"
    if source == "In-process":
        return "Reprocess" if ncr % 3 else "Rework"
    options = ("Destroy", "Rework", "Use as is, concession")
    return options[rng("ncrs", ncr, "disposition").randrange(len(options))]


def supplier_lot(lot: int, counts: Counts) -> str:
    material = supply.lot_material(lot, counts)
    prefix = "".join(word[0] for word in base.material_info(material)[0].split()[:2]).upper()
    return f"{prefix}{(lot * 3_571 + 260_915) % 1_000_000:06d}-{lot % 9 + 1:02d}"
