"""Distributor numbers and short texts: quantities, money, counters, codes and notes."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import date

from operations.sample.packs.fmcg_distributor import (
    dates,
    ledger,
    lines,
    links,
    links_claims,
    links_finance,
    text,
    visits,
)
from operations.sample.packs.fmcg_distributor import vocabulary as words
from operations.sample.packs.fmcg_distributor.links import PINNED, rng
from operations.sample.packs.fmcg_distributor.realism import (
    CLAIM_AMOUNT,
    CREDIT_LIMIT,
    OUTLET_LIMITS,
    PROMO_BUDGET,
    RETURN_VALUE,
)
from operations.sample.packs.types import OMIT
from operations.sample.realism import long_tail_amount

Counts = Mapping[str, int]
Value = int | float | str | object


def tour_invoices(tour: int, counts: Counts) -> tuple[int, ...]:
    bills = links_finance.invoices(counts)
    return tuple(index for index, bill in enumerate(bills)
                 if bill.kind == "van" and bill.source == tour)  # fmt: skip


def _tour_money(tour: int, counts: Counts, kind: str) -> Value:
    if links.tour_status(tour, counts) in {"Planned", "Cancelled"}:
        return OMIT
    bills = [links_finance.invoice(index, counts) for index in tour_invoices(tour, counts)]
    sold = sum(bill.amount for bill in bills if not bill.voided)
    cash = sum(bill.amount for bill in bills if not bill.voided and bill.terms ==
               "Cash on delivery")  # fmt: skip
    short = 0.0
    if links.tour_status(tour, counts) == "Variance under review":
        short = 1_250.0 if tour < PINNED else float(rng("tour", tour, "short").choice(
            (600, 750, 980, 1_250, 1_800, 2_450)))  # fmt: skip
    values = {
        "sales_value": sold,
        "load_value": round(sold * rng("tour", tour, "load").uniform(1.2, 1.5) / 50) * 50,
        "cash_remitted": cash - short,
        "cash_variance": -short,
    }
    return ledger.money(values[kind])


def _count_quantities(count: int) -> tuple[int, int | None, float | None]:
    state = links.status("stock_counts", count)
    system = 120 if count == 1 else rng("stock_counts", count, "system").randint(8, 420)
    if state == "Scheduled":
        return system, None, None
    if count == 1:
        counted = 116
    elif state == "Recount required":
        counted = system + rng("stock_counts", count, "gap").choice((-9, -6, -4, 5, 7))
    elif rng("stock_counts", count, "exact").random() < 0.8:
        counted = system
    else:
        counted = system + rng("stock_counts", count, "gap").choice((-2, -1, 1))
    return system, counted, round((counted - system) / system * 100, 1)


def _lot_cases(lot: int, counts: Counts) -> int:
    state = lines.lot_status(lot)
    if state == "Depleted":
        return 0
    source = lines.lot_receipt(lot, counts)
    received = lines.po_line_received(source[1], counts) if source else 60
    share = rng("stock_lots", lot, "left").uniform(0.05, 0.9)
    if state in {"Blocked", "Returned to principal", "Quarantine"}:
        share = rng("stock_lots", lot, "left").uniform(0.02, 0.15)
    return max(1, round(received * share))


def _return_value(item: int, counts: Counts) -> Value:
    value = long_tail_amount(rng("returns", item, "value"), RETURN_VALUE)
    source = links_claims.return_invoice(item, counts)
    if source is not None:
        value = min(float(value), round(links_finance.invoice(source, counts).amount * 0.7, 2))
    return ledger.money(float(value))


def _claim_amount(claim: int, kind: str) -> Value:
    claimed = long_tail_amount(rng("principal_claims", claim, "claimed"), CLAIM_AMOUNT)
    if kind == "claim_amount":
        return claimed
    state = links_claims.claim_status(claim)
    if state in {"Approved", "Settled – credit note", "Settled – offset"}:
        return claimed
    if state == "Partially approved":
        share = rng("principal_claims", claim, "share").uniform(0.55, 0.9)
        return ledger.money(round(float(claimed) * share, -1))
    return OMIT


def _credit_limit(outlet: int) -> Value:
    if links_finance.outlet_terms(outlet) == "Cash on delivery":
        return OMIT
    draw = rng("outlets", outlet, "limit")
    tier = {"A": (5, 11), "B": (2, 7), "C": (0, 4)}[_outlet_class(outlet)]
    return OUTLET_LIMITS[draw.randint(*tier)]


def _outlet_class(outlet: int) -> str:
    from operations.sample.packs.fmcg_distributor.values import _outlet_class as outlet_class

    return outlet_class(outlet)


def _review_limits(review: int, kind: str) -> Value:
    requested = long_tail_amount(rng("credit_reviews", review, "limit"), CREDIT_LIMIT)
    if kind == "credit_limit":
        return requested
    state = links.status("credit_reviews", review)
    if state == "Approved":
        return requested
    if state == "Approved with conditions":
        return max(5_000, round(float(requested) * 0.6 / 5_000) * 5_000)
    return OMIT


def _mechanics(promotion: int, counts: Counts) -> str:
    kind = links_claims.scheme_type(promotion)
    principal = links_claims.promotion_principal(promotion, counts)
    name, code = text.principal(principal)[0], text.principal(principal)[1]
    items = words.SKUS[code[:3]]
    item = items[promotion % len(items)][0]
    return words.PROMO_MECHANICS[kind].format(
        item=item, brand=name.split()[0], pct=(3, 5, 5, 8)[promotion % 4],
        amount=(150, 250, 500, 15_000)[promotion % 4])  # fmt: skip


def number_or_text(kind: str, module: str, index: int, seed: int, anchor: date,
                   counts: Counts, status: str) -> Value:  # fmt: skip
    """Every non-choice, non-date value; ``OMIT`` leaves an optional field empty."""
    producers: dict[str, Callable[[], Value]] = {
        "contact_name": lambda: text.contact_name(index),
        "address": lambda: text.address(index),
        "credit_limit": lambda: _credit_limit(index) if module == "outlets"
        else _review_limits(index, kind),  # fmt: skip
        "approved_limit": lambda: _review_limits(index, kind),
        "year": lambda: OMIT if status == "Prospect" else min(
            anchor.year, 2003 + rng("outlets", index, "since").randint(0, 23)),  # fmt: skip
        "planned_outlets": lambda: visits.beat_size(index, counts),
        "territory": lambda: words.TERRITORIES[index % len(words.TERRITORIES)],
        "order_total": lambda: ledger.order_total(index, counts),
        "cases": lambda: lines.line_cases(index, counts),
        "pieces": lambda: lines.line_pieces(index, counts) or OMIT,
        "unit_price": lambda: ledger.list_price(lines.line_product(index, counts)),
        "discount_pct": lambda: lines.line_discount(index, counts) or OMIT,
        "free_goods": lambda: lines.line_free_goods(
            index, counts, ledger.product_sku(lines.line_product(index, counts), counts)[2]
        ) or OMIT,  # fmt: skip
        "line_total": lambda: ledger.line_total(index, counts),
        "load_value": lambda: _tour_money(index, counts, "load_value"),
        "sales_value": lambda: _tour_money(index, counts, "sales_value"),
        "cash_remitted": lambda: _tour_money(index, counts, "cash_remitted"),
        "cash_variance": lambda: _tour_money(index, counts, "cash_variance"),
        "stock_variance": lambda: -1 if status == "Variance under review" and index % 2 else (
            OMIT if status in {"Planned", "Cancelled"} else 0),  # fmt: skip
        "mechanics": lambda: _mechanics(index, counts),
        "eligible_channels": lambda: ("Sari-sari and small grocery", "All general trade",
                                      "Modern trade only", "Pharmacies and drugstores")[
            index % 4],  # fmt: skip
        "promo_budget": lambda: long_tail_amount(rng("trade_promotions", index, "budget"),
                                                 PROMO_BUDGET),  # fmt: skip
        "account_manager": lambda: words.ACCOUNT_MANAGERS[index % len(words.ACCOUNT_MANAGERS)],
        "gtin_each": lambda: text.gtin_each(index, counts),
        "gtin_case": lambda: text.gtin_case(index, counts),
        "pieces_per_case": lambda: ledger.product_sku(index, counts)[2],
        "list_price": lambda: ledger.list_price(index),
        "shelf_life": lambda: ledger.product_sku(index, counts)[3],
        "po_total": lambda: ledger.po_total(index, counts),
        "cases_ordered": lambda: lines.po_line_cases(index),
        "cases_received": lambda: lines.po_line_received(index, counts) if status != "Open"
        else OMIT,  # fmt: skip
        "unit_cost": lambda: ledger.unit_cost(lines.po_line_product(index, counts)),
        "po_line_total": lambda: ledger.po_line_total(index, counts),
        "principal_dr": lambda: f"DR-{text.principal(lines.po_principal(lines.receipt_po(index, counts), counts))[1]}-{30_411 + index * 3:06d}",  # noqa: E501
        "sscc": lambda: f"3{text.principal(0)[3]}{(index * 7_919 + 104_729) % 10**10:010d}",
        "discrepancy_note": lambda: "Short 2 cs on GRN, principal DR says 50, counted 48."
        if status == "Posted with discrepancy" else OMIT,  # fmt: skip
        "lot_no": lambda: text.lot_number(index),
        "expiry_month": lambda: _expiry_month(index, anchor),
        "cases_on_hand": lambda: _lot_cases(index, counts),
        "bin_location": lambda: f"{'ABCDE'[index % 5]}-{index % 12 + 1:02d}-{index % 4 + 1}",
        "system_qty": lambda: _count_quantities(index)[0],
        "counted_qty": lambda: _count_quantities(index)[1] if _count_quantities(index)[1]
        is not None else OMIT,  # fmt: skip
        "variance_pct": lambda: _count_quantities(index)[2] if _count_quantities(index)[2]
        is not None else OMIT,  # fmt: skip
        "adjust_cases": lambda: ledger.adjustment_cases(index),
        "adjust_value": lambda: ledger.adjustment_value(index, counts),
        "return_value": lambda: _return_value(index, counts),
        "drops_planned": lambda: len(links.trip_orders(index, counts)) or OMIT,
        "drops_completed": lambda: (len(links.trip_orders(index, counts))
                                    - links.failed_drops(index, counts)) or OMIT,  # fmt: skip
        "plate_no": lambda: text.plate(index),
        "capacity": lambda: {"Van 1-ton": 150, "Truck 4-wheel": 420, "Truck 6-wheel": 850,
                             "Motorcycle": 12}[links.vehicle_type(index, counts)],  # fmt: skip
        "registration_month": lambda: _registration_month(index),
        "odometer": lambda: 18_000 + rng("vehicles", index, "km").randint(0, 160_000),
        "invoice_amount": lambda: ledger.money(links_finance.invoice(index, counts).amount),
        "invoice_balance": lambda: links_finance.invoice_balance(index, counts),
        "days_past_due": lambda: links_finance.days_past_due(index, counts),
        "receipt_amount": lambda: links_finance.receipt_amount(index, counts),
        "payment_reference": lambda: _payment_reference(index, counts),
        "principal_invoice_no": lambda: text.principal_invoice_no(index),
        "ap_amount": lambda: links_claims.ap_amount(index, counts),
        "claim_period": lambda: _claim_period(dates.filed_on(index, seed, anchor, counts)),
        "claim_amount": lambda: _claim_amount(index, kind),
        "approved_amount": lambda: _claim_amount(index, kind),
    }
    producer = producers.get(kind)
    if producer is None:
        raise ValueError(f"Unsupported distributor field {module}.{kind}")
    return producer()


_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
           "September", "October", "November", "December")  # fmt: skip
_BAND_MONTHS = {"More than 180 days": (7, 18), "91–180 days": (4, 5),
                "31–90 days (near expiry)": (2, 2), "30 days or less": (1, 1),
                "Expired": (-2, -1)}  # fmt: skip


def _expiry_month(lot: int, anchor: date) -> str:
    from operations.sample.packs.fmcg_distributor.values import expiry_band

    low, high = _BAND_MONTHS[expiry_band(lot)]
    months = rng("stock_lots", lot, "expiry").randint(low, high)
    month = anchor.year * 12 + anchor.month - 1 + months
    return f"{month % 12 + 1:02d}/{month // 12}"


def _registration_month(vehicle: int) -> str:
    """The LTO renews a vehicle in the month given by its plate's last digit (0 is October)."""
    last = int(text.plate(vehicle)[-1])
    return _MONTHS[(last or 10) - 1]


def _payment_reference(index: int, counts: Counts) -> Value:
    method = links_finance.receipt_method(index, counts)
    if method in {"Cheque", "Post-dated cheque"}:
        return f"CHK {(index * 7_331 + 200_117) % 1_000_000:06d}"
    if method == "Bank transfer":
        return f"FT{(index * 104_729 + 55_001) % 10**10:010d}"
    if method == "E-wallet":
        return f"Ref {(index * 9_973 + 1_234_567) % 10**13:013d}"
    return OMIT


def _claim_period(filed: date) -> str:
    """Claims cover the month before filing, or the same month late in the month."""
    month = filed.year * 12 + filed.month - 1 - (filed.day < 20)
    return f"{_MONTHS[month % 12]} {month // 12}"
