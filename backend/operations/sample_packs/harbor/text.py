"""Natural record text: names, reference numbers, notes, addresses and links."""

from __future__ import annotations

import random
import re
import unicodedata
from collections.abc import Mapping
from functools import cache

from operations.sample_packs.harbor.catalog import _MODULES
from operations.sample_packs.harbor.links import parent_indices
from operations.sample_packs.harbor.vocabulary import (
    COMPANY_STEMS,
    COMPANY_SUFFIXES,
    CONTRACT_TIERS,
    CUSTOMER_TRADES,
    EQUIPMENT_MAKERS,
    EQUIPMENT_TYPES,
    EXPENSES,
    FIRST_NAMES,
    INSPECTION_TYPES,
    INTERNAL_DOMAIN,
    LAST_NAMES,
    MAINTENANCE_PLANS,
    MOVEMENT_REASONS,
    ORDER_ITEMS,
    PLACES,
    PRODUCTS,
    QUOTE_OFFERS,
    REQUEST_UPDATES,
    SITE_LABELS,
    STREETS,
    SUPPLIER_TRADES,
    TEAM_ROSTER,
    WAREHOUSE_NAMES,
    WEEKDAYS,
)
from operations.sample_packs.types import ModuleSpec

_BY_KEY: dict[str, ModuleSpec] = {module.key: module for module in _MODULES}
_NUMBER_START = {
    "customers": ("C-", 10_001),
    "quotes": ("Q-", 24_001),
    "sales_orders": ("SO-", 31_001),
    "customer_sites": ("S-", 2_001),
    "service_contracts": ("SC-", 1_101),
    "service_requests": ("SR-", 9_001),
    "inspections": ("IR-", 6_001),
    "maintenance_plans": ("PM-", 101),
    "work_orders": ("WO-", 18_001),
    "stock_movements": ("MV-", 50_001),
    "stock_counts": ("CC-", 3_001),
    "suppliers": ("V-", 5_001),
    "purchase_orders": ("PO-", 7_701),
    "goods_receipts": ("GRN-", 5_501),
    "invoices": ("INV-", 41_001),
    "payments": ("OR-", 88_001),
    "expenses": ("EXP-", 3_301),
    "credit_notes": ("CN-", 1_001),
}


def _rng(seed: int, *parts: object) -> random.Random:
    return random.Random(":".join(str(part) for part in (seed, "text", *parts)))


def choice_label(module_key: str, field_key: str, index: int, seed: int) -> str:
    """The Select label the generator assigns to a record (catalog choice rule)."""
    field = next(item for item in _BY_KEY[module_key].fields if item.key == field_key)
    return field.options[(index + seed) % len(field.options)]


