"""Seeded helpers that give pack values a real organization's shape (spec rules R1-R6).

Every helper takes a ``random.Random`` that the caller builds from its usual
``f"{seed}:{module}:{index}:{field}"`` key, so a run stays reproducible. Packs keep
their pinned business cases and call these helpers only on the default path.
"""

from __future__ import annotations

import math
import random
from bisect import bisect_left
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, time, timedelta
from functools import lru_cache
from itertools import accumulate

# R1. Statuses and choices are skewed.


def weighted_label(rng: random.Random, weights: Mapping[str, float]) -> str:
    """One label, drawn by the pack's weight for each label."""
    labels = list(weights)
    return rng.choices(labels, weights=[weights[label] for label in labels])[0]


def ordered_skew(labels: Sequence[str], alpha: float = 1.1) -> dict[str, float]:
    """Default weights for a choice list: the first option is the usual one."""
    return {label: (position + 1) ** -alpha for position, label in enumerate(labels)}


# R2. Amounts have a long tail.


@dataclass(frozen=True)
class AmountShape:
    """A log-normal amount around ``median``; p99/p50 is exp(2.326 * sigma)."""

    median: float
    sigma: float = 0.9
    round_share: float = 0.08
    cents_share: float = 0.0
    outlier_share: float = 0.015
    outlier_factor: tuple[float, float] = (4.0, 12.0)
    minimum: float = 1
    maximum: float | None = None
    step: float | None = None


def _round_number(value: float) -> float:
    """The nearest number a person types by hand: 50, 500, 1,500, 5,000, 10,000."""
    magnitude = 10 ** max(1, math.floor(math.log10(max(value, 1))))
    half = magnitude / 2
    return float(max(half, round(value / half) * half))


def long_tail_amount(rng: random.Random, shape: AmountShape) -> int | float:
    """A value that fits the field's minimum, maximum and step."""
    value = shape.median * math.exp(rng.gauss(0, shape.sigma))
    if rng.random() < shape.outlier_share:
        value *= rng.uniform(*shape.outlier_factor)
    if rng.random() < shape.round_share:
        value = _round_number(value)
    elif shape.cents_share and rng.random() < shape.cents_share:
        value = round(value, 2)
    else:
        value = round(value)
    if shape.step:
        value = round(round(value / shape.step) * shape.step, 10)
    value = max(shape.minimum, value)
    if shape.maximum is not None:
        value = min(shape.maximum, value)
    return int(value) if float(value).is_integer() else value


# R3. Dates and times cluster.


@dataclass(frozen=True)
class DateShape:
    """Business-day weights for a date window.

    Weekends are rare, holidays are empty, and Mondays and the last three working
    days of each month are denser. ``seasons`` scales each month (1 = normal), and
    ``go_live`` puts a share of draws in the first days of the window.
    """

    start: date
    end: date
    holidays: frozenset[date] = frozenset()
    seasons: Mapping[int, float] = field(default_factory=dict)
    weekend_weight: float = 0.04
    monday_weight: float = 1.3
    month_end_weight: float = 1.4
    go_live_days: int = 7
    go_live_share: float = 0.0


class DateCluster:
    """Draw dates from a ``DateShape``; built once per module and reused."""

    def __init__(self, shape: DateShape) -> None:
        if shape.end < shape.start:
            raise ValueError("A date window must not end before it starts")
        self.shape = shape
        self.days = [
            shape.start + timedelta(days=offset)
            for offset in range((shape.end - shape.start).days + 1)
        ]
        month_ends = _last_working_days(self.days, shape.holidays)
        weights = [self._weight(day, month_ends) for day in self.days]
        if not any(weights):
            raise ValueError("A date window needs at least one working day")
        self._cumulative = list(accumulate(weights))
        working = [day for day, weight in zip(self.days, weights, strict=True) if weight]
        self._go_live = [day for day in working if day < working[0] + timedelta(shape.go_live_days)]

    def _weight(self, day: date, month_ends: Collection[date]) -> float:
        shape = self.shape
        if day in shape.holidays:
            return 0.0
        if day.weekday() >= 5:
            weight = shape.weekend_weight
        elif day.weekday() == 0:
            weight = shape.monday_weight
        else:
            weight = 1.0
        if day in month_ends:
            weight *= shape.month_end_weight
        return weight * shape.seasons.get(day.month, 1.0)

    def pick(self, rng: random.Random) -> date:
        if self._go_live and rng.random() < self.shape.go_live_share:
            return rng.choice(self._go_live)
        point = rng.random() * self._cumulative[-1]
        return self.days[bisect_left(self._cumulative, point)]


