"""Bad orders, trade promotions, principal claims, principal invoices and credit reviews."""

from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.fmcg_distributor import ledger, lines, links, links_finance
from operations.sample.packs.fmcg_distributor.links import (
    DISCREPANCY_RECEIPT,
    PINNED,
    _key,
    pick,
    principal_status,
    rng,
    status,
)
from operations.sample.realism import weighted_label

# Warehouse: bad orders name the outlet and, mostly, the invoice the goods came on.

_BO_REASONS = {
    "Damaged in transit": 18, "Near expiry (30 days or less)": 15, "Expired": 12,
    "Crushed or dented can": 10, "Torn sachet or strip": 8, "Leaking": 7,
    "Wrong item delivered": 6, "Over-delivered": 4, "Swollen or bloated can": 4,
    "Short-dated on delivery": 4, "Rodent or pest damage": 3, "Price dispute": 3,
    "Packaging defect": 4, "Principal recall": 2,
}  # fmt: skip
_TO_PRINCIPAL = frozenset({"Near expiry (30 days or less)", "Expired", "Swollen or bloated can",
                           "Short-dated on delivery", "Packaging defect", "Principal recall",
                           "Leaking"})  # fmt: skip


def return_reason(item: int) -> str:
    if item < PINNED:
        return ("Expired", "Damaged in transit", "Near expiry (30 days or less)")[item % 3]
    return weighted_label(rng("returns", item, "reason"), _BO_REASONS)


def return_status(item: int) -> str:
    return status("returns", item)


def return_disposition(item: int) -> str | None:
    if return_status(item) in {"Requested", "Authorized", "Picked up", "Received", "Rejected",
                               "Cancelled"}:  # fmt: skip
        return None
    reason = return_reason(item)
    if reason in _TO_PRINCIPAL:
        return "Return to principal"
    if reason in {"Wrong item delivered", "Over-delivered"}:
        return "Restock"
    if reason == "Price dispute":
        return "Replace"
    return "Destroy" if rng("returns", item, "disposition").random() < 0.4 else (
        "Return to principal")  # fmt: skip


def _billable(counts: Mapping[str, int]) -> tuple[int, ...]:
    bills = links_finance.invoices(counts)
    return tuple(index for index, bill in enumerate(bills) if not bill.voided)


def return_invoice(item: int, counts: Mapping[str, int]) -> int | None:
    if item >= PINNED and item % 7 == 3:
        return None  # Old stock bought before the quarter.
    if item < PINNED:
        return PINNED + item
    return pick("return_invoice", item, (counts["sales_invoices"], counts["sales_orders"]),
                lambda: _billable(counts))  # fmt: skip


def return_outlet(item: int, counts: Mapping[str, int]) -> int:
    source = return_invoice(item, counts)
    if source is not None:
        return links_finance.invoice(source, counts).outlet
    outlets = links.route_outlets("Pre-sell", counts)
    return pick("return_outlet", item, (counts["beats"], counts["outlets"]), lambda: outlets)


# Trade marketing: each scheme comes from one principal's circular.

_SCHEMES = {"Free goods (buy X get Y)": 30, "Off-invoice discount": 20,
            "Quantity purchase scheme": 15, "Display allowance": 12, "Value purchase scheme": 10,
            "Bill-back": 8, "Listing fee": 5}  # fmt: skip


def _supplying(principals: int) -> tuple[int, ...]:
    return tuple(item for item in range(principals) if principal_status(item) == "Active")


def promotion_principal(promotion: int, counts: Mapping[str, int]) -> int:
    supplying = _supplying(counts["principals"])
    if promotion < PINNED:
        return supplying[promotion % len(supplying)]
    return pick("promotion_principal", promotion, (counts["principals"],), lambda: supplying)


def promotion_status(promotion: int) -> str:
    return status("trade_promotions", promotion)


def scheme_type(promotion: int) -> str:
    if promotion < PINNED:
        return tuple(_SCHEMES)[promotion % 3]
    return weighted_label(rng("trade_promotions", promotion, "type"), _SCHEMES)


# Accounting: claims and the principals' own invoices.

_CLAIM_TYPES = {"Scheme or promo": 38, "BO or expiry return": 25, "Display allowance": 10,
                "Price difference": 10, "Short or damaged delivery": 10, "Freight subsidy": 7}


def claim_type(claim: int) -> str:
    if claim == 0:
        return "Short or damaged delivery"
    if claim < PINNED:
        return ("Scheme or promo", "BO or expiry return", "Display allowance")[claim % 3]
    return weighted_label(rng("principal_claims", claim, "type"), _CLAIM_TYPES)


def claim_status(claim: int) -> str:
    return status("principal_claims", claim)


def _claimable(promotions: int, display: bool) -> tuple[int, ...]:
    claimed = [item for item in range(promotions) if promotion_status(item) == "Claimed"]
    matched = [item for item in claimed if (scheme_type(item) == "Display allowance") == display]
    return tuple(matched or claimed or range(promotions))


