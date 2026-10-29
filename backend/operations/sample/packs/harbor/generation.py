"""Harbor-specific field values and operational relationships."""

from __future__ import annotations

import random
from datetime import date

from operations.sample.actors import assignee_key
from operations.sample.blueprint import _option_id
from operations.sample.packs.harbor.catalog import SPECIAL_STATUSES
from operations.sample.packs.harbor.dates import activity_date, related_datetime
from operations.sample.packs.harbor.links import (
    invoice_payment_index as _invoice_payment_index,
)
from operations.sample.packs.harbor.links import (
    payment_invoice_index as _payment_invoice_index,
)
from operations.sample.packs.harbor.links import (
    receipt_order_index as _receipt_order_index,
)
from operations.sample.packs.harbor.realism import (
    AMOUNT_SHAPES,
    DEFAULT_AMOUNT,
    INVOICE_TOTAL,
    INVOICED_ORDER_WEIGHTS,
    PRODUCT_PRICE,
    STATUS_WEIGHTS,
)
from operations.sample.packs.harbor.text import (
    email_value,
    note_text,
    phone_value,
    record_title,
    reference_code,
    serial_value,
    url_value,
)
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import OMIT as _OMIT
from operations.sample.packs.types import FieldSpec, JsonValue, ModuleSpec
from operations.sample.realism import (
    DIRT,
    dirty_text,
    dirty_value,
    long_tail_amount,
    ordered_skew,
    weighted_label,
)

# Records below this index carry named business cases; the realism rules leave them alone.
PINNED = 10


# The service request that exercises the "Start urgent requests" rule (Open and Urgent).
URGENT_REQUEST = 2


def _product_price(index: int) -> int:
    return int(long_tail_amount(random.Random(f"harbor:product_price:{index}"), PRODUCT_PRICE))


def _ordered_quantities(order_index: int) -> tuple[int, int]:
    if order_index == 0:
        return 20, 10
    return 10 + (order_index * 5) % 11, 10 + (order_index * 5 + 3) % 11


def _accepted_quantities(order_index: int) -> tuple[int, int]:
    first, second = _ordered_quantities(order_index)
    if order_index == 2:
        return 0, 0
    if order_index == 1:
        return first, second - 3
    if order_index == 3:
        return first - 1, second
    if order_index > 0 and order_index % 17 == 0:
        return first - 1, second
    return first, second


def _receipt_quantities(receipt_index: int) -> tuple[int, int]:
    order_index = _receipt_order_index(receipt_index)
    quantities = _accepted_quantities(order_index)
    if order_index == 0 and receipt_index in {0, 2}:
        if receipt_index == 0:
            return quantities[0] // 2, quantities[1] // 2
        return quantities[0] - quantities[0] // 2, quantities[1] - quantities[1] // 2
    return quantities


def _purchase_price(order_index: int, line_index: int, product_count: int) -> int:
    return _product_price((order_index * 2 + line_index) % product_count)


def _purchase_total(order_index: int, product_count: int) -> int:
    quantities = _ordered_quantities(order_index)
    return sum(
        quantities[line] * _purchase_price(order_index, line, product_count) for line in (0, 1)
    )


def _invoice_total(index: int) -> int:
    if index == 0:
        return 12_000
    if index < PINNED:  # Named invoice cases and the threshold trigger use these totals.
        return 1_000 + (index * 137) % 10_000
    return int(long_tail_amount(random.Random(f"harbor:invoice_total:{index}"), INVOICE_TOTAL))


