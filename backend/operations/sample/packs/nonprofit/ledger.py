"""Foundation money: gifts and pledge balances, grants, budgets, advances and payments.

Amounts do not use the run's seed: a pledge balance, a liquidation or a voucher repeats the
amounts of other records, so both sides agree in every run. Named cases stay exact.
"""

from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.nonprofit import links
from operations.sample.packs.nonprofit import links_finance as finance
from operations.sample.packs.nonprofit.catalog_fields import AWARDED
from operations.sample.packs.nonprofit.links import rng, status
from operations.sample.packs.nonprofit.realism import (
    ADVANCE,
    BUDGET_LINE,
    EXPENSE,
    FUND,
    GIFT,
    GRANT_REQUEST,
    IN_KIND,
    MONTHLY_TIERS,
    OTHER_PAYMENT,
    PLEDGE,
    REQUEST,
)
from operations.sample.realism import AmountShape, long_tail_amount, weighted_label

# The named cases: Pledge 1 settled in part by Donation 1, and Cash Advance 1 liquidated
# in part by Expense Lines 1 to 3.
PLEDGE_TOTAL, PLEDGE_PAYMENT = 120_000, 30_000
ADVANCE_RELEASED, ADVANCE_LINES = 25_000, (9_500, 6_000, 3_250)


def money(value: float) -> int | float:
    value = round(value, 2)
    return int(value) if float(value).is_integer() else value


def _tail(shape: AmountShape, *parts: object) -> float:
    return float(long_tail_amount(rng(*parts), shape))


# Resource Mobilization.


def pledge_total(pledge: int, counts: Mapping[str, int]) -> int:
    if pledge == 0:
        return PLEDGE_TOTAL
    if pledge == 1:
        return 75_000
    unit = 100 * links.installments(pledge, counts)
    return max(unit, round(_tail(PLEDGE, "pledges", pledge, "total") / unit) * unit)


def installment_amount(pledge: int, counts: Mapping[str, int]) -> int:
    return pledge_total(pledge, counts) // links.installments(pledge, counts)


def pledge_paid(pledge: int, counts: Mapping[str, int]) -> int:
    return links.paid_installments(pledge, counts) * installment_amount(pledge, counts)


def pledge_balance(pledge: int, counts: Mapping[str, int]) -> int:
    return pledge_total(pledge, counts) - pledge_paid(pledge, counts)


def gift_type(donation: int, counts: Mapping[str, int]) -> str:
    if links.pledge_slot(donation, counts) is not None:
        return "Pledge payment"
    weights = {"One-time": 70, "Recurring installment": 22, "Matching gift": 5, "In-kind": 3}
    return weighted_label(rng("donations", donation, "gift-type"), weights)


def donation_amount(donation: int, counts: Mapping[str, int]) -> int | float:
    slot = links.pledge_slot(donation, counts)
    if slot is not None:
        return installment_amount(slot[0], counts)
    kind = gift_type(donation, counts)
    if kind == "Recurring installment":
        return rng("donations", donation, "tier").choice(MONTHLY_TIERS)
    return money(_tail(IN_KIND if kind == "In-kind" else GIFT, "donations", donation, "amount"))


@lru_cache(maxsize=16)
def _raised(frozen: links.Counts) -> dict[int, float]:
    counts = dict(frozen)
    raised: dict[int, float] = {}
    for donation in range(counts["donations"]):
        campaign = links.donation_campaign(donation, counts)
        if campaign is None or status("donations", donation, counts) not in {"Posted",
                                                                               "Received"}:
            continue
        raised[campaign] = raised.get(campaign, 0.0) + float(donation_amount(donation, counts))
    return raised


def campaign_raised(campaign: int, counts: Mapping[str, int]) -> int | float:
    keep = ("donations", "pledges", "campaigns", "donors")
    return money(_raised(tuple(sorted((key, counts[key]) for key in keep))).get(campaign, 0.0))


def campaign_goal(campaign: int) -> int:
    return int(round(_tail(PLEDGE, "campaigns", campaign, "goal") * 20, -4)) or 500_000


# Grants and Partnerships.


def amount_requested(grant: int) -> int:
    if grant == 0:
        return 3_200_000
    return int(round(_tail(GRANT_REQUEST, "grant_awards", grant, "requested"), -3))


def amount_awarded(grant: int, counts: Mapping[str, int]) -> int | None:
    if status("grant_awards", grant, counts) not in links.AWARDED_STAGES:
        return None
    if grant == 0:
        return 3_000_000
    share = rng("grant_awards", grant, "awarded").uniform(0.8, 1.0)
    return int(round(amount_requested(grant) * share, -4))


def line_approved(line: int) -> int:
    return int(round(_tail(BUDGET_LINE, "budget_lines", line, "approved"), -2))