def claim_promotion(claim: int, counts: Mapping[str, int]) -> int | None:
    kind = claim_type(claim)
    if kind not in {"Scheme or promo", "Display allowance"}:
        return None
    display = kind == "Display allowance"
    return pick(f"claim_promotions:{display}", claim, (counts["trade_promotions"],),
                lambda: _claimable(counts["trade_promotions"], display))  # fmt: skip


@lru_cache(maxsize=16)
def _bo_returns(returns: int, claims: int) -> dict[int, tuple[int, ...]]:
    eligible = [item for item in range(returns)
                if return_disposition(item) == "Return to principal"]  # fmt: skip
    found: dict[int, tuple[int, ...]] = {}
    position = 0
    for claim in range(claims):
        if claim_type(claim) != "BO or expiry return" or not eligible:
            continue
        size = 1 + claim % 3
        found[claim] = tuple(dict.fromkeys(eligible[(position + step) % len(eligible)]
                                           for step in range(size)))  # fmt: skip
        position += size
    return found


def claim_returns(claim: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _bo_returns(*_key(counts, "returns", "principal_claims")).get(claim, ())


def _discrepancies(counts: Mapping[str, int]) -> tuple[int, ...]:
    found = tuple(item for item in range(counts["goods_receipts"])
                  if lines.receipt_status(item, counts) == "Posted with discrepancy")  # fmt: skip
    return found or (min(DISCREPANCY_RECEIPT, counts["goods_receipts"] - 1),)


def claim_receipt(claim: int, counts: Mapping[str, int]) -> int | None:
    if claim == 0:
        return DISCREPANCY_RECEIPT
    if claim_type(claim) != "Short or damaged delivery":
        return None
    return pick("claim_receipt", claim, (counts["goods_receipts"], counts["purchase_orders"]),
                lambda: _discrepancies(counts))  # fmt: skip


def claim_principal(claim: int, counts: Mapping[str, int]) -> int:
    promotion = claim_promotion(claim, counts)
    if promotion is not None:
        return promotion_principal(promotion, counts)
    receipt = claim_receipt(claim, counts)
    if receipt is not None:
        return lines.po_principal(lines.receipt_po(receipt, counts), counts)
    supplying = _supplying(counts["principals"])
    return pick("claim_principal", claim, (counts["principals"],), lambda: supplying)


def ap_invoice_po(item: int, counts: Mapping[str, int]) -> int:
    received = lines.received_pos(counts["purchase_orders"])
    if item < len(received):
        return received[item]
    sent = tuple(po for po in range(counts["purchase_orders"])
                 if lines.po_status(po) == "Sent to principal")  # fmt: skip
    return pick("ap_invoice_po", item, (counts["purchase_orders"],),
                lambda: (*received, *sent) or (0,))  # fmt: skip


def match_result(item: int, counts: Mapping[str, int]) -> str:
    if item == 1:
        return "Price variance"
    if lines.po_status(ap_invoice_po(item, counts)) == "Sent to principal":
        return "No goods receipt"
    if item < PINNED:
        return "3-way matched"
    return weighted_label(rng("principal_invoices", item, "match"),
                          {"3-way matched": 82, "Quantity variance": 9, "Price variance": 9})


def ap_status(item: int, counts: Mapping[str, int]) -> str:
    result = match_result(item, counts)
    if item == 1:
        return "On hold – variance"
    draw = rng("principal_invoices", item, "status")
    if result in {"Quantity variance", "Price variance"}:
        return weighted_label(draw, {"On hold – variance": 60, "Paid": 30, "Disputed": 10})
    if result == "No goods receipt":
        return weighted_label(draw, {"Received": 60, "Matching": 40})
    if item < PINNED:
        return "Paid"
    return weighted_label(draw, {"Paid": 80, "Approved for payment": 12, "Matching": 5,
                                 "Received": 3})  # fmt: skip


def ap_amount(item: int, counts: Mapping[str, int]) -> int | float:
    po = ap_invoice_po(item, counts)
    received = float(ledger.po_received_value(po, counts)) or float(ledger.po_total(po, counts))
    result = match_result(item, counts)
    span = lines.po_line_range(po, counts)
    if result == "Quantity variance":
        received += 2 * float(ledger.unit_cost(lines.po_line_product(span.start, counts)))
    if result == "Price variance":
        received += 2.5 * sum(lines.po_line_received(line, counts) or lines.po_line_cases(line)
                              for line in span)  # fmt: skip
    return ledger.money(received)


# Credit: reviews of an outlet's credit line.


def review_outlet(review: int, counts: Mapping[str, int]) -> int:
    if review < PINNED:
        return PINNED + review * 3
    return pick("review_outlet", review, (counts["outlets"],),
                lambda: tuple(item for item in range(counts["outlets"])
                              if links.outlet_status(item) != "Closed"))  # fmt: skip


def review_type(review: int, counts: Mapping[str, int]) -> str:
    state = links.outlet_status(review_outlet(review, counts))
    if state == "Prospect":
        return "New account"
    if state in {"On credit hold", "Blocked"}:
        return "Reinstatement"
    return "Limit increase" if rng("credit_reviews", review, "type").random() < 0.55 else (
        "Periodic review")  # fmt: skip
