"""Notes as plant people write them (research §9): short, specific, sometimes blank."""

from __future__ import annotations

import random
from collections.abc import Mapping

from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer.text import NOTES, note_text

Counts = Mapping[str, int]
_DOWNTIME = {
    0: "Allergen wash done, ATP and allergen swab pass, released for honey mustard.",
    2: "Jar jammed at the star wheel, cleared and restarted.",
    3: "Capper chuck 4 slipping, torque low, MWO raised.",
    6: "Metal detector test failed on the SS wand, line stopped until the reset.",
    7: "Waiting on batch, pH retest on the kettle before release.",
    8: "Waiting on paste tote, receiving says truck at door 3.",
    14: "CIP after the allergen run.",
}
_LOGS = {
    "CCP, metal detection": "Metal detector test with Fe, NFe and SS wands passed.",
    "CCP, fill temperature": "Fill temperature checked at start-up and every hour.",
    "CCP, pH": "Equilibrium pH checked before the batch went to the filler.",
    "PRP, pre-op sanitation": "Pre-op: surfaces clean, ATP swabs pass.",
    "PRP, allergen changeover": "Allergen changeover verified, swab pass.",
    "PRP, label verification": "Label roll changed, allergen statement checked against spec, OK.",
}
_DEVIATIONS = {
    "CCP, pH": "pH above the action limit, batch held, pH retest ordered.",
    "CCP, fill temperature": "Fill temp dipped to 83 °C about 6 min, cases held, QA notified.",
    "PRP, pre-op sanitation": "Pre-op: residue on filler bowl gasket, re-cleaned, re-swabbed pass.",
}


def note(module: str, index: int, seed: int, counts: Counts, status: str) -> str:
    stream = random.Random(f"{seed}:{module}:{index}:notes")
    if index >= base.PINNED and stream.random() < 0.18:
        return ""
    if module == "downtime_events":
        return _DOWNTIME.get(plant.downtime_reason(index), "Cleared by the line lead.")
    if module == "food_safety_logs":
        check = plant.log_slot(index, counts)[2]
        if plant.log_deviation(index):
            return _DEVIATIONS.get(check, "Outside the limit, corrected and rechecked.")
        return _LOGS[check]
    if module == "batch_records":
        if status in {"QA hold", "Reprocess"}:
            return "pH retest after acid adjustment, held for QA."
        return ("Released to filler after the QA check.", "Cook held at 93 °C for 5 minutes.",
                "Rework from the last batch added.", "Brix on the high side, within spec.")[
            stream.randrange(4)]  # fmt: skip
    if module == "material_lots":
        if index == 0:
            return "Mold on two totes at receiving, lot rejected, NCR to follow."
        if base.material_info(supply.lot_material(index, counts))[1] == "Ingredient":
            return f"Incoming inspection, sample size {stream.choice((5, 8, 13))} units, " \
                   "COA matches spec."  # fmt: skip
        return "Counted and put away."
    if module == "production_orders" and plant.wo_trial(index, counts):
        return "Line trial run for the new SKU; the product developer is on the line."
    if module == "products" and base.product_class(index) == "Development":
        return "Formula from the test kitchen, waiting on shelf-life results."
    if module == "shift_reports":
        return ("Smooth shift, no carryover.", "Handover: L2 labeler needs a new roll.",
                "Two short stops on the case packer.", "Changeover ran long, see downtime.")[
            stream.randrange(4)]  # fmt: skip
    if module == "ncrs":
        if index == 1:
            return "Customer reports a glass fragment; retain samples pulled for the lot."
        return "Logged in the NCR register."
    if module in NOTES:
        return note_text(module, "notes", index, seed)
    return NOTES["general"][stream.randrange(len(NOTES["general"]))]