def _payment_amount(payment_index: int, counts: dict[str, int]) -> int:
    invoice_total = _invoice_total(_payment_invoice_index(payment_index))
    if payment_index == 0:
        return 4_500
    if payment_index < PINNED:  # Named payment cases (for example invoice 8 overdue).
        return invoice_total if payment_index % 4 == 1 else max(1, invoice_total // 2)
    # Most customers pay in full; every fifth payment covers half the invoice.
    return invoice_total if payment_index % 5 else max(1, invoice_total // 2)


def _invoice_due_date(index: int, seed: int, anchor: date, counts: dict[str, int]) -> date:
    return activity_date("invoices", index, seed, anchor, counts)


def _purchase_order_status(index: int) -> str:
    if index == 1:
        return "Delayed"
    if index == 2:
        return "Cancelled"
    if _accepted_quantities(index) != _ordered_quantities(index):
        return "Partially received"
    return "Received"


def _line_status(index: int) -> str:
    order_index, line_index = divmod(index, 2)
    if order_index == 2:
        return "Cancelled"
    accepted = _accepted_quantities(order_index)[line_index]
    ordered = _ordered_quantities(order_index)[line_index]
    return "Received" if accepted == ordered else "Partially received"


def _status_label(
    module: ModuleSpec, index: int, seed: int, counts: dict[str, int], anchor: date
) -> str:
    if module.key == "sales_orders" and index < counts["invoices"]:
        if index == 2:
            return "Cancelled"
        if index == 0:
            return "Partially fulfilled"
        return weighted_label(_status_rng(module, index, seed), INVOICED_ORDER_WEIGHTS)
    special = SPECIAL_STATUSES.get(module.key, {}).get(index)
    if special is not None:
        return special
    if (module.key, index) == ("service_requests", URGENT_REQUEST):
        return "Open"
    if module.key == "purchase_orders":
        return _purchase_order_status(index)
    if module.key == "purchase_lines":
        return _line_status(index)
    if module.key == "goods_receipts":
        return "Partial" if index in {0, 1, 3} else "Accepted"
    if module.key == "payments":
        return "Posted"
    if module.key == "credit_notes":
        return "Cancelled" if index == 2 else "Draft"
    if module.key == "invoices":
        if index == 2:
            return "Cancelled"
        payment_index = _invoice_payment_index(index, counts)
        if payment_index is not None and _payment_amount(payment_index, counts) >= _invoice_total(
            index
        ):
            return "Paid"
        if payment_index is not None and index >= PINNED:
            return "Partially paid"
        if _invoice_due_date(index, seed, anchor, counts) < anchor:
            return "Overdue"
        if payment_index is not None:
            return "Partially paid"
        return "Disputed" if index == 601 else "Issued"
    weights = STATUS_WEIGHTS.get(module.key)
    if weights is None:
        return module.statuses[(index + seed) % len(module.statuses)]
    return weighted_label(_status_rng(module, index, seed), weights)


def _status_rng(module: ModuleSpec, index: int, seed: int) -> random.Random:
    return random.Random(f"{seed}:{module.key}:{index}:status")


def _clean_field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: dict[str, int],
) -> JsonValue | object:
    rng = random.Random(f"{seed}:{module.key}:{index}:{field.key}")
    if field.value_kind == "title":
        return record_title(module.key, index, seed, counts)
    if field.value_kind == "reference":
        if field.key == "serial":
            return serial_value(index, seed)
        code = reference_code(module.key, index, seed)
        return _OMIT if code is None else code
    if field.value_kind == "status":
        label = _status_label(module, index, seed, counts, anchor)
        if field.has_default and label == field.default_value and index % 5 == 0:
            return _OMIT
        return _option_id(seed, module.key, field.key, label, organization)
    if field.value_kind == "choice":
        label = weighted_label(rng, ordered_skew(field.options))
        if (module.key, field.key, index) == ("service_requests", "priority", URGENT_REQUEST):
            # The "Start urgent requests" rule needs one Open, Urgent request in every seed.
            label = "Urgent"
        return _option_id(seed, module.key, field.key, label, organization)
    if field.value_kind == "owner":
        return f"@user:{assignee_key(module.key, module.department, index, seed, organization)}"
    if field.value_kind == "notes":
        if index % 7 == 0 and not field.required:
            return ""
        return note_text(module.key, field.key, index, seed)
    if field.value_kind == "email":
        if index % 9 == 0 and not field.required:
            return ""
        return email_value(module.key, index, seed, counts)
    if field.value_kind == "phone":
        return phone_value(index, seed)
    if field.value_kind == "url":
        return "" if index % 5 == 0 else url_value(module.key, index, seed)
    if field.value_kind == "date":
        return activity_date(module.key, index, seed, anchor, counts).isoformat()
    if field.value_kind in {"datetime", "receipt_datetime"}:
        return related_datetime(module.key, field.key, index, seed, anchor, counts)
    if field.value_kind in {
        "amount",
        "number",
        "invoice_total",
        "payment_amount",
        "expense_amount",
        "credit_amount",
    }:
        if field.value_kind == "invoice_total":
            return _invoice_total(index)
        if field.value_kind == "payment_amount":
            return _payment_amount(index, counts)
        if field.value_kind == "expense_amount" and index % 17 == 0:
            return 0
        if module.key == "sales_orders" and field.key == "total" and index < counts["invoices"]:
            return _invoice_total(index)
        if module.key == "purchase_orders":
            return _purchase_total(index, counts["products"])
        if module.key == "purchase_lines" and field.key == "unit_price":
            return _purchase_price(index // 2, index % 2, counts["products"])
        if module.key == "purchase_lines" and field.key == "line_total":
            return _ordered_quantities(index // 2)[index % 2] * _purchase_price(
                index // 2, index % 2, counts["products"]
            )
        if field.key == "credit_limit" and index % 13 == 0:
            return 0
        if field.key == "score" or field.key == "risk_score":
            return 65 + (index * 7) % 36
        if field.key == "latitude":
            return 14.5 + (index % 100) / 100
        if field.key == "labor_hours":
            return 0 if index % 23 == 0 else 1 + (index % 24)
        shape = AMOUNT_SHAPES.get((module.key, field.key), DEFAULT_AMOUNT)
        return long_tail_amount(rng, shape)
    if field.value_kind in {"integer", "variance"}:
        if field.key == "quantity":
            return (
                _ordered_quantities(index // 2)[index % 2]
                if module.key == "purchase_lines"
                else 1 + index % 90
            )
        if field.key == "minutes":
            return 0 if index % 19 == 0 else 15 + (index * 7) % 180
        if field.key == "variance":
            return 0 if index % 5 == 0 else (-1 if index % 2 else 1) * (1 + index % 12)
        if field.key == "interval_days":
            return 7 + (index % 12) * 7
        if field.key == "terms_days":
            return (15, 30, 45, 60)[index % 4]
        if field.key == "capacity":
            return 400 + index * 125
        if field.key == "reorder_point":
            return 0 if index % 6 == 0 else 5 + index % 45
        return 0 if index % 17 == 0 else 1 + index % 50
    if field.value_kind == "ordered_quantity":
        return _ordered_quantities(index // 2)[index % 2]
    if field.value_kind == "accepted_quantity":
        return sum(_receipt_quantities(index))
    if field.value_kind == "purchase_total":
        return _purchase_total(index, counts["products"])
    if field.value_kind == "purchase_unit_price":
        return _purchase_price(index // 2, index % 2, counts["products"])
    if field.value_kind == "line_total":
        return _ordered_quantities(index // 2)[index % 2] * _purchase_price(
            index // 2, index % 2, counts["products"]
        )
    if field.value_kind == "movement_quantity":
        receipt_index, movement_index = divmod(index, 5)
        order_index = _receipt_order_index(receipt_index)
        line_index, piece_index = (
            (0, movement_index) if movement_index < 3 else (1, movement_index - 3)
        )
        quantity = _receipt_quantities(receipt_index)[line_index]
        pieces = 3 if line_index == 0 else 2
        return quantity // pieces + (1 if piece_index < quantity % pieces else 0)
    if field.value_kind == "movement_cost":
        receipt_index, movement_index = divmod(index, 5)
        order_index = _receipt_order_index(receipt_index)
        return _purchase_price(order_index, 0 if movement_index < 3 else 1, counts["products"])
    if field.value_kind == "boolean":
        if field.has_default and index % 4 == 0:
            return _OMIT
        if field.key in {"active", "enabled"}:
            return index % 5 != 1
        if module.key == "quotes" and field.key == "accepted":
            return _status_label(module, index, seed, counts, anchor) == "Accepted"
        if module.key == "payments" and field.key == "posted":
            return True
        if module.key == "sales_orders" and field.key == "fulfilled":
            return _status_label(module, index, seed, counts, anchor) == "Complete"
        if field.key == "fulfilled":
            return index % 4 == 0
        return index % 3 == 0
    return _OMIT


def _field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: dict[str, int],
) -> JsonValue | object:
    """The value as people type it (spec R6, R7); pinned records stay exact."""
    value = _clean_field_value(organization, module, field, index, seed, anchor, counts)
    if index < PINNED or value is _OMIT or field.value_kind not in _DIRTY_KINDS:
        return value
    kind = field.value_kind
    previous = index - 1 >= PINNED
    redone = _RECREATED.get(module.key)
    if kind == "title" and previous and redone is not None:
        # Refused or cancelled, then entered again: the new record repeats the old title.
        if _status_label(module, index - 1, seed, counts, anchor) == redone:
            return _clean_field_value(organization, module, field, index - 1, seed, anchor, counts)
    if kind == "title" and module.key in _NEAR_DUPLICATE_MODULES and index >= 2 * PINNED:
        rng = random.Random(f"{seed}:{module.key}:{index}:near-duplicate")
        if rng.random() < 0.02:
            other = _clean_field_value(organization, module, field, index - 7, seed, anchor, counts)
            if isinstance(other, str):
                return dirty_text(rng, other)
    note = (_clean_field_value(organization, module, field, index - 1, seed, anchor, counts)
            if kind == "notes" and previous else None)  # fmt: skip
    return dirty_value(
        random.Random(f"{seed}:{module.key}:{index}:{field.key}:dirt"),
        kind,
        value,
        required=field.required,
        country_code="63",
        quick_entry=random.Random(f"{seed}:{module.key}:{index}:quick").random() < DIRT.quick_entry,
        previous_note=note if isinstance(note, str) else None,
    )


# A record entered again after this status; its title names no linked parent.
_RECREATED = {"expenses": "Rejected"}
_DIRTY_KINDS = frozenset({"title", "notes", "phone", "email", "url"})
# Named things where a second, slightly different entry for the same company appears.
_NEAR_DUPLICATE_MODULES = frozenset({"customers", "suppliers"})
