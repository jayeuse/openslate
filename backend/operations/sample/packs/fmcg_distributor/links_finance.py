"""Invoices, collection receipts and follow-ups: who paid what, planned from indexes only.

Every delivered order and every van sale has one invoice. Cash outlets and van customers
pay at the door; credit outlets pay by cheque, transfer or a statement payment that clears
several invoices. The plan then fits the receipt count of the profile: the newest credit
invoices stay unpaid, or an old payment came in two parts.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache

from operations.sample.packs.fmcg_distributor import ledger, links
from operations.sample.packs.fmcg_distributor.catalog_fields import TERM_DAYS
from operations.sample.packs.fmcg_distributor.links import FOLLOWED_INVOICE, PINNED, SPAN, rng
from operations.sample.packs.fmcg_distributor.realism import STATUS_WEIGHTS
from operations.sample.realism import weighted_label

_TERM_WEIGHTS = {
    "Sari-sari store": {"Cash on delivery": 85, "7 days": 15},
    "Carinderia": {"Cash on delivery": 90, "7 days": 10},
    "Wholesaler or market stall": {"Cash on delivery": 40, "15 days": 35, "30 days": 25},
    "Small grocery": {"Cash on delivery": 35, "7 days": 30, "15 days": 35},
    "Pharmacy or drugstore": {"Cash on delivery": 30, "7 days": 30, "15 days": 40},
    "Minimart": {"7 days": 25, "15 days": 50, "30 days": 25},
    "Supermarket (modern trade)": {"30 days": 100},
}
_PINNED_TERMS = ("15 days", "30 days", "Cash on delivery", "15 days", "30 days")


def outlet_terms(outlet: int) -> str:
    if outlet < len(_PINNED_TERMS):
        return _PINNED_TERMS[outlet]
    if outlet < PINNED:
        return "Cash on delivery"
    return weighted_label(rng("outlets", outlet, "terms"), _TERM_WEIGHTS[links.outlet_channel(
        outlet)])  # fmt: skip


def nominal_day(slot: int, slots: int) -> int:
    """The day of a trip or tour, evenly through the quarter, before the dated jitter."""
    return -SPAN + 1 + (2 * slot + 1) * (SPAN - 3) // (2 * max(1, slots))


@dataclass(frozen=True)
class Invoice:
    kind: str  # order or van
    source: int  # the order or the route tour
    outlet: int
    terms: str
    day: int  # nominal invoice day, in days from the anchor date
    amount: float
    voided: bool

    @property
    def due(self) -> int:
        return self.day + TERM_DAYS[self.terms]


_KEYS = ("sales_orders", "order_lines", "products", "principals", "store_visits",
         "route_tours", "delivery_trips", "sales_invoices", "collection_receipts", "beats",
         "outlets")  # fmt: skip


def _counts_key(counts: Mapping[str, int]) -> tuple[int, ...]:
    return links._key(counts, *_KEYS)


@lru_cache(maxsize=8)
def _invoices(key: tuple[int, ...]) -> tuple[Invoice, ...]:
    counts = dict(zip(_KEYS, key, strict=True))
    delivered = links.delivered_orders(counts["sales_orders"])
    if len(delivered) > counts["sales_invoices"]:
        raise ValueError("Every delivered order needs an invoice")
    found = []
    for order in delivered:
        trip = links.order_trips(order, counts)[-1]
        outlet = links.order_outlet(order, counts)
        found.append(Invoice("order", order, outlet, outlet_terms(outlet),
                             nominal_day(trip, counts["delivery_trips"]),
                             float(ledger.delivered_value(order, counts)), False))
    tours = links.worked_tours(counts)
    vans = counts["sales_invoices"] - len(delivered)
    for position in range(vans):
        index = len(found)
        tour, place = links._split(position, vans, tours)
        visits = links.tour_van_visits(tour, counts)
        first_visit = links.presell_visit_count(counts) + sum(
            links.tour_van_visits(item, counts) for item in tours[: tours.index(tour)])
        outlet = links.visit_outlet(first_visit + place % max(1, visits), counts)
        terms = "7 days" if index >= PINNED and rng("van", index, "terms").random() < 0.1 else (
            "Cash on delivery")  # fmt: skip
        voided = index >= PINNED and index % 97 == 13
        found.append(Invoice("van", tour, outlet, terms,
                             nominal_day(tour, counts["route_tours"]),
                             float(ledger.van_sale(index)), voided))
    return tuple(found)


def invoices(counts: Mapping[str, int]) -> tuple[Invoice, ...]:
    return _invoices(_counts_key(counts))


def invoice(index: int, counts: Mapping[str, int]) -> Invoice:
    return invoices(counts)[index]


@dataclass(frozen=True)
class Receipt:
    invoices: tuple[int, ...]
    part: str  # full, partial, first or second
    kind: str  # door, credit or statement
    day: int


def _receipt_day(bill: Invoice, part: str, kind: str) -> int:
    if kind == "door":
        return bill.day
    day = {"partial": bill.day + 10, "first": bill.due - 3, "second": bill.due + 11}.get(
        part, bill.due)  # fmt: skip
    return max(bill.day, min(day, -1))


def _plan(bills: tuple[Invoice, ...]) -> list[Receipt]:
    singles: list[Receipt] = []
    for index, bill in enumerate(bills):
        if bill.voided or index in {3, FOLLOWED_INVOICE}:
            continue
        if index == 0:
            singles.append(Receipt((0,), "partial", "credit", _receipt_day(bill, "partial", "")))
            continue
        if bill.terms == "Cash on delivery":
            singles.append(Receipt((index,), "full", "door", bill.day))
            continue
        draw = rng("plan", index).random()
        if index < PINNED:
            parts: tuple[str, ...] = ("full",)
        elif bill.due >= -3:
            parts = ("full",) if draw < 0.25 else ()
        else:
            parts = () if draw < 0.06 else ("partial",) if draw < 0.12 else (
                ("first", "second") if draw < 0.18 else ("full",))  # fmt: skip
        singles.extend(Receipt((index,), part, "credit", _receipt_day(bill, part, "credit"))
                       for part in parts)  # fmt: skip
    return _statements(bills, singles)


def _statements(bills: tuple[Invoice, ...], singles: list[Receipt]) -> list[Receipt]:
    """A credit outlet often settles two or three invoices with one statement payment."""
    by_outlet: dict[int, list[Receipt]] = {}
    kept: list[Receipt] = []
    for receipt in singles:
        index = receipt.invoices[0]
        if receipt.kind == "credit" and receipt.part == "full" and index >= PINNED:
            by_outlet.setdefault(bills[index].outlet, []).append(receipt)
        else:
            kept.append(receipt)
    for outlet, group in by_outlet.items():
        if len(group) < 2 or rng("statement", outlet).random() >= 0.7:
            kept.extend(group)
            continue
        for start in range(0, len(group), 3):
            chunk = group[start : start + 3]
            members = tuple(item.invoices[0] for item in chunk)
            kept.append(Receipt(members, "full", "statement", max(item.day for item in chunk))
                        if len(chunk) > 1 else chunk[0])  # fmt: skip
    return kept


def _fit(bills: tuple[Invoice, ...], receipts: list[Receipt], total: int) -> list[Receipt]:
    """Match the profile's receipt count without touching the named cases."""
    pinned = [item for item in receipts if min(item.invoices) < PINNED]
    rest = sorted((item for item in receipts if min(item.invoices) >= PINNED),
                  key=lambda item: (item.day, item.invoices))  # fmt: skip
    for kinds in (("credit", "statement"), ("door",)):
        while len(pinned) + len(rest) > total:
            newest = next((item for item in reversed(rest) if item.kind in kinds), None)
            if newest is None:
                break
            rest.remove(newest)
    while len(pinned) + len(rest) < total:
        old = next((item for item in rest if item.kind == "credit" and item.part == "full"),
                   None) or next((item for item in rest if item.kind == "statement"), None)
        if old is None:
            raise ValueError("The receipt plan cannot reach the profile's receipt count")
        position = rest.index(old)
        if old.kind == "statement":
            split = [Receipt((member,), "full", "credit", old.day) for member in old.invoices]
        else:
            day = old.day
            early = max(bills[old.invoices[0]].day, day - 14)
            split = [Receipt(old.invoices, "first", "credit", early),
                     Receipt(old.invoices, "second", "credit", day)]  # fmt: skip
        rest[position : position + 1] = split
    if len(pinned) + len(rest) != total:
        raise ValueError("The receipt plan cannot reach the profile's receipt count")
    first = [item for item in pinned if item.invoices == (0,)]
    others = sorted([item for item in pinned if item.invoices != (0,)] + rest,
                    key=lambda item: (item.day, item.invoices, item.part))  # fmt: skip
    return first + others


