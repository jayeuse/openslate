"""Typed field and module builders plus School option vocabularies."""

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
        key,
        name,
        type_,
        value_kind,
        required,
        options,
        default,
        has_default,
        minimum,
        maximum,
        step,
    )


def _choice(
    key: str,
    name: str,
    options: tuple[str, ...],
    *,
    required: bool = False,
    default: str | None = None,
    value_kind: str = "choice",
) -> FieldSpec:
    selected = default if default is not None else options[0]
    return _field(
        key,
        name,
        "Select",
        value_kind,
        required=required,
        options=options,
        default=selected,
        has_default=True,
    )


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
        key,
        name,
        department,
        prefix,
        date_name,
        statuses,
        standard_count,
        (*common, *fields),
    )


YEAR_GROUPS = ("Reception", *(f"Year {year}" for year in range(1, 14)))
TERMS = ("Autumn term", "Spring term", "Summer term")
SCHOOL_YEARS = tuple(f"{year}–{year + 1}" for year in range(2024, 2029))
ATTENDANCE_CODES = (
    "L — Late before register closes",
    "U — Late after register closes",
    "I — Illness",
    "M — Medical or dental appointment",
    "C1 — Participating in a performance",
    "R — Religious observance",
    "J1 — Interview",
    "E — Suspended",
    "G — Holiday not authorised",
    "N — Reason not yet established",
    "O — Other or unknown absence",
    "V — Educational visit",
    "P — Approved sporting activity",
    "B — Other off-site activity",
    "Y2 — Travel disruption",
)
