"""Each record's business dates, after the dates of the records it follows (spec R3)."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import date, timedelta
from functools import lru_cache

from operations.sample.packs.nonprofit import dates, links
from operations.sample.packs.nonprofit import links_finance as finance
from operations.sample.packs.nonprofit.catalog_fields import AWARDED
from operations.sample.packs.nonprofit.dates import SPAN, after, ahead, floor, pick, work_day
from operations.sample.packs.nonprofit.links import Counts, status
from operations.sample.packs.nonprofit.realism import holidays

_FREQUENCY_DAYS = {"Monthly": 30, "Quarterly": 91, "Semiannual": 182, "Annual": 365}
_PERIOD_MONTHS = {"Monthly": 1, "Quarterly": 3, "Semiannual": 6, "Annual": 6}


def business_day(module_key: str, field_key: str, index: int, seed: int, anchor: date,
                 counts: Mapping[str, int]) -> date | None:  # fmt: skip
    return _day(module_key, field_key, index, seed, anchor, links._frozen(counts))


def before(day: date, key: str, low: int, high: int, anchor: date) -> date:
    """A working day a few days before ``day``, inside the twelve months."""
    earlier = floor(day - timedelta(days=links.rng(key).randint(low, high)), anchor)
    step = 1
    while earlier.weekday() >= 5 or earlier in holidays(anchor):
        if earlier >= day:
            step = -1
        earlier += timedelta(days=step)
    return floor(min(earlier, day), anchor)


@lru_cache(maxsize=262_144)
def _day(module_key: str, field_key: str, index: int, seed: int, anchor: date, frozen: Counts
         ) -> date | None:  # fmt: skip
    counts = dict(frozen)
    rule = _RULES.get(module_key)
    key = f"{seed}:{module_key}:{index}:{field_key}"
    if rule is None:
        return work_day(pick(module_key, index, seed, anchor, (-SPAN, 0)), anchor)
    return rule(field_key, index, seed, anchor, counts, key)


def _main(module_key: str, index: int, seed: int, anchor: date, window: tuple[int, int]
          ) -> date:  # fmt: skip
    return work_day(pick(module_key, index, seed, anchor, window), anchor)


def _campaign(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
              key: str) -> date | None:  # fmt: skip
    state = status("campaigns", index, counts)
    window = {"Planned": (5, 60), "Active": (-90, -5)}.get(state, (-SPAN, -60))
    start = _main("campaigns", index, seed, anchor, window)
    if field == "starts_on":
        return start
    if state == "Cancelled":
        return None
    return after(start, key, 20, 60, anchor) if state == "Closed" else ahead(start, key, 30, 80,
                                                                              anchor)


def _pledge_date(index: int, seed: int, anchor: date, counts: dict[str, int]) -> date:
    paid = links.paid_count(index, counts)
    frequency = links.frequency(links.installments(index, counts))
    if paid == 0:
        return _main("pledges", index, seed, anchor, (-120, -1))
    latest = anchor - timedelta(days=(paid - 1) * _FREQUENCY_DAYS[frequency] + 7)
    picked = pick("pledges", index, seed, anchor, (-SPAN, -1))
    return work_day(min(picked, latest), anchor)


def _pledge(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
            key: str) -> date | None:  # fmt: skip
    pledged = _pledge_date(index, seed, anchor, counts)
    return pledged if field == "pledge_date" else ahead(pledged, key, 7, 30, anchor)


def _donation(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
              key: str) -> date | None:  # fmt: skip
    slot = links.pledge_slot(index, counts)
    if slot is not None:
        pledge, step = slot
        frequency = links.frequency(links.installments(pledge, counts))
        due = _pledge_date(pledge, seed, anchor, counts) + timedelta(
            days=step * _FREQUENCY_DAYS[frequency])
        given = after(min(due, anchor), f"{seed}:donations:{index}:gift", 0, 5, anchor)
    else:
        given = _main("donations", index, seed, anchor, (-SPAN, 0))
    if field == "gift_date":
        return given
    from operations.sample.packs.nonprofit.values import acknowledgement

    if acknowledgement(index, counts, status("donations", index, counts)) != "Acknowledged":
        return None
    return after(given, key, 1, 10, anchor)  # acknowledged_on


def _grant(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
           key: str) -> date | None:  # fmt: skip
    state = status("grant_awards", index, counts)
    if state not in links.AWARDED_STAGES:
        return None
    if field == "start_on":
        window = (10, 60) if state == AWARDED else (-SPAN, -30)
        return _main("grant_awards", index, seed, anchor, window)
    if state == "Closed":
        return None
    return _main("grant_awards", index, seed + 1, anchor, (5, 85))  # next_report_due


_REPORTED = frozenset({"Accepted", "Submitted", "Revision requested", "Overdue"})


def _report(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
            key: str) -> date | None:  # fmt: skip
    state = status("grant_reports", index, counts)
    window = (-SPAN + 20, -3) if state in _REPORTED else (5, 85)
    due = _main("grant_reports", index, seed, anchor, window)
    if field == "due_on":
        return due
    if field == "period_end":
        return floor(due - timedelta(days=30 + index % 60), anchor)
    if state in {"Overdue", "Not started", "In preparation", "Internal review"}:
        return None
    return before(due, key, 0, 12, anchor)  # submitted_on


def _activity(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
              key: str) -> date | None:  # fmt: skip
    state = status("activities", index, counts)
    if state == "Ongoing":
        planned = dates.last_working_day(anchor)
    else:
        window = (1, 60) if state in {"Planned", "Scheduled"} else (-SPAN, -1)
        planned = _main("activities", index, seed, anchor, window)
    if field == "planned_on":
        return planned
    if state == "Completed":
        return after(planned, key, 0, 2, anchor)
    return planned if state == "Ongoing" else None


def _assistance(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
                key: str) -> date | None:  # fmt: skip
    beneficiary = links.assistance_beneficiary(index, counts)
    registered = business_day("beneficiaries", "registered_on", beneficiary, seed, anchor, counts)
    assert registered is not None
    activity = links.assistance_activity(index, counts)
    if activity is not None:
        held = business_day("activities", "actual_on", activity, seed, anchor, counts)
        if held is not None and held >= registered:
            return held
    return after(registered, key, 1, 21, anchor)


def _result(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
            key: str) -> date | None:  # fmt: skip
    indicator, rank = links.result_slot(index, counts)
    months = _PERIOD_MONTHS.get(links.indicator_frequency(indicator), 3)
    ends = dates.quarter_ends(anchor, months) or (anchor - timedelta(days=30),)
    ended = ends[min(rank, len(ends) - 1)]
    if field == "period_end":
        return ended
    if status("indicator_results", index, counts) == "Draft":
        return None
    return after(ended, key, 5, 25, anchor)


def _feedback(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
              key: str) -> date | None:  # fmt: skip
    if index == 0:  # The disputed distribution on Assistance 5.
        disputed = business_day("assistance", "delivered_on", links.DISPUTED_ASSISTANCE, seed,
                                anchor, counts)  # fmt: skip
        return after(disputed or anchor, key, 0, 3, anchor)
    return _main("feedback_cases", index, seed, anchor, (-SPAN, 0))


def _fund(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
          key: str) -> date | None:  # fmt: skip
    grant = links.fund_grant(index, counts)
    if grant is None:
        return _main("funds", index, seed, anchor, (-SPAN, -30))
    started = business_day("grant_awards", "start_on", grant, seed, anchor, counts)
    if started is None or started > anchor:
        return _main("funds", index, seed, anchor, (-14, 0))
    return after(started, key, 0, 15, anchor)


_RELEASE_WINDOWS = {"Released": (-28, -1), "Partially liquidated": (-45, -5),
                    "Overdue": (-120, -35)}  # fmt: skip


def advance_released_on(index: int, seed: int, anchor: date, counts: Mapping[str, int]
                        ) -> date | None:  # fmt: skip
    state = status("cash_advances", index, counts)
    if state not in links.RELEASED:
        return None
    window = _RELEASE_WINDOWS.get(state, (-SPAN + 10, -40))
    return _main("cash_advances", index, seed, anchor, window)


def _advance(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
             key: str) -> date | None:  # fmt: skip
    released = advance_released_on(index, seed, anchor, counts)
    if field == "released_on":
        return released
    if field == "liquidation_due":
        return None if released is None else ahead(released, key, 30, 30, anchor)
    if released is not None:
        return before(released, key, 1, 5, anchor)  # requested_on
    state = status("cash_advances", index, counts)
    window = (-SPAN, -5) if state == "Rejected" else (-10, 0)
    return _main("cash_advances", index, seed, anchor, window)


def _expense(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
             key: str) -> date | None:  # fmt: skip
    advance = finance.expense_advance(index, counts)
    released = None if advance is None else advance_released_on(advance, seed, anchor, counts)
    if released is None:
        return _main("expense_lines", index, seed, anchor, (-SPAN, 0))
    return after(released, key, 1, 25, anchor)


def _request(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
             key: str) -> date | None:  # fmt: skip
    window = (-SPAN, -20) if finance.request_converted(index) else (-SPAN, 0)
    requested = _main("purchase_requests", index, seed, anchor, window)
    return requested if field == "requested_on" else ahead(requested, key, 7, 30, anchor)


def _order(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
           key: str) -> date | None:  # fmt: skip
    request = finance.order_request(index, counts)
    if request is None:
        issued = _main("purchase_orders", index, seed, anchor, (-SPAN, -10))
    else:
        requested = business_day("purchase_requests", "requested_on", request, seed, anchor,
                                 counts)  # fmt: skip
        issued = after(requested or anchor, f"{seed}:purchase_orders:{index}:issued", 3, 14,
                       anchor)  # fmt: skip
    return issued if field == "issued_on" else ahead(issued, key, 5, 21, anchor)


def _voucher(field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
             key: str) -> date | None:  # fmt: skip
    kind, parent = finance.disbursement_kind(index, counts)
    if kind == "advance" and parent is not None:
        return advance_released_on(parent, seed, anchor, counts)
    if kind == "order" and parent is not None:
        issued = business_day("purchase_orders", "issued_on", parent, seed, anchor, counts)
        return after(issued or anchor, key, 7, 30, anchor)
    return _main("disbursements", index, seed, anchor, (-SPAN, 0))


def _window(module_key: str, window: tuple[int, int] | Callable[[str], tuple[int, int]]
            ) -> Callable[..., date | None]:  # fmt: skip
    def rule(_field: str, index: int, seed: int, anchor: date, counts: dict[str, int],
             _key: str) -> date | None:  # fmt: skip
        chosen = window(status(module_key, index, counts)) if callable(window) else window
        return _main(module_key, index, seed, anchor, chosen)

    return rule


_RULES: dict[str, Callable[..., date | None]] = {
    "donors": _window("donors", (-SPAN, 0)),
    "campaigns": _campaign,
    "donations": _donation,
    "pledges": _pledge,
    "organizations": _window("organizations", (-SPAN, -5)),
    "grant_awards": _grant,
    "grant_reports": _report,
    "projects": _window("projects", (-120, -1)),
    "sites": _window("sites", (-SPAN, -30)),
    "activities": _activity,
    "beneficiaries": _window("beneficiaries", (-SPAN, 0)),
    "assistance": _assistance,
    "indicators": _window("indicators", (-180, -1)),
    "indicator_results": _result,
    "feedback_cases": _feedback,
    "funds": _fund,
    "cash_advances": _advance,
    "expense_lines": _expense,
    "disbursements": _voucher,
    "suppliers": _window("suppliers", (-SPAN, -10)),
    "purchase_requests": _request,
    "purchase_orders": _order,
    "volunteers": _window("volunteers", lambda state: (-60, 0) if state == "Active"
                          else (-SPAN, -90)),  # fmt: skip
}