def _slug(value: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", ascii_text.lower().replace("&", "and"))


def _mixed(index: int, *sizes: int) -> tuple[int, ...]:
    digits = []
    for size in sizes:
        index, digit = divmod(index, size)
        digits.append(digit)
    return tuple(digits)


def customer_name(index: int, seed: int) -> str:
    segment = choice_label("customers", "segment", index, seed)
    trades = CUSTOMER_TRADES[segment]
    stem, trade, suffix = _mixed(index // 4, len(COMPANY_STEMS), len(trades), len(COMPANY_SUFFIXES))
    # Each segment starts at a different stem, so neighbouring customers differ.
    stem = (stem + (index % 4) * 10) % len(COMPANY_STEMS)
    return f"{COMPANY_STEMS[stem]} {trades[trade]}{COMPANY_SUFFIXES[suffix]}"


def supplier_name(index: int) -> str:
    stems = COMPANY_STEMS[::-1]
    stem, trade, suffix = _mixed(index, len(stems), len(SUPPLIER_TRADES), len(COMPANY_SUFFIXES))
    return f"{stems[stem]} {SUPPLIER_TRADES[trade]}{COMPANY_SUFFIXES[suffix]}"


def _company_domain(name: str) -> str:
    core = re.sub(r"\s+(Inc\.|Corp\.)$", "", name)
    return f"{_slug(core)}.example"


def customer_domain(index: int, seed: int) -> str:
    return _company_domain(customer_name(index, seed))


def person_name(index: int) -> tuple[str, str]:
    first = index % len(FIRST_NAMES)
    last = (index // len(FIRST_NAMES) + first * 7) % len(LAST_NAMES)
    return FIRST_NAMES[first], LAST_NAMES[last]


def _equipment(index: int) -> tuple[str, str, int]:
    type_index, unit = index % len(EQUIPMENT_TYPES), index // len(EQUIPMENT_TYPES) + 1
    name, prefix = EQUIPMENT_TYPES[type_index][:2]
    return f"{name} {prefix}-{unit:02d}", f"{prefix}-{unit:02d}", type_index


def equipment_name(index: int) -> str:
    return _equipment(index)[0]


def product_name(index: int, seed: int) -> str:
    category = choice_label("products", "category", index, seed)
    _code, items, variants = PRODUCTS[category]
    item, variant, series = _mixed(index // 4, len(items), len(variants), 10_000)
    base = f"{items[item]}, {variants[variant]}"
    return base if series == 0 else f"{base} (series {series + 1})"


def warehouse_name(index: int, seed: int) -> str:
    names = WAREHOUSE_NAMES[choice_label("warehouses", "region", index, seed)]
    position, round_ = _mixed(index // 4, len(names), 10_000)
    return names[position] if round_ == 0 else f"{names[position]} {round_ + 1}"


def site_place(index: int, seed: int) -> str:
    return PLACES[(index * 7 + seed) % len(PLACES)]


def _site_parts(index: int, seed: int, counts: Mapping[str, int]) -> tuple[str, str]:
    """The site's customer and its own label, such as 'Navotas cold store'."""
    customer = customer_name(index % counts["customers"], seed)
    labels = SITE_LABELS[choice_label("customer_sites", "site_type", index, seed)]
    return customer, f"{site_place(index, seed)} {labels[index % len(labels)]}"


def site_name(index: int, seed: int, counts: Mapping[str, int]) -> str:
    customer, label = _site_parts(index, seed, counts)
    return f"{customer} — {label}"


def reference_code(module_key: str, index: int, seed: int) -> str | None:
    """The business number shown in the Reference field, or None when the thing has none."""
    if module_key == "equipment":
        return _equipment(index)[1]
    if module_key == "products":
        code = PRODUCTS[choice_label("products", "category", index, seed)][0]
        return f"{code}-{2_001 + index}"
    if module_key == "warehouses":
        return f"WH-{index + 1:02d}"
    if module_key == "purchase_lines":
        return f"PO-{7_701 + index // 2}/{index % 2 + 1}"
    numbered = _NUMBER_START.get(module_key)
    if numbered is None:
        return None
    prefix, start = numbered
    return f"{prefix}{start + index}"


def _parent(key: str, index: int, counts: Mapping[str, int]) -> int:
    return parent_indices(key, index, counts)[0]


def record_title(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    """A name a person would type in the record's Name field."""
    rng = _rng(seed, module_key, index, "title")
    if module_key == "customers":
        return customer_name(index, seed)
    if module_key == "contacts":
        first, last = person_name(index)
        return f"{first} {last}"
    if module_key == "quotes":
        customer = customer_name(_parent("customer_quotes", index, counts), seed)
        return f"{customer} — {QUOTE_OFFERS[rng.randrange(len(QUOTE_OFFERS))]}"
    if module_key == "sales_orders":
        customer = customer_name(_parent("customer_orders", index, counts), seed)
        items = ORDER_ITEMS[rng.randrange(len(ORDER_ITEMS))]
        return f"{customer} — {rng.randrange(4, 60)} {items}"
    if module_key == "customer_sites":
        return site_name(index, seed, counts)
    if module_key == "service_contracts":
        customer, label = _site_parts(_parent("site_contracts", index, counts), seed, counts)
        tier = CONTRACT_TIERS[index % len(CONTRACT_TIERS)]
        return f"{tier} service agreement — {customer}, {label}"
    if module_key == "service_requests":
        customer, label = _site_parts(_parent("site_requests", index, counts), seed, counts)
        # The unit named in the title is the one in the Equipment reference field.
        unit_name, _tag, type_index = _equipment(index % counts["equipment"])
        faults = EQUIPMENT_TYPES[type_index][2]
        return f"{unit_name} {faults[rng.randrange(len(faults))]} — {customer}, {label}"
    if module_key == "request_updates":
        request = reference_code(
            "service_requests", _parent("request_updates", index, counts), seed
        )
        return f"{request}: {_update_text(index, seed).split(';')[0].rstrip('.')}"
    if module_key == "equipment":
        return equipment_name(index)
    if module_key == "work_orders":
        unit = parent_indices("equipment_work_orders", index, counts)[0]
        unit_name, _tag, type_index = _equipment(unit)
        actions = EQUIPMENT_TYPES[type_index][3]
        number = reference_code("work_orders", index, seed)
        return f"{number}: {actions[rng.randrange(len(actions))]} on {unit_name}"
    if module_key == "inspections":
        work_order = reference_code(
            "work_orders", _parent("work_order_inspections", index, counts), seed
        )
        return f"{INSPECTION_TYPES[index % len(INSPECTION_TYPES)]} — {work_order}"
    if module_key == "maintenance_plans":
        cadence, task = MAINTENANCE_PLANS[index % len(MAINTENANCE_PLANS)]
        return f"{cadence} {task} — {equipment_name(_parent('equipment_plans', index, counts))}"
    if module_key == "products":
        return product_name(index, seed)
    if module_key == "warehouses":
        return warehouse_name(index, seed)
    if module_key == "stock_movements":
        product = product_name(_parent("product_movements", index, counts), seed)
        reason = MOVEMENT_REASONS[choice_label("stock_movements", "reason", index, seed)]
        receipt = reference_code("goods_receipts", index // 5, seed)
        return f"{reason} from {receipt}: {product}"
    if module_key == "stock_counts":
        warehouse = warehouse_name(_parent("warehouse_counts", index, counts), seed)
        slot = index // counts["warehouses"]
        aisle, bay = slot % 24 + 1, "ABCDE"[(slot // 24) % 5]
        return f"Cycle count — {warehouse}, aisle {aisle}{bay}"
    if module_key == "suppliers":
        return supplier_name(index)
    if module_key == "purchase_orders":
        supplier = supplier_name(_parent("supplier_orders", index, counts))
        return f"{reference_code('purchase_orders', index, seed)} — {supplier}"
    if module_key == "purchase_lines":
        product = product_name(index % counts["products"], seed)
        return f"{product} for {reference_code('purchase_orders', index // 2, seed)}"
    if module_key == "goods_receipts":
        order = _parent("purchase_order_receipts", index, counts)
        return f"Receipt for {reference_code('purchase_orders', order, seed)}"
    if module_key == "invoices":
        customer = customer_name(index % counts["customers"], seed)
        return f"{reference_code('invoices', index, seed)} — {customer}"
    if module_key == "payments":
        invoice = _parent("invoice_payments", index, counts)
        customer = customer_name(invoice % counts["customers"], seed)
        return f"Payment from {customer} for {reference_code('invoices', invoice, seed)}"
    if module_key == "expenses":
        return _expense_text(index, seed)
    if module_key == "credit_notes":
        invoice = _parent("invoice_credits", index, counts)
        return f"Credit on {reference_code('invoices', invoice, seed)}"
    raise ValueError(f"No title rule for {module_key}")


def _update_text(index: int, seed: int) -> str:
    rng = _rng(seed, "request_updates", index, "update")
    first, last = person_name(rng.randrange(600))
    return REQUEST_UPDATES[index % len(REQUEST_UPDATES)].format(
        day=WEEKDAYS[rng.randrange(len(WEEKDAYS))],
        hour=rng.choice((8, 9, 10, 11)),
        days=rng.randrange(2, 10),
        name=f"{first} {last}",
    )


def _expense_text(index: int, seed: int) -> str:
    category = choice_label("expenses", "category", index, seed)
    rng = _rng(seed, "expenses", index, "text")
    template = EXPENSES[category][rng.randrange(len(EXPENSES[category]))]
    return template.format(place=PLACES[rng.randrange(len(PLACES))])


@cache
def _notes() -> dict[tuple[str, str], tuple[str, ...]]:
    return {
        ("customer_sites", "address"): (
            "Lot {n} Blk {b}, {street}, {place}",
            "{n} {street}, Brgy. {b}, {place}",
            "Warehouse {b}, {street}, {place}",
        ),
        ("service_contracts", "coverage"): (
            "Quarterly preventive maintenance and 24-hour callout for refrigeration units.",
            "Parts and labor for forklifts and dock equipment; consumables billed separately.",
            "Monthly inspection, emergency response within {h} hours, spare unit on loan.",
            "Covers generator sets and pumps; response next business day.",
        ),
        ("request_updates", "update"): (),
        ("maintenance_plans", "procedure"): (
            "Check fluid levels, inspect hoses and belts, lubricate pivot points, log hours.",
            "Replace filters, check safety interlocks, record readings on the PMS sheet.",
            "Clean condenser coils, check refrigerant pressure, verify door seals.",
            "Inspect wiring, torque terminals, run on load for {h} minutes.",
        ),
        ("inspections", "findings"): (
            "All readings within limits. No action needed.",
            "Minor wear on {part}; replace at the next PMS.",
            "{part} needs replacement before the unit returns to service.",
            "Passed after adjustment; recheck in {h} days.",
        ),
        ("stock_counts", "count_notes"): (
            "Counted twice; variance traced to an unposted transfer.",
            "Two damaged cartons set aside for return to supplier.",
            "Bin labels replaced during the count.",
            "Count matches system after posting the pending receipt.",
        ),
        ("goods_receipts", "condition"): (
            "Delivered complete and in good condition.",
            "{n} cartons with crushed corners; contents checked and accepted.",
            "Short by {n} units; supplier notified for back-order.",
            "Pallet wrap torn but items intact.",
        ),
        ("expenses", "justification"): (
            "Needed to complete the scheduled site visit.",
            "Pre-approved by the department lead.",
            "Urgent purchase; supplier on the approved list was out of stock.",
            "Part of the monthly operations budget.",
        ),
        ("credit_notes", "reason"): (
            "{n} units returned damaged on delivery.",
            "Price adjustment agreed with the customer.",
            "Duplicate billing on the original invoice.",
            "Short delivery; customer billed for the full quantity.",
        ),
    }


_GENERAL_NOTES = {
    "customers": (
        "Prefers deliveries before 10 AM.",
        "Accounts payable closes on the 25th.",
        "Ask for {person} for site access.",
        "Requires official receipts per delivery.",
    ),
    "contacts": (
        "Best reached by mobile after 2 PM.",
        "Handles purchase approvals above ₱50,000.",
        "Prefers e-mail for quotations.",
        "Back-up contact for the {place} site.",
    ),
    "quotes": (
        "Price valid while stocks last.",
        "Includes delivery within Metro Manila.",
        "Customer asked for a volume discount.",
        "Revised after the site survey.",
    ),
    "sales_orders": (
        "Deliver to the loading bay at the back.",
        "Split delivery allowed.",
        "Customer PO attached by e-mail.",
        "Confirm schedule with {person}.",
    ),
    "service_requests": (
        "Reported by {person} from the facilities team.",
        "Customer says the problem started after a power interruption.",
        "Second report this month for the same unit.",
        "Site access only between {h}:00 and 17:00.",
        "Customer needs the unit back before the {day} delivery.",
    ),
    "work_orders": (
        "Bring spare {part}.",
        "Lock out the unit before starting.",
        "Coordinate with the site guard for gate pass.",
        "Two-person job.",
    ),
}
_FOLLOW_UPS = (
    "Called {person} on {day}.",
    "Next check on {day}.",
    "Photos sent to {person}.",
    "Logged by {person}.",
    "{person} to confirm by {day}.",
)
_PARTS = ("door gasket", "drive belt", "fuel filter", "contactor", "bearing", "seal kit")


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    """Long text a person would write; blank for about one in seven optional notes."""
    if module_key == "request_updates" and field_key == "update":
        return _update_text(index, seed)
    templates = _notes().get((module_key, field_key)) or _GENERAL_NOTES.get(module_key)
    if not templates:
        return ""
    rng = _rng(seed, module_key, index, field_key)
    first, last = person_name(rng.randrange(600))
    template = templates[rng.randrange(len(templates))]
    if field_key == "notes" and rng.random() < 0.6:
        template = f"{template} {_FOLLOW_UPS[rng.randrange(len(_FOLLOW_UPS))]}"
    place = site_place(index, seed) if field_key == "address" else None
    text = template.format(
        n=rng.randrange(2, 40),
        b=rng.randrange(1, 30),
        h=rng.choice((2, 4, 6, 8)),
        street=STREETS[rng.randrange(len(STREETS))],
        place=place or PLACES[rng.randrange(len(PLACES))],
        part=_PARTS[rng.randrange(len(_PARTS))],
        person=f"{first} {last}",
        day=WEEKDAYS[rng.randrange(len(WEEKDAYS))],
    )
    return text[:1].upper() + text[1:]


def email_value(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    """An address at the owning organization's reserved `.example` domain."""
    if module_key == "customers":
        box = ("accounts", "billing", "ap")[index % 3]
        return f"{box}@{customer_domain(index, seed)}"
    if module_key == "contacts":
        first, last = person_name(index)
        domain = customer_domain(_parent("customer_contacts", index, counts), seed)
        return f"{_slug(first)}.{_slug(last)}@{domain}"
    if module_key == "service_requests":
        site = _parent("site_requests", index, counts)
        return f"facilities@{customer_domain(site % counts['customers'], seed)}"
    if module_key == "inspections":
        member = TEAM_ROSTER["field"][index % len(TEAM_ROSTER["field"])]
        first, *rest = member.split()
        return f"{_slug(first)}.{_slug(rest[-1])}@{INTERNAL_DOMAIN}"
    if module_key == "warehouses":
        return f"{_slug(warehouse_name(index, seed))}@{INTERNAL_DOMAIN}"
    if module_key == "suppliers":
        return f"orders@{_company_domain(supplier_name(index))}"
    if module_key == "invoices":
        return email_value("customers", index % counts["customers"], seed, counts)
    raise ValueError(f"No e-mail rule for {module_key}")


def url_value(module_key: str, index: int, seed: int) -> str:
    if module_key == "customers":
        return f"https://www.{customer_domain(index, seed)}"
    if module_key == "customer_sites":
        return f"https://portal.{customer_domain(index, seed)}"
    if module_key == "equipment":
        maker = EQUIPMENT_MAKERS[index % len(EQUIPMENT_MAKERS)]
        return f"https://support.{_slug(maker)}.example/manuals/{_equipment(index)[1].lower()}"
    if module_key == "products":
        sku = str(reference_code("products", index, seed)).lower()
        return f"https://{INTERNAL_DOMAIN}/catalog/{sku}"
    if module_key == "suppliers":
        return f"https://www.{_company_domain(supplier_name(index))}"
    raise ValueError(f"No link rule for {module_key}")


def phone_value(index: int, seed: int) -> str:
    rng = _rng(seed, "phone", index)
    return f"+63 9{rng.randrange(15, 99)} {rng.randrange(100, 999)} {rng.randrange(1000, 9999)}"


def serial_value(index: int, seed: int) -> str:
    rng = _rng(seed, "serial", index)
    maker = EQUIPMENT_MAKERS[index % len(EQUIPMENT_MAKERS)][:2].upper()
    return f"{maker}{rng.randrange(10, 99)}-{rng.randrange(100_000, 999_999)}"
