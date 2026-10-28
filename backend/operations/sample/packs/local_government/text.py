"""Natural city hall record text and reserved-domain identifiers (a Philippine city)."""

from __future__ import annotations

import random
import re
from collections.abc import Mapping

from operations.sample.packs.local_government import items, links, vocabulary
from operations.sample.packs.local_government import links_finance as finance
from operations.sample.packs.local_government.catalog_fields import (
    BARANGAYS,
    LINES_OF_BUSINESS,
    OFFICES,
)
from operations.sample.realism import ordered_skew, weighted_label

_CODES: dict[str, tuple[str, int, int]] = {
    "business_establishments": ("BIN-", 4_100, 6), "permit_applications": ("BP-", 412, 5),
    "business_inspections": ("JIT-", 101, 4), "enforcement_notices": ("EN-", 31, 4),
    "building_permits": ("OBO-BP-", 318, 4), "building_inspections": ("BI-", 1_201, 5),
    "service_requests": ("SR-", 11_402, 6), "work_orders": ("WO-", 873, 4),
    "payment_orders": ("OOP-", 5_731, 5), "official_receipts": ("", 8_834_127, 7),
    "deposit_reports": ("CDR-", 101, 4), "payment_releases": ("", 45_821, 7),
    "appropriations": ("AP-", 1, 3), "obligation_requests": ("OBR-100-", 233, 4),
    "disbursement_vouchers": ("DV-", 417, 4), "suppliers": ("SUP-", 1, 3),
    "purchase_requests": ("PR-", 142, 4), "procurement_projects": ("BAC-", 61, 4),
    "bids": ("BID-", 1, 4), "purchase_orders": ("PO-", 98, 4),
    "acceptance_reports": ("IAR-", 77, 4), "civil_registry": ("LCR-", 412, 5),
}  # fmt: skip
_DIRECTION_PREFIX = {"Incoming": "IN", "Outgoing": "OUT", "Internal": "INT"}
_LINE_WEIGHTS = ordered_skew(LINES_OF_BUSINESS, alpha=0.7)
_STEMS = (
    *vocabulary.BUSINESS_WORDS,
    *vocabulary.LAST_NAMES,
    *(f"{name}'s" for name in vocabulary.FIRST_NAMES),
)
_ACCOUNTS = {
    "MOOE": ("Office supplies", "Repairs and maintenance, roads", "Fuel, oil and lubricants",
             "Electricity", "Water", "Travelling expenses", "Training expenses",
             "Janitorial services", "Security services", "Other supplies and materials"),
    "Personal services": ("Salaries and wages, regular", "Overtime and night pay",
                          "Year-end bonus", "Personnel economic relief allowance"),
    "Capital outlay": ("Road networks", "Flood control systems", "Office equipment",
                       "Motor vehicles", "Buildings"),
    "Financial expenses": ("Interest expenses", "Bank charges"),
}  # fmt: skip


def _rng(*parts: object) -> random.Random:
    return random.Random("lg:" + ":".join(map(str, parts)))


def reference_code(module_key: str, index: int, _seed: int) -> str | None:
    if module_key == "communications":
        prefix = _DIRECTION_PREFIX[direction(index)]
        return f"{prefix}-{20_931 + index:05d}"
    if module_key == "legislative_measures":
        kind = "Res." if measure_kind(index) == "Resolution" else "Ord."
        return f"{kind} No. {17 + index:03d}"
    code = _CODES.get(module_key)
    if code is None:
        return None
    prefix, start, width = code
    return f"{prefix}{start + index:0{width}d}"


def direction(communication: int) -> str:
    if communication == 0:
        return "Outgoing"  # The transmittal of an approved ordinance to the mayor.
    return weighted_label(_rng("direction", communication),
                          {"Incoming": 62, "Outgoing": 26, "Internal": 12})  # fmt: skip


