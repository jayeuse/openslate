"""Natural distributor record text and reserved-domain identifiers (Philippines)."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.packs.fmcg_distributor import (
    ledger,
    lines,
    links,
    links_claims,
    links_finance,
)
from operations.sample.packs.fmcg_distributor import vocabulary as words
from operations.sample.packs.fmcg_distributor.catalog_fields import WEEKDAYS
from operations.sample.packs.fmcg_distributor.links import rng

_CODES = {
    "store_visits": ("VIS-", 60_211, 6), "sales_orders": ("SO-", 4_512, 6),
    "trade_promotions": ("SCH-", 1_207, 4), "purchase_orders": ("PO-", 2_611, 5),
    "goods_receipts": ("GRN-", 881, 5), "stock_counts": ("SC-", 1_402, 5),
    "stock_adjustments": ("ADJ-", 140, 5), "returns": ("BO-", 2_310, 5),
    "delivery_trips": ("TRIP-", 712, 5), "sales_invoices": ("SI-", 18_844, 6),
    "collection_receipts": ("CR-", 9_310, 6), "principal_claims": ("CLM-", 404, 5),
}  # fmt: skip
_ROUTE_PREFIX = {"Pre-sell": "PS", "Van sales": "VS", "Key account": "KA"}


def reference_code(module_key: str, index: int, _seed: int) -> str | None:
    if module_key in _CODES:
        prefix, start, width = _CODES[module_key]
        return f"{prefix}{start + index:0{width}d}"
    if module_key == "outlets":
        return f"OUT-V{index % 4 + 1}-{1_200 + index * 7:05d}"
    if module_key == "beats":
        route = links.beat_route(index)
        number = sum(links.beat_route(item) == route for item in range(index)) + 1
        return f"{_ROUTE_PREFIX[route]}{number:02d}-{WEEKDAYS[index % 6][:3].upper()}"
    if module_key == "route_tours":
        return f"TOUR-VS{index % 3 + 1:02d}-{index + 31:04d}"
    if module_key == "principals":
        return principal(index)[1]
    if module_key == "products":
        return f"SKU-{100_031 + index * 13:06d}"
    return None


def principal(index: int) -> tuple[str, str, str, str, str]:
    """Name, code, category, GS1 prefix and terms; later regions repeat the twelve principals."""
    name, code, category, prefix, terms = words.PRINCIPALS[index % len(words.PRINCIPALS)]
    cycle = index // len(words.PRINCIPALS)
    if not cycle:
        return name, code, category, prefix, terms
    region = words.REGIONS[(cycle - 1) % len(words.REGIONS)]
    return f"{name} — {region}", f"{code}{cycle + 1}", category, prefix, terms


def outlet_name(outlet: int) -> str:
    channel = links.outlet_channel(outlet)
    barangay = words.BARANGAYS[(outlet * 5 + 3) % len(words.BARANGAYS)]
    if channel == "Supermarket (modern trade)":
        branch = words.SUPERMARKETS[outlet % len(words.SUPERMARKETS)]
        return f"{branch} — {barangay} branch"
    owner = words.OUTLET_OWNERS[(outlet * 7) % len(words.OUTLET_OWNERS)]
    kinds = words.STORE_WORDS[channel]
    kind = kinds[(outlet // len(words.OUTLET_OWNERS)) % len(kinds)]
    return f"{owner} {kind} (Brgy. {barangay})"


def product_name(index: int, _seed: int = 0, counts: Mapping[str, int] | None = None) -> str:
    sized = counts or {"principals": 12, "products": 300}
    brand, item, per_case, _life, _abc = ledger.product_sku(index, sized)
    return f"{brand} {item} x{per_case}"


def plate(vehicle: int) -> str:
    letters = words.VEHICLE_LETTERS[vehicle % len(words.VEHICLE_LETTERS)]
    return f"{letters} {4_821 + vehicle * 377 % 5_000:04d}"


def vehicle_name(vehicle: int, counts: Mapping[str, int]) -> str:
    return f"{links.vehicle_type(vehicle, counts)} {plate(vehicle)}"


def lot_number(lot: int) -> str:
    draw = rng("lot", lot)
    letter, month = draw.choice("KLMNPRST"), draw.choice("ABCDEFGH")
    return f"{letter}{26 - lot % 2}{month}{draw.randint(1_000, 9_999)}"


def _code(module_key: str, index: int) -> str:
    return reference_code(module_key, index, 0) or ""


def record_title(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    """Titles a distributor's staff would type; linked names follow the same link rules."""
    del seed
    if module_key == "outlets":
        return outlet_name(index)
    if module_key == "beats":
        territory = words.TERRITORIES[index % len(words.TERRITORIES)]
        return f"{_code(module_key, index)} — {territory}"
    if module_key == "store_visits":
        return f"{outlet_name(links.visit_outlet(index, counts))} — {_code(module_key, index)}"
    if module_key == "sales_orders":
        return f"{_code(module_key, index)} — {outlet_name(links.order_outlet(index, counts))}"
    if module_key == "order_lines":
        order = lines.line_order(index, counts)
        product = product_name(lines.line_product(index, counts), counts=counts)
        return f"{_code('sales_orders', order)} — {product}"
    if module_key == "route_tours":
        return f"{_code(module_key, index)} — {plate(links.tour_vehicle(index, counts))}"
    if module_key == "trade_promotions":
        name = principal(links_claims.promotion_principal(index, counts))[0]
        return f"{_code(module_key, index)} — {name} {links_claims.scheme_type(index).lower()}"
    if module_key == "principals":
        return principal(index)[0]
    if module_key == "products":
        return product_name(index, counts=counts)
    if module_key == "purchase_orders":
        name = principal(lines.po_principal(index, counts))[0]
        return f"{_code(module_key, index)} — {name}"
    if module_key == "po_lines":
        po = lines.po_line_po(index, counts)
        product = product_name(lines.po_line_product(index, counts), counts=counts)
        return f"{_code('purchase_orders', po)} — {product}"
    if module_key == "goods_receipts":
        name = principal(lines.po_principal(lines.receipt_po(index, counts), counts))[0]
        return f"{_code(module_key, index)} — {name}"
    if module_key == "stock_lots":
        product = product_name(lines.lot_product(index, counts), counts=counts)
        return f"{product} — lot {lot_number(index)}"
    if module_key == "stock_counts":
        product = product_name(lines.count_product(index, counts), counts=counts)
        return f"{_code(module_key, index)} — {product}"
    if module_key == "stock_adjustments":
        lot = lines.adjustment_lot(index, counts)
        return f"{_code(module_key, index)} — lot {lot_number(lot)}"
    if module_key == "returns":
        outlet = links_claims.return_outlet(index, counts)
        return f"{_code(module_key, index)} — {outlet_name(outlet)}"
    if module_key == "delivery_trips":
        return f"{_code(module_key, index)} — {plate(links.trip_vehicle(index, counts))}"
    if module_key == "vehicles":
        return vehicle_name(index, counts)
    if module_key == "sales_invoices":
        outlet = links_finance.invoice(index, counts).outlet
        return f"{_code(module_key, index)} — {outlet_name(outlet)}"
    if module_key == "collection_receipts":
        members = links_finance.receipt(index, counts).invoices
        payer = outlet_name(links_finance.invoice(members[0], counts).outlet)
        return f"{_code(module_key, index)} — {payer}"
    if module_key == "credit_reviews":
        outlet = links_claims.review_outlet(index, counts)
        return f"{links_claims.review_type(index, counts)} — {outlet_name(outlet)}"
    if module_key == "collection_followups":
        target = links_finance.followup_invoice(index, counts)
        return f"Follow-up on {_code('sales_invoices', target)}"
    if module_key == "principal_invoices":
        po = links_claims.ap_invoice_po(index, counts)
        name = principal(lines.po_principal(po, counts))[0]
        return f"{name} — invoice {principal_invoice_no(index)}"
    if module_key == "principal_claims":
        kind = links_claims.claim_type(index)
        return f"{_code(module_key, index)} — {kind}"
    return f"Distributor record {index + 1:04d}"


