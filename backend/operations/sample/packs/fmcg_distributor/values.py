"""Distributor statuses, choices and dates: each follows the record's links."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import date, timedelta

from operations.sample.packs.fmcg_distributor import (
    dates,
    lines,
    links,
    links_claims,
    links_finance,
    visits,
)
from operations.sample.packs.fmcg_distributor.catalog_fields import (
    AGING_BUCKETS,
    NEAR_EXPIRY,
    WEEKDAYS,
)
from operations.sample.packs.fmcg_distributor.links import PINNED, SPAN, rng
from operations.sample.packs.types import FieldSpec, ModuleSpec
from operations.sample.realism import ordered_skew, weighted_label

Counts = Mapping[str, int]

_STATUS: dict[str, Callable[[int, Counts], str]] = {
    "outlets": lambda i, _c: links.outlet_status(i),
    "beats": lambda i, _c: links.beat_status(i),
    "store_visits": visits.visit_status,
    "sales_orders": lambda i, _c: links.order_status(i),
    "order_lines": lines.line_status,
    "route_tours": links.tour_status,
    "trade_promotions": lambda i, _c: links_claims.promotion_status(i),
    "principals": lambda i, _c: links.principal_status(i),
    "products": lambda i, _c: links.product_status(i),
    "purchase_orders": lambda i, _c: lines.po_status(i),
    "po_lines": lines.po_line_status,
    "goods_receipts": lines.receipt_status,
    "stock_lots": lambda i, _c: lines.lot_status(i),
    "stock_counts": lambda i, _c: links.status("stock_counts", i),
    "stock_adjustments": lambda i, _c: links.status("stock_adjustments", i),
    "returns": lambda i, _c: links_claims.return_status(i),
    "delivery_trips": lambda i, _c: links.trip_status(i),
    "vehicles": lambda i, _c: links.vehicle_status(i),
    "sales_invoices": links_finance.invoice_status,
    "collection_receipts": links_finance.receipt_status,
    "credit_reviews": lambda i, _c: links.status("credit_reviews", i),
    "collection_followups": links_finance.followup_status,
    "principal_invoices": links_claims.ap_status,
    "principal_claims": lambda i, _c: links_claims.claim_status(i),
}


def status_label(module_key: str, index: int, counts: Counts) -> str:
    return _STATUS[module_key](index, counts)


def expiry_band(lot: int) -> str:
    state = lines.lot_status(lot)
    if lot == 2:
        return "91–180 days"  # The live input moves it into the near-expiry band.
    if state == "Pick first (FEFO)":
        return NEAR_EXPIRY
    if state == "Blocked":
        return "Expired"
    if state == "Returned to principal":
        return "Expired" if lot % 2 else "30 days or less"
    if state == "Quarantine":
        return ("More than 180 days", "91–180 days", NEAR_EXPIRY)[lot % 3]
    if lot < PINNED:
        return "More than 180 days"
    return "More than 180 days" if rng("stock_lots", lot, "band").random() < 0.65 else (
        "91–180 days")  # fmt: skip


def aging_bucket(days: int) -> str:
    if days <= 0:
        return AGING_BUCKETS[0]
    if days <= 30:
        return AGING_BUCKETS[1]
    if days <= 60:
        return AGING_BUCKETS[2]
    return AGING_BUCKETS[3] if days <= 90 else AGING_BUCKETS[4]


def _beat_salesman(beat: int) -> str:
    from operations.sample.packs.fmcg_distributor.people import (
        KEY_ACCOUNT_KEY,
        PRE_SELLER_KEY,
        SUPERVISOR_KEY,
        VAN_SALESMAN_KEY,
    )

    route = links.beat_route(beat)
    if route == "Van sales":
        return VAN_SALESMAN_KEY
    if route == "Key account":
        return KEY_ACCOUNT_KEY
    return SUPERVISOR_KEY if beat % 5 == 4 else PRE_SELLER_KEY


def _choices(module: str, index: int, counts: Counts) -> dict[str, Callable[[], str | None]]:
    def finance_terms() -> str:
        return links_finance.outlet_terms(links.order_outlet(index, counts))

    return {
        "channel": lambda: links.outlet_channel(index),
        "outlet_class": lambda: _outlet_class(index),
        "payment_terms": (lambda: links_finance.outlet_terms(index)) if module == "outlets"
        else finance_terms,  # fmt: skip
        "route_type": lambda: links.beat_route(index),
        "visit_day": lambda: WEEKDAYS[index % 6],
        "visit_type": lambda: "Van sales" if index >= links.presell_visit_count(counts)
        else "Pre-sell",  # fmt: skip
        "outcome": lambda: visits.visit_outcome(index, counts),
        "no_order_reason": lambda: _no_order_reason(index, counts),
        "order_channel": lambda: links.order_channel(index),
        "scheme_type": lambda: links_claims.scheme_type(index),
        "principal_category": lambda: _principal(index)[2],
        "principal_terms": lambda: _principal(index)[4],
        "abc_class": lambda: _sku(index, counts)[4],
        "expiry_band": lambda: expiry_band(index),
        "count_type": lambda: lines.count_type(index),
        "adjust_reason": lambda: lines.adjustment_reason(index),
        "bo_reason": lambda: links_claims.return_reason(index),
        "disposition": lambda: links_claims.return_disposition(index),
        "vehicle_type": lambda: links.vehicle_type(index, counts),
        "invoice_channel": lambda: _invoice_channel(index, counts),
        "aging_bucket": lambda: aging_bucket(links_finance.days_past_due(index, counts)),
        "receipt_method": lambda: links_finance.receipt_method(index, counts),
        "review_type": lambda: links_claims.review_type(index, counts),
        "terms_requested": lambda: ("7 days", "15 days", "30 days")[index % 3],
        "decline_reason": lambda: _decline_reason(index),
        "followup_action": lambda: _followup_action(index, counts),
        "match_result": lambda: links_claims.match_result(index, counts),
        "claim_type": lambda: links_claims.claim_type(index),
        "claim_rejection": lambda: _claim_rejection(index),
    }


def choice_label(module: ModuleSpec, field: FieldSpec, index: int, counts: Counts) -> str | None:
    """The option a person picks; ``None`` leaves an optional Select empty."""
    picker = _choices(module.key, index, counts).get(field.value_kind)
    if picker is not None:
        return picker()
    return weighted_label(rng(module.key, index, field.key), ordered_skew(field.options))


def _principal(index: int) -> tuple[str, str, str, str, str]:
    from operations.sample.packs.fmcg_distributor.text import principal

    return principal(index)


def _sku(product: int, counts: Counts) -> tuple[str, str, int, int, str]:
    from operations.sample.packs.fmcg_distributor.ledger import product_sku

    return product_sku(product, counts)


def _outlet_class(outlet: int) -> str:
    channel = links.outlet_channel(outlet)
    if channel in {"Supermarket (modern trade)", "Wholesaler or market stall"} or outlet < 2:
        return "A"
    if channel in {"Minimart", "Small grocery", "Pharmacy or drugstore"}:
        return "A" if rng("outlets", outlet, "class").random() < 0.3 else "B"
    return weighted_label(rng("outlets", outlet, "class"), {"C": 60, "B": 32, "A": 8})


def _no_order_reason(visit: int, counts: Counts) -> str | None:
    if visits.visit_outcome(visit, counts) != "No order":
        return None
    return weighted_label(rng("store_visits", visit, "reason"), {
        "Stock still sufficient": 30, "Owner not around": 14, "No cash today": 12,
        "Store closed": 10, "Bought from wholesaler": 9, "Account on credit hold": 6,
        "Requested item out of stock": 7, "Ran out of time": 5, "Road flooded or closed": 5,
        "Outlet relocated": 2})  # fmt: skip


def _invoice_channel(index: int, counts: Counts) -> str:
    bill = links_finance.invoice(index, counts)
    if bill.kind == "van":
        return "Van"
    return "Key account" if links.order_channel(bill.source) == "Key account" else "Pre-sell"


def _decline_reason(review: int) -> str | None:
    if links.status("credit_reviews", review) not in {"Declined", "Approved with conditions"}:
        return None
    return weighted_label(rng("credit_reviews", review, "reason"), {
        "Over limit": 30, "60+ days overdue": 25, "New account, no trade references": 20,
        "Bounced cheque history": 15, "Business permit expired": 10})  # fmt: skip


def _followup_action(item: int, counts: Counts) -> str:
    rounds = links_finance.followup_round(item, counts)
    if item == 0 or rounds == 0:
        return ("Call", "Visit", "Statement sent")[item % 3]
    if links_finance.followup_status(item, counts) == "Escalated":
        return "Endorsed to legal" if rounds > 1 else "Demand letter"
    return "Demand letter" if rounds > 1 else "Visit"


def _claim_rejection(claim: int) -> str | None:
    if links_claims.claim_status(claim) not in {"Rejected", "Partially approved"}:
        return None
    return weighted_label(rng("principal_claims", claim, "rejection"), {
        "Missing proof of performance": 25, "Filed past claim deadline": 15,
        "Secondary sales not in DMS": 15, "SKU not covered by scheme": 12,
        "Exceeds scheme cap": 10, "Unsigned outlet acknowledgment": 10,
        "Display photos missing or unclear": 8, "Duplicate claim": 3,
        "Price difference not pre-approved": 2})  # fmt: skip


# Dates. Each function returns None when the field stays empty on that record.


def _date(module: str, kind: str, index: int, seed: int, anchor: date, counts: Counts
          ) -> date | None:  # fmt: skip
    status = status_label(module, index, counts)
    cluster = dates.cluster
    if kind == "last_visit":
        days = [dates.visit_date(visit, seed, anchor, counts)
                for visit in visits.outlet_visits(index, counts)
                if visits.visit_status(visit, counts) == "Completed"]  # fmt: skip
        return max(days) if days else None
    if kind == "effective_from":
        return cluster(module, index, seed, anchor, (-200, -20))
    if kind == "visit_date":
        return dates.visit_date(index, seed, anchor, counts)
    if kind == "order_date":
        return dates.order_date(index, seed, anchor, counts)
    if kind == "requested_delivery":
        return dates.step(dates.order_date(index, seed, anchor, counts), 1, anchor)
    if kind == "tour_date":
        return dates.tour_date(index, seed, anchor, counts)
    if kind in {"start_date", "end_date"}:
        start, end = dates.promotion_dates(index, seed, anchor)
        return start if kind == "start_date" else end
    if kind == "claim_deadline":
        end = dates.promotion_dates(index, seed, anchor)[1]
        return min(end + timedelta(days=45), anchor + timedelta(days=88))
    if kind == "renewed_on":
        return cluster(module, index, seed, anchor, (-365, -30))
    if kind == "price_effective":
        return cluster(module, index, seed, anchor, (-365, -5))
    if kind == "po_date":
        return dates.po_date(index, seed, anchor)
    if kind == "expected_delivery":
        return dates.step(dates.po_date(index, seed, anchor), 5 + index % 6, anchor)
    if kind == "received_on":
        return dates.receipt_received_on(index, seed, anchor, counts)
    if kind == "lot_received_on":
        return dates.lot_received_on(index, seed, anchor, counts)
    if kind == "count_date":
        if status == "Scheduled":
            return dates.step(anchor, 1 + index % 5, anchor)
        return cluster(module, index, seed, anchor, (-SPAN, -1))
    if kind == "adjusted_on":
        return dates.adjusted_on(index, seed, anchor, counts)
    if kind == "reported_on":
        return dates.reported_on(index, seed, anchor, counts)
    if kind == "pickup_date":
        if status in {"Requested", "Rejected", "Cancelled"}:
            return None
        reported = dates.reported_on(index, seed, anchor, counts)
        picked = dates.step(reported, 1 + index % 3, anchor)
        return picked if status == "Authorized" else max(reported, dates.past(picked, anchor))
    if kind == "trip_date":
        return dates.trip_date(index, seed, anchor, counts)
    if kind == "next_pms_due":
        return cluster(module, index, seed, anchor, (-15, 85))
    if kind == "invoice_date":
        return dates.invoice_date(index, seed, anchor, counts)
    if kind == "due_date":
        return dates.due_date(index, seed, anchor, counts)
    if kind == "receipt_date":
        return dates.receipt_date(index, seed, anchor, counts)
    if kind == "requested_on":
        return cluster(module, index, seed, anchor, (-SPAN, -1))
    if kind == "followup_date":
        return dates.followup_date(index, seed, anchor, counts)
    if kind == "promise_date":
        if status != "Promise to pay":
            return None
        return dates.step(dates.followup_date(index, seed, anchor, counts), 3 + index % 6, anchor)
    if kind == "ap_invoice_date":
        return dates.ap_invoice_date(index, seed, anchor, counts)
    if kind == "ap_due_date":
        po = links_claims.ap_invoice_po(index, counts)
        terms = int(_principal(lines.po_principal(po, counts))[4].split()[0])
        return dates.ap_invoice_date(index, seed, anchor, counts) + timedelta(days=terms)
    if kind == "filed_on":
        return dates.filed_on(index, seed, anchor, counts)
    raise ValueError(f"Unsupported distributor date {module}.{kind}")


def date_value(module: str, kind: str, index: int, seed: int, anchor: date, counts: Counts
               ) -> date | None:  # fmt: skip
    return _date(module, kind, index, seed, anchor, counts)


_MAIN_KINDS = {
    "outlets": "last_visit", "beats": "effective_from", "store_visits": "visit_date",
    "sales_orders": "order_date", "route_tours": "tour_date", "trade_promotions": "start_date",
    "principals": "renewed_on", "products": "price_effective", "purchase_orders": "po_date",
    "goods_receipts": "received_on", "stock_lots": "lot_received_on",
    "stock_counts": "count_date", "stock_adjustments": "adjusted_on", "returns": "reported_on",
    "delivery_trips": "trip_date", "vehicles": "next_pms_due", "sales_invoices": "invoice_date",
    "collection_receipts": "receipt_date", "credit_reviews": "requested_on",
    "collection_followups": "followup_date", "principal_invoices": "ap_invoice_date",
    "principal_claims": "filed_on",
}  # fmt: skip


def main_date(module_key: str, index: int, seed: int, anchor: date, counts: Counts) -> date:
    """The record's main business date; a line takes its order's or purchase order's."""
    if module_key == "order_lines":
        return dates.order_date(lines.line_order(index, counts), seed, anchor, counts)
    if module_key == "po_lines":
        return dates.po_date(lines.po_line_po(index, counts), seed, anchor)
    day = _date(module_key, _MAIN_KINDS[module_key], index, seed, anchor, counts)
    return day or dates.last_working_day(anchor)