@lru_cache(maxsize=8)
def _receipts(key: tuple[int, ...]) -> tuple[Receipt, ...]:
    bills = _invoices(key)
    total = dict(zip(_KEYS, key, strict=True))["collection_receipts"]
    return tuple(_fit(bills, _plan(bills), total))


def receipts(counts: Mapping[str, int]) -> tuple[Receipt, ...]:
    return _receipts(_counts_key(counts))


def receipt(index: int, counts: Mapping[str, int]) -> Receipt:
    return receipts(counts)[index]


def receipt_method(index: int, counts: Mapping[str, int]) -> str:
    item = receipt(index, counts)
    if index == 0:
        return "Cheque"
    draw = rng("collection_receipts", index, "method")
    if item.kind == "door":
        return "E-wallet" if draw.random() < 0.1 else "Cash"
    return weighted_label(draw, {"Cheque": 35, "Bank transfer": 30, "Post-dated cheque": 25,
                                 "Cash": 5, "E-wallet": 5})  # fmt: skip


def receipt_status(index: int, counts: Mapping[str, int]) -> str:
    if index < PINNED:
        return "Cleared"
    state = weighted_label(rng("collection_receipts", index, "status"),
                           STATUS_WEIGHTS["collection_receipts"])  # fmt: skip
    method = receipt_method(index, counts)
    if state == "Bounced" and method not in {"Cheque", "Post-dated cheque"}:
        state = "Cleared"
    if state == "Cleared" and receipt(index, counts).day >= -3:
        state = "Deposited" if method != "Cash" else "Remitted"
    return state


