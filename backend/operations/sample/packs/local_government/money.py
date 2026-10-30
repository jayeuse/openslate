"""Peso amounts: assessments, installments, obligations, vouchers and the procurement chain.

Amounts never use the seed: a receipt repeats its order's installment and a voucher its
obligation's amount, so both sides must agree for every run (as Clinic's ledger does).
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.local_government import links, text
from operations.sample.packs.local_government import links_finance as finance
from operations.sample.packs.local_government.links import PINNED
from operations.sample.packs.local_government.realism import (
    ABC,
    APPROPRIATED,
    DECLARED_GROSS,
    ESTIMATED_COST,
    OTHER_OBLIGATION,
    PAYROLL,
    TRAVEL,
    UTILITIES,
)
from operations.sample.realism import AmountShape, long_tail_amount

# The named case: a first-quarter installment on a business tax order of payment.
SCENARIO_DUE = 32_400
SCENARIO_PAID = 8_100
SCENARIO_BALANCE = SCENARIO_DUE - SCENARIO_PAID
_PINNED_ABC = (150_000, 85_000, 1_500_000, 420_000, 96_000, 1_250_000, 64_500, 310_000,
               45_000, 780_000)  # fmt: skip


def cents(value: float) -> int | float:
    value = round(value, 2)
    return int(value) if float(value).is_integer() else value


def _rng(*parts: object) -> random.Random:
    return random.Random("lg:" + ":".join(map(str, parts)))


def _tail(shape: AmountShape, *parts: object) -> float:
    return float(long_tail_amount(_rng(*parts), shape))


def declared_gross(app: int, counts: Mapping[str, int]) -> int | float:
    value = _tail(DECLARED_GROSS, "gross", app)
    if links.application_type(app, counts) == "New":
        value *= 0.3  # A new business declares its capital, not a year of sales.
    return cents(value)


def estimated_cost(permit: int) -> int | float:
    return cents(_tail(ESTIMATED_COST, "cost", permit))


def _fees(*parts: object) -> float:
    rng = _rng("fees", *parts)
    return rng.choice((1_500, 2_000, 2_500, 3_000, 5_000)) + rng.choice((600, 1_200, 2_400)) + 300


def amount_due(order: int, counts: Mapping[str, int]) -> int | float:
    """The assessment: business tax on gross sales, or fees on the building's cost."""
    if order == 0:
        return SCENARIO_DUE
    source = links.oop_source(order)
    rng = _rng("rate", order)
    app = finance.oop_application(order, counts)
    if app is not None:
        gross = float(declared_gross(app, counts))
        return cents(gross * rng.uniform(0.005, 0.015) + _fees("business", order))
    permit = finance.oop_permit(order, counts)
    if permit is not None:
        cost = float(estimated_cost(permit))
        if source == "Occupancy":
            return cents(cost * 0.001 + 1_000)
        return cents(cost * rng.uniform(0.006, 0.012) + _fees("building", order))
    if source == "Civil registry":
        return rng.choice((330, 500, 1_000))
    if source == "Real property tax":
        return cents(_tail(AmountShape(8_500, sigma=1.0, cents_share=0.9), "rpt", order))
    return cents(rng.uniform(200, 5_000))


def surcharge(order: int, counts: Mapping[str, int]) -> int | float:
    """25% and 2% a month on a late renewal's business tax (LGC §168)."""
    app = finance.oop_application(order, counts)
    if order < PINNED or app is None or order % 9 != 4:
        return 0
    if links.application_type(app, counts) != "Renewal":
        return 0
    return cents(float(amount_due(order, counts)) * (0.25 + 0.02 * (1 + order % 5)))


@lru_cache(maxsize=65_536)
def _parts(order: int, frozen: tuple[tuple[str, int], ...]) -> tuple[int | float, ...]:
    counts = dict(frozen)
    total = float(amount_due(order, counts)) + float(surcharge(order, counts))
    planned = finance.amount_installment(order)
    share = cents(total / planned)
    return (*([share] * (planned - 1)), cents(total - float(share) * (planned - 1)))


