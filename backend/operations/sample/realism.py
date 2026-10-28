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
from itertools import accumulate

# R1. Statuses and choices are skewed.


def weighted_label(rng: random.Random, weights: Mapping[str, float]) -> str:
    """One label, drawn by the pack's weight for each label."""
    labels = list(weights)
    return rng.choices(labels, weights=[weights[label] for label in labels])[0]


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
    """Case or plus-addressing only, so the server's email check still passes."""
    local, _, domain = email.partition("@")
    match rng.randrange(3):
        case 0:
            return f"{local.capitalize()}@{domain}"
        case 1:
            return f"{local}@{domain.upper()}"
        case _:
            return f"{local}+{rng.choice(('work', 'orders', 'billing'))}@{domain}"


def url_variant(rng: random.Random, url: str) -> str:
    """A case or trailing-slash change that keeps an http(s) URL with a host."""
    scheme, separator, rest = url.partition("://")
    host, slash, path = rest.partition("/")
    if rng.random() < 0.5:
        return f"{scheme}{separator}{host.upper()}{slash}{path}"
    return url.rstrip("/") if url.endswith("/") else url + "/"
