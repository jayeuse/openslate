"""Reference numbers, record titles, contacts and notes as the plant writes them (§9)."""

from __future__ import annotations

import random
import re
from collections.abc import Callable, Mapping

from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer import plan_quality as quality
from operations.sample.packs.manufacturer import plan_sales as sales
from operations.sample.packs.manufacturer import plan_supply as supply
from operations.sample.packs.manufacturer import vocabulary as words

Counts = Mapping[str, int]
_CODES: dict[str, Callable[[int], str]] = {
    "customers": lambda index: f"C-{1_040 + index * 3}",
    "sales_orders": lambda index: f"SO-{4_817 + index:05d}",
    "products": lambda index: f"SKU-{20_100 + index * 7}",
    "boms": lambda index: f"BOM-{3_100 + index:04d}",
    "suppliers": lambda index: f"V{20_310 + index * 3}",
    "purchase_orders": lambda index: f"PO-{4_120 + index:05d}",
    "production_orders": lambda index: f"WO-{18_420 + index}",
    "material_lots": lambda index: f"R-{40_412 + index}",
    "shipments": lambda index: f"BOL-{62_190 + index}",
    "work_centers": lambda index: base.work_center(index)[0],
    "batch_records": lambda index: f"B-{28_900 + index}",
    "ncrs": lambda index: f"NCR-{137 + index:04d}",
    "capas": lambda index: f"CAPA-{21 + index:03d}",
    "maintenance_work_orders": lambda index: f"MWO-{3_412 + index:05d}",
    "customer_invoices": lambda index: f"INV-{30_418 + index}",
    "customer_payments": lambda index: f"RCPT-{88_200 + index * 3}",
}
_MATERIAL_PREFIX = {"Ingredient": "ING", "Packaging, primary": "PKG", "Packaging, secondary": "PKS",
                    "MRO": "MRO"}  # fmt: skip


def reference_code(module_key: str, index: int, _seed: int) -> str | None:
    if module_key == "materials":
        prefix = _MATERIAL_PREFIX[base.material_info(index)[1]]
        return f"{prefix}-{1_040 + index:04d}"
    rule = _CODES.get(module_key)
    return None if rule is None else rule(index)


def _code(module: str, index: int) -> str:
    return reference_code(module, index, 0) or ""


def _short(text: str) -> str:
    return text.split(",")[0]


def _customer_of(module: str, index: int, counts: Counts) -> str:
    if module == "sales_orders":
        return base.customer_name(base.customer_of_order(index, counts))
    if module == "shipments":
        slot = sales.shipment_slot(index, counts)
        order = slot[0] if slot else index % counts["sales_orders"]
        return base.customer_name(base.customer_of_order(order, counts))
    if module == "customer_payments":
        slot = sales.payment_slot(index, counts)
        invoice = slot[0] if slot else index % counts["customer_invoices"]
        return base.customer_name(sales.invoice_customer(invoice, counts))
    return base.customer_name(sales.invoice_customer(index, counts))


def record_title(module_key: str, index: int, seed: int, counts: Counts) -> str:
    del seed
    key = module_key
    named: dict[str, Callable[[int], str]] = {
        "customers": base.customer_name, "products": base.product_name,
        "suppliers": base.supplier_name, "work_centers": lambda item: base.work_center(item)[1],
    }  # fmt: skip
    if key in named:
        return named[key](index)
    if key == "materials":
        return base.material_info(index)[0]
    if key in {"sales_orders", "customer_invoices"}:
        return f"{_code(key, index)} {_customer_of(key, index, counts)}"
    if key == "sales_order_lines":
        order, number = sales.line_slot(index, counts)
        product = base.product_name(sales.line_product(index, counts))
        return f"{_code('sales_orders', order)} line {number}, {product}"
    if key == "boms":
        from operations.sample.packs.manufacturer.states import bom_product, bom_version

        product = base.product_line(bom_product(index, counts))[0]
        return f"{product} formula v{bom_version(index, counts)}"
    if key == "purchase_orders":
        material = _short(base.material_info(supply.po_material(index, counts))[0])
        supplier = base.supplier_name(supply.po_supplier(index, counts))
        return f"{_code(key, index)} {material}, {supplier}"
    if key == "production_orders":
        product = base.product_name(plant.wo_product(index, counts))
        line = base.work_center(plant.wo_line(index, counts))[0]
        trial = " (line trial)" if plant.wo_trial(index, counts) else ""
        return f"{_code(key, index)} {product} on {line}{trial}"
    if key == "material_lots":
        material = base.material_info(supply.lot_material(index, counts))[0]
        return f"{_code(key, index)} {_short(material)}"
    if key == "shipments":
        return f"{_code(key, index)} to {_customer_of(key, index, counts)}"
    if key == "batch_records":
        product = base.product_line(plant.batch_product(index, counts))[0]
        return f"{_code(key, index)} {product}"
    if key == "shift_reports":
        _day, center, shift = plant.report_slot(index, counts)
        return f"{base.work_center(center)[0]} shift {shift} production report"
    if key == "downtime_events":
        reason = words_reason(plant.downtime_reason(index))
        center = plant.report_slot(plant.downtime_report(index, counts), counts)[1]
        return f"{reason} on {base.work_center(center)[0]}"
    if key == "finished_goods_lots":
        slot = plant.finished_slot(index, counts)
        product = base.product_name(plant.wo_product(slot[0], counts)) if slot else "Mixed lot"
        return f"{product} from {_code('production_orders', slot[0]) if slot else 'rework'}"
    if key == "food_safety_logs":
        _day, center, check, shift = plant.log_slot(index, counts)
        where = base.work_center(center)[0]
        return f"{check.split(', ', 1)[1].capitalize()} check, {where} shift {shift}"
    if key == "ncrs":
        from operations.sample.packs.manufacturer.values import ncr_defect

        return f"{_code(key, index)} {ncr_defect(index, counts).split(',')[0]}"
    if key == "capas":
        from operations.sample.packs.manufacturer.values import capa_problem

        return f"{_code(key, index)} {capa_problem(index, counts)[0]}"
    if key == "equipment":
        _center, (name, _code_text, _model, _grade) = quality.equipment_slot(index, counts)
        return f"{quality.equipment_tag(index, counts)} {name}"
    if key == "maintenance_work_orders":
        from operations.sample.packs.manufacturer.values import mwo_task

        return f"{_code(key, index)} {_short(mwo_task(index, counts))}"
    if key == "supplier_invoices":
        po = supply.supplier_invoice_po(index, counts)
        supplier = base.supplier_name(supply.po_supplier(po, counts) if po is not None else index)
        return f"Invoice {supplier_invoice_no(index)} from {supplier}"
    if key == "customer_payments":
        from operations.sample.packs.manufacturer.values import payment_method

        return f"{payment_method(index)} payment from {_customer_of(key, index, counts)}"
    raise ValueError("Unknown sauce plant module")