def burn_rate(line: int, counts: Mapping[str, int]) -> float:
    if line == 3:
        return 85.0  # The live input raises it past the 90% alert.
    stage = status("grant_awards", links.budget_line_grant(line, counts), counts)
    draw = rng("budget_lines", line, "burn")
    if stage == "Closed":
        return round(draw.uniform(92, 101), 1)
    if stage == AWARDED:
        return round(draw.uniform(0, 5), 1)
    return round(draw.uniform(15, 97), 1)


def line_actual(line: int, counts: Mapping[str, int]) -> int | float:
    return money(line_approved(line) * burn_rate(line, counts) / 100)


def line_committed(line: int) -> int:
    return int(round(line_approved(line) * rng("budget_lines", line, "committed").uniform(0, 0.12),
                     -2))  # fmt: skip


# Finance.


def advance_released(advance: int) -> int:
    if advance == 0:
        return ADVANCE_RELEASED
    if advance == 3:
        return 12_000
    return int(_tail(ADVANCE, "cash_advances", advance, "released"))


def _liquidated_cents(advance: int, counts: Mapping[str, int]) -> int:
    if advance == 0:
        return sum(ADVANCE_LINES) * 100
    if advance == 3:
        return 740_000
    released = advance_released(advance) * 100
    state = status("cash_advances", advance, counts)
    draw = rng("cash_advances", advance, "liquidated")
    if state in {"Closed", "Fully liquidated"}:
        return released
    if state == "Refund due":
        return int(released * draw.uniform(0.85, 0.95))
    if state in {"Partially liquidated", "Overdue"}:
        return int(released * draw.uniform(0.3, 0.8))
    return 0


@lru_cache(maxsize=4_096)
def _line_parts(advance: int, frozen: links.Counts) -> tuple[int, ...]:
    """The receipts (in centavos) that add up to what the custodian liquidated."""
    counts = dict(frozen)
    if advance == 0:
        return tuple(amount * 100 for amount in ADVANCE_LINES)
    total = _liquidated_cents(advance, counts)
    lines = finance.liquidated_lines(advance, counts)
    if lines == 0:
        return ()
    draw = rng("cash_advances", advance, "parts")
    weights = [draw.uniform(0.4, 1.6) for _ in range(lines)]
    parts = [int(total * weight / sum(weights)) for weight in weights[:-1]]
    return (*parts, total - sum(parts))


def _parts(advance: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    keep = ("cash_advances", "expense_lines")
    return _line_parts(advance, tuple(sorted((key, counts[key]) for key in keep)))


def advance_liquidated(advance: int, counts: Mapping[str, int]) -> int | float:
    return money(sum(_parts(advance, counts)) / 100)


def advance_balance(advance: int, counts: Mapping[str, int]) -> int | float:
    return money(advance_released(advance) - float(advance_liquidated(advance, counts)))


def expense_amount(line: int, counts: Mapping[str, int]) -> int | float:
    slot = finance.expense_slot(line, counts)
    if slot is not None:
        return money(_parts(slot[0], counts)[slot[1]] / 100)
    return money(_tail(EXPENSE, "expense_lines", line, "amount"))


def request_estimate(request: int) -> int:
    return int(_tail(REQUEST, "purchase_requests", request, "estimate"))


def order_amount(order: int, counts: Mapping[str, int]) -> int | float:
    request = finance.order_request(order, counts)
    estimate = request_estimate(0 if request is None else request)
    share = rng("purchase_orders", order, "price").uniform(0.82, 1.03)
    if finance.lot_number(order, counts) > 1:
        share *= 0.4  # A second, smaller lot of the same request.
    return money(estimate * share)


def disbursement_amount(voucher: int, counts: Mapping[str, int]) -> int | float:
    kind, parent = finance.disbursement_kind(voucher, counts)
    if kind == "advance" and parent is not None:
        return advance_released(parent)
    if kind == "order" and parent is not None:
        return order_amount(parent, counts)
    return money(_tail(OTHER_PAYMENT, "disbursements", voucher, "amount"))


def fund_budget(fund: int, counts: Mapping[str, int]) -> int:
    grant = links.fund_grant(fund, counts)
    if grant is not None:
        return amount_awarded(grant, counts) or amount_requested(grant)
    return int(round(_tail(FUND, "funds", fund, "budget"), -4))


def fund_spent(fund: int, counts: Mapping[str, int]) -> int | float:
    state = status("funds", fund, counts)
    budget = fund_budget(fund, counts)
    if state in {"Fully spent", "Closed"}:
        return budget
    if state == "Open":
        return 0
    return money(budget * rng("funds", fund, "spent").uniform(0.2, 0.85))