def principal_invoice_no(index: int) -> str:
    return f"{88_120 + index * 17:06d}"


# Share of records that people leave without a note.
_BLANK = {"order_lines": 0.85, "po_lines": 0.85, "sales_invoices": 0.7,
          "collection_receipts": 0.6, "store_visits": 0.4, "principal_invoices": 0.5}


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    draw = rng(seed, module_key, field_key, index, "note")
    if module_key == "sales_invoices" and index == 0:
        return "Paid ₱10,000 by cheque; balance ₱14,600 due on the next visit."
    if module_key == "collection_receipts" and index == 0:
        return "Cheque for part of SI-018844; the balance is due on the next visit."
    if draw.random() < _BLANK.get(module_key, 0.0):
        return ""
    pools = {
        "outlets": words.OUTLET_NOTES, "beats": words.SALES_NOTES,
        "store_visits": words.SALES_NOTES, "sales_orders": words.ORDER_NOTES,
        "order_lines": words.ORDER_NOTES, "route_tours": words.TOUR_NOTES,
        "trade_promotions": words.ACCOUNTING_NOTES, "principals": words.PURCHASING_NOTES,
        "products": words.PURCHASING_NOTES, "purchase_orders": words.PURCHASING_NOTES,
        "po_lines": words.PURCHASING_NOTES, "goods_receipts": words.GRN_NOTES,
        "stock_lots": words.LOT_NOTES, "stock_counts": words.COUNT_NOTES,
        "stock_adjustments": words.COUNT_NOTES, "returns": words.RETURN_NOTES,
        "delivery_trips": words.LOGISTICS_NOTES, "vehicles": words.LOGISTICS_NOTES,
        "sales_invoices": words.CREDIT_NOTES, "collection_receipts": words.CREDIT_NOTES,
        "credit_reviews": words.CREDIT_NOTES, "collection_followups": words.FOLLOWUP_NOTES,
        "principal_invoices": words.ACCOUNTING_NOTES, "principal_claims": words.ACCOUNTING_NOTES,
    }  # fmt: skip
    pool = pools[module_key]
    return pool[draw.randrange(len(pool))]