def words_reason(reason: int) -> str:
    from operations.sample.packs.manufacturer.catalog_fields import REASON_CODES

    return REASON_CODES[reason].split(" ", 1)[1].capitalize()


def supplier_invoice_no(invoice: int) -> str:
    return f"{(invoice * 7_919 + 88_431) % 900_000 + 100_000}"


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower().replace(" and ", ""))


def email_value(module_key: str, index: int, seed: int, counts: Counts) -> str:
    del seed, counts
    if module_key == "customers":
        box = ("orders", "purchasing", "buyer", "replenishment")[index % 4]
        return f"{box}@{_slug(base.customer_name(index))}.example"
    box = ("sales", "orders", "customerservice", "info")[index % 4]
    return f"{box}@{_slug(_supplier_short(index))}.example"


def _supplier_short(supplier: int) -> str:
    name = base.supplier_name(supplier)
    return name.rsplit(" ", 1)[0] if name.endswith(words.SUPPLIER_SUFFIXES) else name


def url_value(module_key: str, index: int, seed: int) -> str:
    del module_key, seed
    page = ("products", "quality", "contact", "catalog")[index % 4]
    return f"https://www.{_slug(_supplier_short(index))}.example/{page}"


def phone_value(index: int, seed: int, module_key: str = "customers") -> str:
    rng = random.Random(f"{seed}:{module_key}:{index}:phone")
    area = words.AREA_CODES[(index * 3 + len(module_key)) % len(words.AREA_CODES)]
    return f"({area}) 555-01{rng.randrange(100):02d}"


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    """A short note in the plant's own words (research §9, how people phrase notes)."""
    del field_key
    pool = NOTES.get(module_key, NOTES["general"])
    return pool[random.Random(f"{seed}:{module_key}:{index}:note").randrange(len(pool))]


NOTES: dict[str, tuple[str, ...]] = {
    "general": ("Checked with the team, no issues.", "Updated after the morning tier meeting.",
                "Follow up on Thursday.", "Reviewed with the supervisor."),
    "customers": ("Ships to the DC only, appointment required.", "Wants ASN 24 hours before.",
                  "Pallet height 60 inches max.", "Pays by ACH on the 15th.",
                  "New buyer since spring, see email.", "Uses its own item codes on the PO."),
    "sales_orders": ("Short 40 cases, backorder to Thursday.", "Customer moved the ship date.",
                     "Confirmed by phone with the buyer.", "Promo order for the spring ad.",
                     "Hold until credit clears.", "Ship complete, no partials."),
    "materials": ("Second source approved last year.", "Keep two totes on hand in peak season.",
                  "Allergen: store on the bottom rack.", "Lead time longer in Q3.",
                  "Order with the glass to fill the truck."),
    "suppliers": ("Scorecard reviewed last quarter.", "COA comes with every load.",
                  "Audit report on file, SQF certificate current.", "Late twice this quarter.",
                  "Minimum order is one truckload."),
    "purchase_orders": ("Waiting on paste tote, receiving says truck at door 3.",
                        "Confirmed by email.", "Supplier asked to split the delivery.",
                        "Price per the annual contract.", "Expedite, line needs it Monday."),
    "production_orders": ("Allergen SKU, run last before the full wash.", "Rush for a key account.",
                          "Frozen for this week.", "Labels arrived, ready to release.",
                          "Run after the L2 changeover."),
    "work_centers": ("CIP every 24 hours.", "Allergen wash before mustard runs.",
                     "Speed limited on 1 gal jugs."),
    "equipment": ("PM every 500 hours.", "Spare parts in the MRO cage.", "Vendor service yearly.",
                  "Guard replaced last month."),
    "shipments": ("Driver arrived late, loaded in 40 minutes.", "Seal checked at the dock.",
                  "Trailer pre-cooled, temperature OK.", "Customer pickup at door 2."),
    "customer_invoices": ("Sent by EDI.", "Customer asked for a copy of the BOL.",
                          "Deduction for the spring promotion.", "Emailed to accounts payable."),
    "customer_payments": ("Remittance by email.", "Lockbox deposit.", "Short paid, see deduction.",
                          "Applied to the oldest invoice."),
    "supplier_invoices": ("Matched to the receipt.", "Freight billed separately.",
                          "Price differs from the PO, asked the buyer.",
                          "Approved for Friday run."),
    "capas": ("Owner updated the action plan.", "Effectiveness check booked.",
              "Training records attached."),
}  # fmt: skip
