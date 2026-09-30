"""Generate Harbor records, links, and the public sample dataset interface."""

from __future__ import annotations

import random
from datetime import date
from typing import cast

from operations.sample_actors import assignee_key, creator_keys
from operations.sample_blueprint import (
    NamedScenario,
    SampleDataset,
    SampleEdge,
    SampleRecord,
    _build_document,
    _build_test_vectors,
    _option_id,
)
from operations.sample_blueprint import SampleTestVector as SampleTestVector
from operations.sample_blueprint import build_document as build_document
from operations.sample_catalog import (
    _MODULES,
    _OMIT,
    _RELATIONSHIPS,
    _SPECIAL_STATUSES,
    FieldSpec,
    JsonValue,
    ModuleSpec,
    SampleProfile,
    _anchor,
    _doc_id,
    module_counts,
)
from operations.sample_dates import activity_date, related_datetime
from operations.sample_links import invoice_payment_index as _invoice_payment_index
from operations.sample_links import parent_indices
from operations.sample_links import payment_invoice_index as _payment_invoice_index
from operations.sample_links import receipt_order_index as _receipt_order_index
from operations.sample_references import sample_reference_value
from operations.sample_text import (
    email_value,
    note_text,
    phone_value,
    record_title,
    reference_code,
    serial_value,
    url_value,
)


def _record_id(module_key: str, index: int) -> str:
    return f"{module_key}:{index + 1:06d}"


def _product_price(index: int) -> int:
    return 40 + (index * 17) % 160


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
    return 12_000 if index == 0 else 1_000 + (index * 137) % 10_000


def _payment_amount(payment_index: int, counts: dict[str, int]) -> int:
    invoice_total = _invoice_total(_payment_invoice_index(payment_index))
    if payment_index == 0:
        return 4_500
    return invoice_total if payment_index % 4 == 1 else max(1, invoice_total // 2)


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
        active_statuses = tuple(status for status in module.statuses if status != "Cancelled")
        return active_statuses[(index + seed) % len(active_statuses)]
    special = _SPECIAL_STATUSES.get(module.key, {}).get(index)
    if special is not None:
        return special
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
        if _invoice_due_date(index, seed, anchor, counts) < anchor:
            return "Overdue"
        if payment_index is not None:
            return "Partially paid"
        return "Disputed" if index == 601 else "Issued"
    return module.statuses[(index + seed) % len(module.statuses)]


def _field_value(
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
    if field.value_kind == "sample_reference":
        return sample_reference_value(module.key, field.key, index, counts, seed)
    if field.value_kind == "status":
        label = _status_label(module, index, seed, counts, anchor)
        if field.has_default and label == field.default_value and index % 5 == 0:
            return _OMIT
        return _option_id(seed, module.key, field.key, label)
    if field.value_kind == "choice":
        return _option_id(
            seed, module.key, field.key, field.options[(index + seed) % len(field.options)]
        )
    if field.value_kind == "owner":
        return f"@user:{assignee_key(module.key, module.department, index, seed)}"
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
        if field.key == "annual_value":
            return 1_200 + rng.randrange(0, 30_000, 100)
        if field.key == "score" or field.key == "risk_score":
            return 65 + (index * 7) % 36
        if field.key == "latitude":
            return 14.5 + (index % 100) / 100
        if field.key == "labor_hours":
            return 0 if index % 23 == 0 else 1 + (index % 24)
        return 500 + rng.randrange(0, 9_000, 25)
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


def _build_records(
    seed: int,
    anchor: date,
    counts: dict[str, int],
) -> tuple[SampleRecord, ...]:
    records: list[SampleRecord] = []
    for module in _MODULES:
        creators = creator_keys(module.key, module.department, counts[module.key], seed)
        for index in range(counts[module.key]):
            data: dict[str, JsonValue] = {}
            for field in module.fields:
                value = _field_value(module, field, index, seed, anchor, counts)
                if value is not _OMIT:
                    data[_doc_id(seed, "field", f"{module.key}:{field.key}")] = cast(
                        JsonValue, value
                    )
            records.append(
                SampleRecord(
                    _record_id(module.key, index),
                    module.key,
                    module.department,
                    data,
                    creator_key=creators[index],
                    assignee_key=assignee_key(module.key, module.department, index, seed),
                )
            )
    return tuple(records)


def _edges(counts: dict[str, int], relationship_ids: dict[str, str]) -> tuple[SampleEdge, ...]:
    output: list[SampleEdge] = []
    for spec in _RELATIONSHIPS:
        for target in range(counts[spec.target]):
            for source in parent_indices(spec.key, target, counts):
                output.append(
                    SampleEdge(
                        relationship_ids[spec.key],
                        _record_id(spec.source, source),
                        _record_id(spec.target, target),
                    )
                )
    return tuple(output)


def build_dataset(
    profile: SampleProfile = "small",
    seed: int = 42,
    anchor_date: date | None = None,
) -> SampleDataset:
    """Build the design, logical records, linked business data, and expected scenarios."""
    counts = module_counts(profile)
    anchor = _anchor(anchor_date)
    document, maps = _build_document(seed, anchor)
    department_ids = cast(dict[str, str], maps["department_ids"])
    module_ids = cast(dict[str, str], maps["module_ids"])
    field_ids = cast(dict[str, dict[str, str]], maps["field_ids"])
    relationship_ids = cast(dict[str, str], maps["relationship_ids"])
    records = _build_records(seed, anchor, counts)
    trigger_ids = {
        key: _doc_id(seed, "trigger", key)
        for key in (
            "order-created-confirmation",
            "urgent-request-created",
            "quote-value-changed",
            "work-order-state-changed",
            "large-invoice-threshold",
            "large-movement-threshold",
            "daily-stock-review",
            "weekly-maintenance-review",
        )
    }
    return SampleDataset(
        profile=profile,
        seed=seed,
        anchor_date=anchor,
        document=document,
        module_counts=counts,
        department_ids=department_ids,
        module_ids=module_ids,
        field_ids=field_ids,
        relationship_ids=relationship_ids,
        trigger_ids=trigger_ids,
        records=records,
        edges=_edges(counts, relationship_ids),
        test_vectors=_build_test_vectors(
            seed, module_ids, field_ids, records, document, trigger_ids
        ),
        named_scenarios=(
            NamedScenario(
                "partially-paid-invoice",
                "Harbor invoice partially settled",
                ("invoices:000001", "payments:000001", "sales_orders:000001", "customers:000001"),
                {"invoice_total": 12_000, "payments_total": 4_500, "outstanding": 7_500},
            ),
        ),
    )