def _last_working_days(days: Sequence[date], holidays: Collection[date]) -> set[date]:
    by_month: dict[tuple[int, int], list[date]] = {}
    for day in days:
        if day.weekday() < 5 and day not in holidays:
            by_month.setdefault((day.year, day.month), []).append(day)
    return {day for month in by_month.values() for day in month[-3:]}


def easter_sunday(year: int) -> date:
    """Western Easter (anonymous Gregorian algorithm), for movable public holidays."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = divmod(b, 4)
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    m = (32 + 2 * e + 2 * i - h - k) % 7
    n = (a + 11 * h + 22 * m) // 451
    month, day = divmod(h + m - 7 * n + 114, 31)
    return date(year, month, day + 1)


def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """The n-th weekday of a month (0 = Monday); n = -1 is the last one."""
    if n > 0:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))
    last = (date(year + month // 12, month % 12 + 1, 1)) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def working_day(day: date, holidays: Collection[date], low: date, high: date) -> date:
    """Move a derived date to a working day, forward first, inside ``low``..``high``."""
    for step in (1, -1):
        moved = day
        while low <= moved <= high:
            if moved.weekday() < 5 and moved not in holidays:
                return moved
            moved += timedelta(days=step)
    return day


def entry_time(rng: random.Random) -> time:
    """Most entries at 9-11 and 14-16, the rest in working hours, a few after 21:00."""
    band = rng.random()
    if band < 0.45:
        hour = rng.randint(9, 10)
    elif band < 0.85:
        hour = rng.randint(14, 15)
    elif band < 0.98:
        hour = rng.choice((8, 11, 12, 13, 16, 17))
    else:
        hour = rng.randint(21, 22)
    return time(hour, rng.randrange(60))


# R4. Workload follows a Pareto shape.


def pareto_weights(rng: random.Random, team: Sequence[str], alpha: float = 1.2) -> list[float]:
    """Weights in team order; a seeded ranking gives one or two people most of the work."""
    ranking = list(team)
    rng.shuffle(ranking)
    rank = {key: position for position, key in enumerate(ranking, start=1)}
    return [rank[key] ** -alpha for key in team]


# R5. Links are uneven.


@lru_cache(maxsize=256)
def _parent_table(
    key: str, parents: int, pinned: int, dormant_share: float, alpha: float
) -> tuple[tuple[int, ...], tuple[float, ...]]:
    rng = random.Random(f"links:{key}:{parents}")
    eligible = [
        index for index in range(parents) if index < pinned or rng.random() >= dormant_share
    ]
    weights = pareto_weights(rng, [str(index) for index in eligible], alpha=alpha)
    return tuple(eligible), tuple(accumulate(weights))


def skewed_parent(
    key: str,
    child: int,
    parents: int,
    *,
    pinned: int = 10,
    dormant_share: float = 0.08,
    alpha: float = 0.8,
) -> int:
    """The parent a child links to: a few parents get many children and some get none.

    Children below ``pinned`` keep parent ``child`` so named business cases stay put.
    """
    if child < min(pinned, parents):
        return child
    eligible, cumulative = _parent_table(key, parents, pinned, dormant_share, alpha)
    point = random.Random(f"links:{key}:{child}").random() * cumulative[-1]
    return eligible[bisect_left(cumulative, point)]


# R6. Text has dirt that the server accepts.

_ABBREVIATIONS = (
    ("Corporation", "Corp."),
    ("Incorporated", "Inc."),
    ("Company", "Co."),
    ("Limited", "Ltd."),
    ("Street", "St."),
    ("Avenue", "Ave."),
)
FILLER_NOTES = ("n/a", "N/A", "-", "see above", "none", "tbd")


def dirty_text(rng: random.Random, value: str) -> str:
    """One human slip: a double or trailing space, ALL CAPS, or a swapped abbreviation."""
    swaps = [(long, short) for long, short in _ABBREVIATIONS if long in value or short in value]
    choices = ["double_space", "trailing_space", "caps", *(["abbreviation"] * 2 if swaps else [])]
    match rng.choice(choices):
        case "double_space" if " " in value:
            words = value.split(" ")
            gap = rng.randrange(len(words) - 1)
            return " ".join(words[: gap + 1]) + "  " + " ".join(words[gap + 1 :])
        case "caps":
            return value.upper()
        case "abbreviation":
            long, short = rng.choice(swaps)
            return value.replace(long, short) if long in value else value.replace(short, long)
        case _:
            return value + " "


def filler_note(rng: random.Random) -> str:
    return rng.choice(FILLER_NOTES)


def phone_variant(rng: random.Random, digits: str, country_code: str) -> str:
    """The same national number written the way different people type it."""
    local = digits[-10:].rjust(10, "0")
    return rng.choice(
        (
            f"+{country_code} {local[:3]} {local[3:6]} {local[6:]}",
            f"0{local[:3]}-{local[3:6]}-{local[6:]}",
            f"(0{local[:3]}) {local[3:6]} {local[6:]}",
            f"0{local}",
            f"+{country_code}{local}",
        )
    )


def email_variant(rng: random.Random, email: str) -> str:
    """The local part's case or a plus-address; the domain stays as it is."""
    local, _, domain = email.partition("@")
    if rng.random() < 0.5:
        return f"{local.capitalize()}@{domain}"
    return f"{local}+{rng.choice(('work', 'orders', 'billing'))}@{domain}"


