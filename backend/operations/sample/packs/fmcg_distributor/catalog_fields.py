"""Typed field and module builders plus the distributor's option lists (research §4, §9)."""

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
    """A Select that stays empty until it applies (a no-order reason, a rejection reason)."""
    return _field(key, name, "Select", value_kind, options=options)


def _flag(key: str, name: str) -> FieldSpec:
    """A follow-up flag that a Set-field rule turns on; people leave it off."""
    return _field(key, name, "Checkbox", "flag", default=False, has_default=True)


def _check(key: str, name: str) -> FieldSpec:
    return _field(key, name, "Checkbox", "boolean", default=False, has_default=True)


def _peso(key: str, name: str, value_kind: str, *, required: bool = False) -> FieldSpec:
    return _field(key, name, "Number", value_kind, required=required, minimum=0, step=0.01)


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


PAYMENT_TERMS = ("Cash on delivery", "7 days", "15 days", "30 days")
TERM_DAYS = {"Cash on delivery": 0, "7 days": 7, "15 days": 15, "30 days": 30}
CHANNELS = (
    "Sari-sari store", "Small grocery", "Pharmacy or drugstore", "Minimart",
    "Wholesaler or market stall", "Carinderia", "Supermarket (modern trade)",
)  # fmt: skip
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
NO_ORDER_REASONS = (
    "Stock still sufficient", "Owner not around", "Store closed", "No cash today",
    "Account on credit hold", "Bought from wholesaler", "Requested item out of stock",
    "Ran out of time", "Road flooded or closed", "Outlet relocated",
)  # fmt: skip
SCHEME_TYPES = (
    "Free goods (buy X get Y)", "Off-invoice discount", "Quantity purchase scheme",
    "Value purchase scheme", "Display allowance", "Bill-back", "Listing fee",
)  # fmt: skip
PRINCIPAL_CATEGORIES = (
    "Packaged food", "Beverages", "Personal care", "Home care", "Dairy", "OTC and health",
)  # fmt: skip
EXPIRY_BANDS = (
    "More than 180 days", "91–180 days", "31–90 days (near expiry)", "30 days or less",
    "Expired",
)  # fmt: skip
NEAR_EXPIRY = EXPIRY_BANDS[2]
COUNT_TYPES = ("Cycle A", "Cycle B", "Cycle C", "Spot check", "Full stock take")
ADJUSTMENT_REASONS = (
    "Cycle count variance", "Damaged in warehouse", "Expired – write-off", "Found stock",
    "Pilferage or shortage", "Repack or re-case", "Free samples issued", "Wrong lot posted",
    "Transfer error",
)  # fmt: skip
BO_REASONS = (
    "Damaged in transit", "Near expiry (30 days or less)", "Expired", "Crushed or dented can",
    "Torn sachet or strip", "Leaking", "Wrong item delivered", "Over-delivered",
    "Swollen or bloated can", "Short-dated on delivery", "Rodent or pest damage",
    "Price dispute", "Packaging defect", "Principal recall",
)  # fmt: skip
DISPOSITIONS = ("Return to principal", "Destroy", "Restock", "Replace")
VEHICLE_TYPES = ("Van 1-ton", "Truck 4-wheel", "Truck 6-wheel", "Motorcycle")
AGING_BUCKETS = ("Current", "1–30", "31–60", "61–90", "Over 90")
RECEIPT_METHODS = ("Cash", "Cheque", "Post-dated cheque", "Bank transfer", "E-wallet")
CREDIT_REASONS = (
    "Over limit", "60+ days overdue", "Bounced cheque history",
    "New account, no trade references", "Business permit expired",
)  # fmt: skip
FOLLOW_UP_ACTIONS = ("Call", "Visit", "Statement sent", "Demand letter", "Endorsed to legal")
MATCH_RESULTS = ("3-way matched", "Quantity variance", "Price variance", "No goods receipt")
CLAIM_TYPES = (
    "Scheme or promo", "BO or expiry return", "Price difference", "Display allowance",
    "Short or damaged delivery", "Freight subsidy",
)  # fmt: skip
CLAIM_REJECTIONS = (
    "Missing proof of performance", "Filed past claim deadline", "Secondary sales not in DMS",
    "SKU not covered by scheme", "Exceeds scheme cap", "Duplicate claim",
    "Unsigned outlet acknowledgment", "Display photos missing or unclear",
    "Price difference not pre-approved",
)  # fmt: skip