def contact_name(outlet: int) -> str:
    return words.CONTACT_NAMES[(outlet * 11 + 5) % len(words.CONTACT_NAMES)]


def address(outlet: int) -> str:
    street = words.STREETS[(outlet * 3) % len(words.STREETS)]
    barangay = words.BARANGAYS[(outlet * 5 + 3) % len(words.BARANGAYS)]
    city = words.CITIES[(outlet * 5 + 3) % len(words.CITIES)]
    return f"{outlet % 240 + 12} {street}, Brgy. {barangay}, {city}"


def phone_value(index: int, seed: int) -> str:
    """Philippine mobile numbers, 09XX XXX XXXX, in the reserved-looking 0917 555 range."""
    network = ("0917", "0918", "0927", "0998", "0905", "0939")[(index + seed) % 6]
    return f"{network} 555 {(index * 37 + seed) % 10_000:04d}"


def email_value(module_key: str, index: int, _seed: int, _counts: Mapping[str, int]) -> str:
    code = principal(index)[1]
    if module_key == "principals":
        return f"orders@{code.lower()}-trade.example"
    return f"accounts@{code.lower()}-trade.example"


def url_value(module_key: str, index: int, _seed: int) -> str:
    del module_key
    return f"https://portal.{principal(index)[1].lower()}-trade.example/orders"


def serial_value(index: int, _seed: int) -> str:
    return f"CHS-{7_210_455 + index * 311:09d}"


def customer_name(index: int, _seed: int) -> str:
    return outlet_name(index)


def supplier_name(index: int) -> str:
    return principal(index)[0]


def equipment_name(index: int) -> str:
    return vehicle_name(index, {"vehicles": 16})


def warehouse_name(index: int, _seed: int) -> str:
    return ("Main warehouse, Valenzuela", "Satellite depot, Marikina", "BO cage",
            "Cold room")[index % 4]  # fmt: skip


def site_place(index: int, _seed: int) -> str:
    return words.CITIES[index % len(words.CITIES)]


def site_name(index: int, seed: int, _counts: Mapping[str, int]) -> str:
    return f"{site_place(index, seed)} route area"


def gtin_each(product: int, counts: Mapping[str, int]) -> str:
    prefix = principal(links.product_principal(product, counts))[3]
    body = f"{prefix}{product % 100_000:05d}"
    return body + _check_digit(body)


def gtin_case(product: int, counts: Mapping[str, int]) -> str:
    body = "1" + gtin_each(product, counts)[:-1]
    return body + _check_digit(body)


def _check_digit(body: str) -> str:
    total = sum(int(digit) * (3 if position % 2 == 0 else 1)
                for position, digit in enumerate(reversed(body)))  # fmt: skip
    return str((10 - total % 10) % 10)
