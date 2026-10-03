"""Record dates that follow business order, inside a record and across its links."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from operations.sample_packs.harbor.links import invoice_payment_index, parent_indices

_MANILA = ZoneInfo("Asia/Manila")

# Days from the record's main date to each related timestamp, as (lowest, highest).
_OFFSETS: dict[tuple[str, str], tuple[int, int]] = {
    ("quotes", "sent_at"): (-30, -7),
    ("sales_orders", "promised_at"): (2, 21),
    ("service_contracts", "signed_at"): (-330, -180),
    ("service_requests", "requested_at"): (-10, -1),
    ("work_orders", "scheduled_at"): (-5, 0),
    ("purchase_orders", "confirmed_at"): (-20, -5),
    ("goods_receipts", "received_at"): (0, 0),
    ("invoices", "issued_at"): (-30, -30),
    ("payments", "posted_at"): (0, 0),
    ("expenses", "submitted_at"): (0, 5),
    ("credit_notes", "issued_at"): (0, 0),
}
# Timestamps of events that have already happened; they never pass the anchor date.
_PAST = {"sent_at", "signed_at", "requested_at", "confirmed_at", "issued_at", "posted_at",
         "received_at", "submitted_at"}  # fmt: skip
# Child records whose main date follows a parent event: (parent module, parent timestamp
# field, how to find the parent, days after the parent event).
_AFTER_PARENT = {
    "payments": ("invoices", "issued_at", "invoice_payments", (3, 40)),
    "credit_notes": ("invoices", "issued_at", "invoice_credits", (5, 30)),
    "request_updates": ("service_requests", "requested_at", "request_updates", (0, 14)),
    "goods_receipts": ("purchase_orders", "confirmed_at", "purchase_order_receipts", (3, 20)),
    "inspections": ("work_orders", "scheduled_at", "work_order_inspections", (0, 5)),
}


def special_date(module_key: str, field_key: str, index: int, anchor: date) -> date | None:
    """Dates that named business cases depend on."""
    if module_key == "invoices" and field_key == "activity_date" and index in {0, 5, 7, 9}:
        return anchor - timedelta(days=30 - index)
    if module_key == "service_requests" and field_key == "activity_date" and index == 0:
        return anchor - timedelta(days=3)
    if module_key == "work_orders" and field_key == "activity_date" and index == 0:
        return anchor - timedelta(days=5)
    if module_key == "purchase_orders" and field_key == "activity_date" and index in {0, 1, 2}:
        return anchor - timedelta(days=(2, 7, 20)[index])
    if module_key == "goods_receipts" and field_key == "activity_date" and index in {0, 1, 2}:
        return anchor - timedelta(days=2 - index)
    return None


def _latest_main_date(module_key: str, index: int, counts: Mapping[str, int]) -> int:
    """Upper bound, in days after the anchor, for a record's main date."""
    if module_key == "invoices" and invoice_payment_index(index, counts) is not None:
        return 25  # A paid invoice was issued (30 days before due) before today.
    if module_key == "purchase_orders":
        return 5  # Every PO with receipts was confirmed before today.
    if module_key == "expenses":
        return -5  # An expense is incurred, then submitted, before today.
    return 90


def activity_date(
    module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int]
) -> date:
    """The record's main date field (for example Ordered on or Due date)."""
    special = special_date(module_key, "activity_date", index, anchor)
    if special is not None:
        return special
    rng = random.Random(f"{seed}:{module_key}:{index}:activity_date")
    parent = _AFTER_PARENT.get(module_key)
    if parent is not None:
        parent_module, parent_field, link, (low, high) = parent
        parent_index = parent_indices(link, index, counts)[0]
        start = related_date(parent_module, parent_field, parent_index, seed, anchor, counts)
        return min(start + timedelta(days=rng.randint(low, high)), max(start, anchor))
    latest = _latest_main_date(module_key, index, counts)
    return anchor + timedelta(days=rng.randint(-365, latest))


def related_date(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> date:
    """A related date placed in business order relative to the record's main date."""
    main = activity_date(module_key, index, seed, anchor, counts)
    low, high = _OFFSETS.get((module_key, field_key), (-30, 0))
    rng = random.Random(f"{seed}:{module_key}:{index}:{field_key}")
    highest = anchor if field_key in _PAST else anchor + timedelta(days=90)
    if module_key == "work_orders" and index < counts["inspections"]:
        highest = anchor  # Inspected work orders were scheduled before today.
    when = min(max(main + timedelta(days=rng.randint(low, high)), anchor - timedelta(days=365)),
               highest)  # fmt: skip
    if low >= 0 and when < main and main <= highest:
        when = main
    if high <= 0 and when > main:
        when = main
    return when


def related_datetime(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> str:
    when = related_date(module_key, field_key, index, seed, anchor, counts)
    local_time = time(8 + (index % 9), (index * 7) % 60)
    return datetime.combine(when, local_time, _MANILA).isoformat(timespec="minutes")