def installment(order: int, step: int, counts: Mapping[str, int]) -> int | float:
    return _parts(order, tuple(sorted(counts.items())))[step]


def paid_to_date(order: int, counts: Mapping[str, int]) -> int | float:
    paid = links.paid_installments(order, counts)
    return cents(sum(float(installment(order, step, counts)) for step in range(paid)))


def balance(order: int, counts: Mapping[str, int], status: str) -> int | float:
    if status in {"Reassessed", "Cancelled"}:
        return 0
    total = float(amount_due(order, counts)) + float(surcharge(order, counts))
    return cents(total - float(paid_to_date(order, counts)))


def receipt_amount(receipt: int, counts: Mapping[str, int]) -> int | float:
    slot = links.receipt_slot(receipt, counts)
    if slot is None:  # A certification or community tax paid at the window.
        return _rng("walk-in", receipt).choice((50, 100, 130, 150, 200, 330))
    return installment(*slot, counts)


# Procurement and obligations.


def abc(request: int) -> int | float:
    """The item's usual budget, scaled by this request's quantities (a long tail overall)."""
    if request < PINNED:
        return _PINNED_ABC[request]
    shape = AmountShape(text.item_budget(request), sigma=ABC.sigma,
                        round_share=ABC.round_share, minimum=ABC.minimum)  # fmt: skip
    return cents(_tail(shape, "abc", request))


def project_abc(project: int, counts: Mapping[str, int]) -> int | float:
    requests = finance.project_requests(project, counts)
    if not requests:
        return cents(_tail(ABC, "project-abc", project))
    return cents(sum(float(abc(item)) for item in requests))


def _bid_ratio(bid: int, counts: Mapping[str, int]) -> float:
    project = finance.bid_project(bid, counts)
    winner = _rng("winner", project).uniform(0.86, 0.97)
    rank = finance.bid_rank(bid, counts)
    if rank == 1:
        return winner
    return min(0.999, winner + 0.012 * rank + _rng("bid", bid).uniform(0.0, 0.05))


def bid_amount(bid: int, counts: Mapping[str, int]) -> int | float:
    project = finance.bid_project(bid, counts)
    return cents(float(project_abc(project, counts)) * _bid_ratio(bid, counts))


def po_amount(po: int, counts: Mapping[str, int]) -> int | float:
    project = finance.po_project(po, counts)
    winner = finance.project_bids(project, counts)[0]
    _lot, lots = finance.po_lot(po, counts)
    return cents(float(bid_amount(winner, counts)) / lots)


def obr_amount(obr: int, counts: Mapping[str, int]) -> int | float:
    po = finance.obr_po(obr, counts)
    if po is not None:
        return po_amount(po, counts)
    shape = {"Payroll": PAYROLL, "Utilities": UTILITIES, "Travel": TRAVEL}.get(
        finance.obr_kind(obr, counts), OTHER_OBLIGATION
    )
    return cents(_tail(shape, "obr", obr))


def appropriated(appropriation: int) -> int | float:
    return cents(_tail(APPROPRIATED, "appropriation", appropriation))


_TAX_RATES = {"Purchase order": 0.06, "Payroll": 0.1, "Other": 0.07}


def dv_gross(dv: int, counts: Mapping[str, int]) -> int | float:
    obr = finance.dv_obligation(dv, counts)
    _part, parts = finance.dv_part(dv, counts)
    return cents(float(obr_amount(obr, counts)) / parts)


def dv_tax(dv: int, counts: Mapping[str, int]) -> int | float:
    kind = finance.obr_kind(finance.dv_obligation(dv, counts), counts)
    return cents(float(dv_gross(dv, counts)) * _TAX_RATES.get(kind, 0.0))


def dv_net(dv: int, counts: Mapping[str, int]) -> int | float:
    return cents(float(dv_gross(dv, counts)) - float(dv_tax(dv, counts)))
