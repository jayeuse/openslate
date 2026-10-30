"""Distributor business dates: one quarter of trips and tours; every child follows its parent."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from operations.sample.packs.fmcg_distributor import (
    lines,
    links,
    links_claims,
    links_finance,
    visits,
)
from operations.sample.packs.fmcg_distributor.catalog_fields import TERM_DAYS
from operations.sample.packs.fmcg_distributor.links import SPAN
from operations.sample.packs.fmcg_distributor.realism import date_cluster, holidays
from operations.sample.realism import working_day

ZONE = ZoneInfo("Asia/Manila")


def _rng(*parts: object) -> random.Random:
    return random.Random(":".join(str(part) for part in parts))


def is_working(day: date, anchor: date) -> bool:
    return day.weekday() < 5 and day not in holidays(anchor)


def last_working_day(anchor: date) -> date:
    day = anchor
    while not is_working(day, anchor):
        day -= timedelta(days=1)
    return day


def step(day: date, days: int, anchor: date) -> date:
    """``days`` working days after (or before, when negative) ``day``."""
    direction = 1 if days >= 0 else -1
    moved, left = day, abs(days)
    while left:
        moved += timedelta(days=direction)
        if is_working(moved, anchor):
            left -= 1
    return moved


def on_or_before(day: date, limit: date, anchor: date) -> date:
    """A working day no later than ``limit``."""
    day = min(day, limit)
    while not is_working(day, anchor):
        day -= timedelta(days=1)
    return day


def past(day: date, anchor: date) -> date:
    """A working day that has already happened (yesterday at the latest)."""
    return on_or_before(day, anchor - timedelta(days=1), anchor)


def cluster(module: str, index: int, seed: int, anchor: date, window: tuple[int, int]) -> date:
    return date_cluster(module, anchor, *window).pick(_rng(seed, module, index, "fmcg-date"))


def _slot(module: str, slot: int, slots: int, seed: int, anchor: date) -> date:
    base = anchor + timedelta(days=links_finance.nominal_day(slot, slots))
    jitter = _rng(seed, module, slot, "jitter").randint(-2, 2)
    low, high = anchor - timedelta(days=SPAN), anchor - timedelta(days=1)
    return working_day(min(high, max(low, base + timedelta(days=jitter))), holidays(anchor),
                       low, high)  # fmt: skip


def trip_date(trip: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    return _slot("delivery_trips", trip, counts["delivery_trips"], seed, anchor)


def tour_date(tour: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    if links.tour_status(tour, counts) == "Planned":
        return step(anchor, 1, anchor)
    return _slot("route_tours", tour, counts["route_tours"], seed, anchor)


def order_date(order: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    trips = links.order_trips(order, counts)
    if trips:
        booked = _rng(seed, "order", order, "lead").choice((1, 1, 1, 2))
        first = min(trip_date(trip, seed, anchor, counts) for trip in trips)
        return step(first, -booked, anchor)
    state = links.order_status(order)
    if state in {"Cancelled", "Rejected by credit"}:
        return cluster("sales_orders", order, seed, anchor, (-SPAN, -1))
    days_ago = _rng(seed, "order", order, "open").randint(0, 3)
    return step(last_working_day(anchor), -days_ago, anchor)


def visit_date(visit: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    order = links.visit_order(visit, counts)
    if order is not None:
        return order_date(order, seed, anchor, counts)
    if visit >= links.presell_visit_count(counts):
        return tour_date(links.visit_tour(visit, counts)[0], seed, anchor, counts)
    state = visits.visit_status(visit, counts)
    if state == "Planned":
        return step(anchor, _rng(seed, "visit", visit).randint(1, 5), anchor)
    if state == "In progress":
        return last_working_day(anchor)
    return cluster("store_visits", visit, seed, anchor, (-SPAN, -1))


def invoice_date(index: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    bill = links_finance.invoice(index, counts)
    if bill.kind == "order":
        trips = links.order_trips(bill.source, counts)
        return max(trip_date(trip, seed, anchor, counts) for trip in trips)
    return tour_date(bill.source, seed, anchor, counts)


def due_date(index: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    bill = links_finance.invoice(index, counts)
    return invoice_date(index, seed, anchor, counts) + timedelta(days=TERM_DAYS[bill.terms])


def followup_date(item: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    target = links_finance.followup_invoice(item, counts)
    rounds = links_finance.followup_round(item, counts)
    due = due_date(target, seed, anchor, counts)
    later = due + timedelta(days=_rng(seed, "followup", item).randint(3, 10) + 12 * rounds)
    latest = step(last_working_day(anchor), -1, anchor)
    return max(on_or_before(later, latest, anchor), min(latest, due))


def receipt_date(index: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    item = links_finance.receipt(index, counts)
    bills = [links_finance.invoice(member, counts) for member in item.invoices]
    issued = max(invoice_date(member, seed, anchor, counts) for member in item.invoices)
    if item.kind == "door":
        return issued
    offset = item.day - max(bill.day for bill in bills)
    day = issued + timedelta(days=offset)
    followups = [followup_date(followup, seed, anchor, counts)
                 for member in item.invoices
                 for followup in invoice_followups(member, counts)]  # fmt: skip
    if followups:
        day = max(day, step(max(followups), 1, anchor))
    return max(issued, on_or_before(day, last_working_day(anchor), anchor))


def invoice_followups(index: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return tuple(item for item in range(counts["collection_followups"])
                 if links_finance.followup_invoice(item, counts) == index)  # fmt: skip


def po_date(po: int, seed: int, anchor: date) -> date:
    window = {
        "Closed": (-SPAN, -20), "Received": (-40, -10), "Partially received": (-30, -8),
        "Sent to principal": (-12, -3), "Approved": (-6, -2), "Pending approval": (-4, -1),
        "Draft": (-3, -1),
    }.get(lines.po_status(po), (-60, -5))  # fmt: skip
    return cluster("purchase_orders", po, seed, anchor, window)


def receipt_received_on(receipt: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    po = lines.receipt_po(receipt, counts)
    if lines.second_delivery(receipt, counts):
        first = lines.received_pos(counts["purchase_orders"]).index(po)
        start = receipt_received_on(first, seed, anchor, counts)
        lead = _rng(seed, "grn", receipt).randint(4, 12)
    else:
        start = po_date(po, seed, anchor)
        lead = _rng(seed, "grn", receipt).randint(3, 8)
    return max(start, past(step(start, lead, anchor), anchor))


def lot_received_on(lot: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    source = lines.lot_receipt(lot, counts)
    if source is not None:
        return receipt_received_on(source[0], seed, anchor, counts)
    return cluster("stock_lots", lot, seed, anchor, (-200, -SPAN - 1))


def adjusted_on(item: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    received = lot_received_on(lines.adjustment_lot(item, counts), seed, anchor, counts)
    room = max(0, (anchor - received).days - 1)
    later = received + timedelta(days=round(room * _rng(seed, "adjustment", item).random()))
    return max(received, past(later, anchor))


def reported_on(item: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    source = links_claims.return_invoice(item, counts)
    if source is None:
        return cluster("returns", item, seed, anchor, (-SPAN, -1))
    issued = invoice_date(source, seed, anchor, counts)
    return max(issued, past(step(issued, _rng(seed, "bo", item).randint(1, 20), anchor), anchor))


def promotion_dates(promotion: int, seed: int, anchor: date) -> tuple[date, date]:
    windows = {"Claimed": ((-120, -60), (21, 45)), "Ended": ((-80, -35), (21, 30)),
               "Active": ((-40, -3), (45, 70)), "Cancelled": ((-60, 20), (14, 30))}
    start_window, length = windows.get(links_claims.promotion_status(promotion),
                                       ((3, 30), (14, 45)))  # fmt: skip
    start = cluster("trade_promotions", promotion, seed, anchor, start_window)
    days = _rng(seed, "promotion", promotion, "length").randint(*length)
    end = start + timedelta(days=days)
    if links_claims.promotion_status(promotion) == "Ended":
        end = min(end, anchor - timedelta(days=5))
    return start, min(end, anchor + timedelta(days=85))


def filed_on(claim: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    promotion = links_claims.claim_promotion(claim, counts)
    returns = links_claims.claim_returns(claim, counts)
    receipt = links_claims.claim_receipt(claim, counts)
    if promotion is not None:
        after, gap = promotion_dates(promotion, seed, anchor)[1], (5, 14)
    elif returns:
        after = max(reported_on(item, seed, anchor, counts) for item in returns)
        gap = (3, 15)
    elif receipt is not None:
        after, gap = receipt_received_on(receipt, seed, anchor, counts), (1, 4)
    else:
        return cluster("principal_claims", claim, seed, anchor, (-SPAN, -1))
    later = step(after, _rng(seed, "claim", claim).randint(*gap), anchor)
    return max(after, on_or_before(later, last_working_day(anchor), anchor))


def ap_invoice_date(item: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    po = links_claims.ap_invoice_po(item, counts)
    start = step(po_date(po, seed, anchor), 2, anchor)
    received = lines.received_pos(counts["purchase_orders"])
    if po in received and received.index(po) < counts["goods_receipts"]:
        start = max(start, receipt_received_on(received.index(po), seed, anchor, counts))
    later = step(start, _rng(seed, "ap", item).randint(0, 5), anchor)
    return max(po_date(po, seed, anchor), on_or_before(later, last_working_day(anchor), anchor))


def stamp(day: date, seed: int, *key: object) -> str:
    rng = _rng(seed, *key, "time")
    at = time(rng.choice((7, 8, 8, 9, 9, 10, 10, 11, 13, 14, 14, 15, 16)), rng.randrange(60))
    return datetime.combine(day, at, ZONE).isoformat(timespec="minutes")


def activity_date(
    module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int]
) -> date:
    """The record's main business date, as its first date field holds it."""
    from operations.sample.packs.fmcg_distributor.values import main_date

    return main_date(module_key, index, seed, anchor, counts)


def related_datetime(
    module_key: str, field_key: str, index: int, seed: int, anchor: date,
    counts: Mapping[str, int],
) -> str:  # fmt: skip
    day = activity_date(module_key, index, seed, anchor, counts)
    return stamp(day, seed, module_key, index, field_key)
