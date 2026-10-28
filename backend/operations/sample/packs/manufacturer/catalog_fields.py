"""Typed field and module builders plus the sauce plant's option lists (research §4, §9)."""

from __future__ import annotations

from operations.sample.packs.types import FieldSpec, FieldType, JsonValue, ModuleSpec


def _field(
    key: str,
    name: str,
    type_: FieldType,
    value_kind: str,
    *,
    required: bool = False,
    options: tuple[str, ...] = (),
    default: JsonValue = None,
    has_default: bool = False,
    minimum: int | float | None = None,
    maximum: int | float | None = None,
    step: int | float | None = None,
) -> FieldSpec:
    return FieldSpec(
        key, name, type_, value_kind, required, options, default, has_default, minimum, maximum,
        step,
    )  # fmt: skip


def _choice(
    key: str,
    name: str,
    options: tuple[str, ...],
    *,
    required: bool = False,
    value_kind: str = "choice",
) -> FieldSpec:
    """A Select whose default is its first option."""
    return _field(
        key, name, "Select", value_kind, required=required, options=options, default=options[0],
        has_default=True,
    )  # fmt: skip


def _optional_choice(key: str, name: str, options: tuple[str, ...], value_kind: str) -> FieldSpec:
    """A Select that stays empty until it applies (a disposition, a failure code)."""
    return _field(key, name, "Select", value_kind, options=options)


def _flag(key: str, name: str) -> FieldSpec:
    """A follow-up flag that a Set-field rule turns on; people leave it off."""
    return _field(key, name, "Checkbox", "flag", default=False, has_default=True)


def _check(key: str, name: str) -> FieldSpec:
    return _field(key, name, "Checkbox", "boolean", default=False, has_default=True)


def _money(key: str, name: str, value_kind: str, *, required: bool = False) -> FieldSpec:
    return _field(key, name, "Number", value_kind, required=required, minimum=0, step=0.01)


def _count(
    key: str, name: str, value_kind: str, *, required: bool = False, maximum: int = 100_000
) -> FieldSpec:
    return _field(key, name, "Integer", value_kind, required=required, minimum=0, maximum=maximum)


def _module(
    key: str,
    name: str,
    department: str,
    prefix: str,
    date_name: str,
    statuses: tuple[str, ...],
    standard_count: int,
    fields: tuple[FieldSpec, ...],
) -> ModuleSpec:
    common = (
        _field("name", "Name", "Text", "title", required=True),
        _choice("status", "Status", statuses, required=True, value_kind="status"),
        _field("owner", "Assigned to", "User", "owner"),
        _field("notes", "Notes", "Long text", "notes", default="", has_default=True),
    )
    return ModuleSpec(
        key, name, department, prefix, date_name, statuses, standard_count, (*common, *fields)
    )


CHANNELS = ("Retail", "Foodservice", "Private label", "Wholesale", "Co-man")
PAYMENT_TERMS = ("Net 30", "Net 45", "2/10 Net 30", "Prepaid")
FULFILMENT = ("Make-to-stock", "Make-to-order")
FAMILIES = ("BBQ", "Ketchup and tomato", "Salsa", "Mustard and dressing", "Hot and wing",
            "Relish", "Dry seasoning")  # fmt: skip
MATERIAL_TYPES = ("Ingredient", "Packaging, primary", "Packaging, secondary", "MRO")
UNITS = ("kg", "L", "ea", "roll", "case", "tote")
ALLERGENS = ("None", "Milk", "Egg", "Soy", "Wheat", "Sesame", "Mustard", "Fish")
SUPPLIER_CATEGORIES = ("Ingredient", "Packaging", "MRO", "Service")
PRIORITIES = ("Normal", "Rush")
WORK_CENTER_TYPES = ("Kettle", "Filling line", "Packing", "Blending")
KETTLES = ("K1", "K2", "K3", "K4", "HS1", "RB1")
SHIFTS = ("A", "B")
REASON_CODES = (
    "DT01 Product changeover or allergen wash", "DT02 Size changeover", "DT03 Filler jam",
    "DT04 Capper torque fault", "DT05 Labeler out of registration", "DT06 Inkjet coder failure",
    "DT07 Metal detector fault or failed check", "DT08 Waiting on batch, pH retest",
    "DT09 Waiting on packaging", "DT10 No operator or break coverage", "DT11 Case packer jam",
    "DT12 Low steam pressure", "DT13 Low compressed air", "DT14 Planned preventive maintenance",
    "DT15 CIP and sanitation", "DT16 Quality hold", "DT17 Palletizer fault", "DT18 Power dip",
)  # fmt: skip
LOSS_CATEGORIES = ("Minor stop", "Breakdown", "Setup or changeover", "Reduced speed",
                   "Quality loss", "Planned")  # fmt: skip
# The loss category each downtime reason belongs to (research §9).
REASON_LOSS = {
    0: "Setup or changeover", 1: "Setup or changeover", 2: "Minor stop", 3: "Breakdown",
    4: "Minor stop", 5: "Breakdown", 6: "Quality loss", 7: "Breakdown", 8: "Breakdown",
    9: "Reduced speed", 10: "Minor stop", 11: "Reduced speed", 12: "Reduced speed",
    13: "Planned", 14: "Planned", 15: "Quality loss", 16: "Breakdown", 17: "Breakdown",
}  # fmt: skip
CHECK_TYPES = ("CCP, pH", "CCP, fill temperature", "CCP, metal detection",
               "PRP, pre-op sanitation", "PRP, allergen changeover",
               "PRP, label verification")  # fmt: skip
NCR_SOURCES = ("In-process", "Incoming", "Final", "Customer complaint", "Audit", "Supplier")
DEFECT_TYPES = (
    "Glass, metal, hard plastic or hair", "Swollen container", "Mold", "Loss of vacuum",
    "Off-flavor or fermented", "Separation", "Color darkening", "Wrong label",
    "Undeclared allergen", "Missing or illegible code", "Short fill", "Leaker",
    "Broken tamper band", "Out of spec, pH, Brix or viscosity",
)  # fmt: skip
SEVERITIES = ("Minor", "Major", "Critical")
DISPOSITIONS = ("Pending", "Rework", "Reprocess", "Use as is, concession", "Return to vendor",
                "Destroy")  # fmt: skip
ROOT_CAUSE_METHODS = ("5 Whys", "Fishbone", "Fault tree")
CRITICALITY = ("A", "B", "C")
MWO_TYPES = ("Preventive", "Corrective", "Emergency", "Calibration", "Improvement")
MWO_PRIORITIES = ("Medium", "Low", "High", "Urgent")
FAILURE_CODES = (
    "FC01 Bearing wear", "FC02 Seal or gasket leak", "FC03 Sensor or photo-eye fault",
    "FC04 Belt or chain", "FC05 Pneumatic, valve or cylinder", "FC06 Electrical or drive",
    "FC07 Lubrication", "FC08 Blockage or product buildup", "FC09 Operator error or setup",
    "FC10 No fault found",
)  # fmt: skip
INVOICE_TYPES = ("Shipment", "Freight rebill", "Art and plate charge", "Pallet charge")
PAYMENT_METHODS = ("ACH", "Check", "Wire", "Card")