def receipt_amount(index: int, counts: Mapping[str, int]) -> int | float:
    item = receipt(index, counts)
    bills = invoices(counts)
    amount = sum(bills[member].amount for member in item.invoices)
    if item.part == "full":
        return ledger.money(amount)
    if index == 0 or item.invoices == (0,):
        return ledger.SCENARIO_PAYMENT
    if item.part == "partial":
        share = rng("collection_receipts", index, "share").uniform(0.35, 0.65)
        return _part(amount, share)
    first = _part(amount, 0.5)
    return first if item.part == "first" else ledger.money(amount - float(first))


def _part(amount: float, share: float) -> int | float:
    step = 100 if amount >= 1_000 else 10
    part = max(step, round(amount * share / step) * step)
    return ledger.money(part if part < amount else amount / 2)


@lru_cache(maxsize=8)
def _paid(key: tuple[int, ...]) -> tuple[float, ...]:
    counts = dict(zip(_KEYS, key, strict=True))
    paid = [0.0] * counts["sales_invoices"]
    for index, item in enumerate(_receipts(key)):
        if receipt_status(index, counts) in {"Bounced", "Voided"}:
            continue
        if len(item.invoices) == 1:
            paid[item.invoices[0]] += float(receipt_amount(index, counts))
        else:
            for member in item.invoices:
                paid[member] += _invoices(key)[member].amount
    return tuple(paid)