def url_variant(rng: random.Random, url: str) -> str:
    """A trailing slash added or dropped; the scheme and host stay as they are."""
    del rng
    return url.rstrip("/") if url.endswith("/") else url + "/"


@dataclass(frozen=True)
class DirtRates:
    """How often people leave each kind of slip (spec R6) and quick entries (R7)."""

    title: float = 0.03
    filler_note: float = 0.06
    copied_note: float = 0.03
    phone: float = 0.35
    email: float = 0.12
    url: float = 0.08
    quick_entry: float = 0.04


DIRT = DirtRates()


def dirty_value(
    rng: random.Random,
    kind: str,
    value: object,
    *,
    required: bool,
    country_code: str,
    rates: DirtRates | None = None,
    quick_entry: bool = False,
    previous_note: str | None = None,
) -> object:
    """A value as a person typed it; the server accepts every result."""
    rates = rates or DIRT
    if not isinstance(value, str) or not value:
        return value
    if quick_entry and not required and kind in {"notes", "email", "url", "phone"}:
        return ""  # A quick entry leaves the optional details blank.
    draw = rng.random()
    if kind == "title" and draw < rates.title:
        return dirty_text(rng, value)
    if kind == "notes" and not required:
        if draw < rates.filler_note:
            return filler_note(rng)
        if previous_note and draw < rates.filler_note + rates.copied_note:
            return previous_note  # One note pasted across a batch.
    if kind == "phone" and draw < rates.phone:
        digits = "".join(ch for ch in value if ch.isdigit())
        return phone_variant(rng, digits, country_code) if len(digits) >= 7 else value
    if kind == "email" and draw < rates.email and "@" in value:
        return email_variant(rng, value)
    if kind == "url" and draw < rates.url:
        return url_variant(rng, value)
    return value