def measure_kind(measure: int) -> str:
    if measure < links.PINNED:
        return "Ordinance" if measure % 3 != 1 else "Resolution"
    return weighted_label(_rng("measure-kind", measure),
                          {"Resolution": 55, "Ordinance": 33, "Revenue ordinance": 8,
                           "Appropriation ordinance": 4})  # fmt: skip


def person_name(index: int, seed: int, salt: str = "person") -> str:
    rng = random.Random(f"{seed}:{salt}:{index}")
    return f"{rng.choice(vocabulary.FIRST_NAMES)} {rng.choice(vocabulary.LAST_NAMES)}"


def line_of_business(establishment: int) -> str:
    if establishment < links.PINNED:
        return LINES_OF_BUSINESS[establishment * 3 % len(LINES_OF_BUSINESS)]
    return weighted_label(_rng("line", establishment), _LINE_WEIGHTS)


def org_type(establishment: int) -> str:
    sign = vocabulary.BUSINESS_SIGNS[line_of_business(establishment)]
    if sign in {"Builders", "Commercial Spaces", "Warehousing", "Fuel Station"}:
        return "Corporation"
    return weighted_label(_rng("org", establishment),
                          {"Sole proprietorship": 78, "Partnership": 6, "Corporation": 10,
                           "One-person corporation": 4, "Cooperative": 2})  # fmt: skip


def _base_name(establishment: int, seed: int) -> str:
    stem = _STEMS[(establishment * 37 + seed % 89) % len(_STEMS)]
    name = f"{stem} {vocabulary.BUSINESS_SIGNS[line_of_business(establishment)]}"
    kind = org_type(establishment)
    if kind == "Corporation":
        return f"{name} Corporation"
    return f"{name} Cooperative" if kind == "Cooperative" else name


def business_name(establishment: int, seed: int) -> str:
    """Now and then a business re-registers under a name close to another one (spec R6)."""
    if establishment >= 2 * links.PINNED and _rng("twin", establishment).random() < 0.02:
        return _base_name(establishment - 11, seed).replace("Corporation", "Corp.")
    return _base_name(establishment, seed)


def taxpayer(establishment: int, seed: int) -> str:
    if org_type(establishment) in {"Corporation", "Cooperative", "One-person corporation"}:
        return business_name(establishment, seed)
    return person_name(establishment, seed, "owner")


def street_address(module_key: str, index: int, seed: int) -> str:
    rng = random.Random(f"{seed}:{module_key}:{index}:address")
    street = rng.choice(vocabulary.STREETS)
    return (
        f"{rng.randint(1, 240)} {street}"
        if rng.random() < 0.6
        else (f"Lot {rng.randint(1, 40)} Blk {rng.randint(1, 18)}, {street}")
    )


def barangay(module_key: str, index: int, seed: int) -> str:
    rng = random.Random(f"{seed}:{module_key}:{index}:barangay")
    return weighted_label(rng, ordered_skew(BARANGAYS, alpha=0.6))


def supplier_name(index: int) -> str:
    return items.supplier_name(index)


def procurement_item(request: int) -> tuple[str, str, str]:
    """The item, the end-user office, and the kind of supplier that provides it."""
    item, office, kind, _budget = items.item(request)
    return item, office, kind


def item_budget(request: int) -> int:
    """The usual approved budget for the item, before this request's own quantities."""
    return items.item(request)[3]


def building_project(permit: int, seed: int) -> str:
    rng = random.Random(f"{seed}:building:{permit}")
    kind = rng.choice(
        (
            "Two-storey residence",
            "Single-storey residence",
            "Commercial building",
            "Warehouse",
            "Apartment, 4 doors",
            "Perimeter fence",
            "Store extension",
            "Second-floor addition",
            "Billboard structure",
            "Chapel renovation",
        )
    )
    return f"{kind} — {person_name(permit, seed, 'builder')}"