@lru_cache(maxsize=8)
def _invoice_receipts(key: tuple[int, ...]) -> dict[int, tuple[int, ...]]:
    found: dict[int, list[int]] = {}
    for index, item in enumerate(_receipts(key)):
        for member in item.invoices:
            found.setdefault(member, []).append(index)
    return {member: tuple(value) for member, value in found.items()}


def invoice_receipts(index: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _invoice_receipts(_counts_key(counts)).get(index, ())


def invoice_balance(index: int, counts: Mapping[str, int]) -> int | float:
    bill = invoice(index, counts)
    if bill.voided:
        return 0
    if index == 0:
        return ledger.SCENARIO_BALANCE
    return ledger.money(max(0.0, bill.amount - _paid(_counts_key(counts))[index]))


def invoice_status(index: int, counts: Mapping[str, int]) -> str:
    bill = invoice(index, counts)
    if bill.voided:
        return "Voided"
    balance = float(invoice_balance(index, counts))
    if balance <= 0:
        return "Paid"
    if balance < bill.amount:
        return "Partially paid"
    if index in {3, FOLLOWED_INVOICE}:
        return "Overdue"
    if bill.due >= -7:
        return "Open"
    draw = rng("sales_invoices", index, "unpaid").random()
    if draw < 0.08:
        return "Disputed"
    return "Written off" if draw < 0.11 and bill.due < -45 else "Overdue"


def days_past_due(index: int, counts: Mapping[str, int]) -> int:
    """The stored counter, which the collector updates now and then (plan rule 6)."""
    pinned = {3: 12, FOLLOWED_INVOICE: 33}.get(index)
    if pinned is not None:
        return pinned
    bill = invoice(index, counts)
    if invoice_status(index, counts) in {"Paid", "Voided", "Open"} or bill.due >= 0:
        return 0
    return max(0, -bill.due - rng("sales_invoices", index, "lag").randint(0, 6))


@lru_cache(maxsize=8)
def _touches(key: tuple[int, ...]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Credit invoices a collector calls about: paid after the call, or still unpaid."""
    counts = dict(zip(_KEYS, key, strict=True))
    paid: list[int] = []
    unpaid: list[int] = []
    for index, bill in enumerate(_invoices(key)):
        if index < PINNED or bill.terms == "Cash on delivery" or bill.due >= -12:
            continue
        state = invoice_status(index, counts)
        if state in {"Overdue", "Disputed", "Written off", "Partially paid"}:
            unpaid.append(index)
        elif state == "Paid":
            paid.append(index)
    return tuple(paid), tuple(unpaid)


def followup_invoice(followup: int, counts: Mapping[str, int]) -> int:
    paid, unpaid = _touches(_counts_key(counts))
    if followup == 0 or not (paid or unpaid):
        return FOLLOWED_INVOICE
    draw = rng("collection_followups", followup, "invoice")
    pool = paid if paid and (not unpaid or draw.random() < 0.62) else unpaid
    return pool[draw.randrange(len(pool))]


def followup_round(followup: int, counts: Mapping[str, int]) -> int:
    """How many earlier follow-ups the same invoice had (0 for the first call)."""
    target = followup_invoice(followup, counts)
    return sum(followup_invoice(item, counts) == target for item in range(followup))


def followup_status(followup: int, counts: Mapping[str, int]) -> str:
    if followup == 0:
        return "Promise to pay"
    state = invoice_status(followup_invoice(followup, counts), counts)
    if state == "Paid":
        return "Paid"
    if state == "Written off":
        return "Closed – uncollectible"
    if state == "Disputed":
        return "Escalated"
    return weighted_label(rng("collection_followups", followup, "status"),
                          {"Promise to pay": 50, "Open": 30, "Escalated": 20})  # fmt: skip