def account_title(appropriation: int) -> str:
    titles = _ACCOUNTS[finance.expense_class(appropriation)]
    return titles[(appropriation // 3) % len(titles)]


def account_code(appropriation: int) -> str:
    prefix = {"MOOE": "5-02", "Personal services": "5-01", "Capital outlay": "1-07",
              "Financial expenses": "5-03"}[finance.expense_class(appropriation)]  # fmt: skip
    return f"{prefix}-{(appropriation * 7) % 99 + 1:02d}-{(appropriation * 13) % 990 + 10:03d}"


_ENGINEERING_ACCOUNTS = frozenset({"Repairs and maintenance, roads", "Road networks",
                                   "Flood control systems"})  # fmt: skip


def office(index: int, salt: str) -> str:
    if salt == "appropriation" and account_title(index) in _ENGINEERING_ACCOUNTS:
        return "City Engineering Office"
    return OFFICES[_rng(salt, index).randrange(len(OFFICES))]


def payor(order: int, seed: int, counts: Mapping[str, int]) -> str:
    app = finance.oop_application(order, counts)
    if app is not None:
        return business_name(links.application_establishment(app, counts), seed)
    permit = finance.oop_permit(order, counts)
    if permit is not None:
        return building_project(permit, seed).split(" — ")[-1]
    return person_name(order, seed, "payor")


def obr_payee(obr: int, seed: int, counts: Mapping[str, int]) -> str:
    po = finance.obr_po(obr, counts)
    if po is not None:
        return supplier_name(finance.po_supplier(po, counts))
    kind = finance.obr_kind(obr, counts)
    if kind == "Payroll":
        return f"Payroll — {office(obr, 'payroll')}"
    if kind == "Utilities":
        return vocabulary.PAYEES[obr % len(vocabulary.PAYEES)]
    if kind == "Travel":
        return person_name(obr, seed, "traveller")
    return vocabulary.INCIDENTAL_PAYEES[obr % len(vocabulary.INCIDENTAL_PAYEES)]


def measure_title(measure: int) -> str:
    titles = vocabulary.MEASURE_TITLES
    title = titles[measure % len(titles)]
    if measure < len(titles):
        return title
    return f"{title}, amending Ordinance No. {measure - len(titles) + 3:03d}"


def communication_parts(
    communication: int, seed: int, counts: Mapping[str, int]
) -> tuple[str, str]:
    """The subject and the sender or addressee, so the title and the field agree."""
    measures = finance.communication_measures(communication % max(1, counts["communications"]),
                                              counts)  # fmt: skip
    if measures:
        code = reference_code("legislative_measures", measures[0], seed)
        return f"Transmittal of {code}", "Office of the City Mayor"
    rng = random.Random(f"{seed}:communications:{communication}:subject")
    return rng.choice(vocabulary.SUBJECTS), rng.choice(vocabulary.CORRESPONDENTS)


def communication_subject(communication: int, seed: int, counts: Mapping[str, int]) -> str:
    subject, correspondent = communication_parts(communication, seed, counts)
    return f"{subject} — {correspondent}"


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower().replace("ñ", "n"))[:40] or "office"


def email_value(module_key: str, index: int, seed: int, _counts: Mapping[str, int]) -> str:
    if module_key == "suppliers":
        return f"sales@{slug(supplier_name(index))}.example"
    return f"{slug(_base_name(index, seed))}{index % 89 + 10}@mailbox.example"


def phone_value(index: int, seed: int, module_key: str = "contacts") -> str:
    rng = random.Random(f"{seed}:{module_key}:phone:{index}")
    return f"+63 9{rng.randrange(15, 99)} {rng.randrange(100, 999)} {rng.randrange(1000, 9999)}"


def url_value(module_key: str, index: int, seed: int) -> str:
    code = reference_code(module_key, index, seed) or f"{index + 1:05d}"
    return f"https://files.dalisaycity.example/obo/inspections/{code.lower()}"


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    if module_key == "payment_orders" and index == 0:
        return "First-quarter installment paid; balance due on the next three quarters."
    pool = vocabulary.NOTES[module_key]
    rng = random.Random(f"{seed}:{module_key}:{field_key}:{index}:city-note")
    return pool[rng.randrange(len(pool))]
