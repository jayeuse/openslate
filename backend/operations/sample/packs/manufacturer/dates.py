"""Plant business dates: six weeks of work on the plant's five-day calendar.

Plan records keep a working-day offset (``wd``) from the anchor date; this module turns it
into a date. Offset 0 is the last day the plant worked, a negative offset is a working day
ahead (a booked shipment or a frozen schedule). Holidays and weekends have no records.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

from operations.sample.packs.manufacturer.realism import holidays
from operations.sample.realism import entry_time

ZONE = ZoneInfo("America/Chicago")
SPAN_WD = 30  # About six weeks of plant work (plan: span), with one month-end.
_PAST, _AHEAD = 240, 60


def _open(day: date, anchor: date) -> bool:
    return day.weekday() < 5 and day not in holidays(anchor)


@lru_cache(maxsize=16)
def _calendar(anchor: date) -> tuple[tuple[date, ...], tuple[date, ...]]:
    past: list[date] = []
    day = anchor
    while len(past) < _PAST:
        if _open(day, anchor):
            past.append(day)
        day -= timedelta(days=1)
    ahead: list[date] = []
    day = anchor + timedelta(days=1)
    while len(ahead) < _AHEAD:
        if _open(day, anchor):
            ahead.append(day)
        day += timedelta(days=1)
    return tuple(past), tuple(ahead)


def working_day(wd: int, anchor: date) -> date:
    """The ``wd``-th working day before the anchor date (0 is the last one worked)."""
    past, ahead = _calendar(anchor)
    if wd >= 0:
        return past[min(wd, _PAST - 1)]
    return ahead[min(-wd, _AHEAD) - 1]


def days_after(day: date, low: int, high: int, salt: str, anchor: date) -> date:
    """A calendar day a few days after ``day`` (a due date): it may lie ahead."""
    later = day + timedelta(days=random.Random(salt).randint(low, high))
    return min(later, anchor + timedelta(days=88))


def stamp(day: date, at: time) -> str:
    return datetime.combine(day, at, ZONE).isoformat(timespec="minutes")


def shift_stamp(day: date, shift: str, salt: str) -> str:
    """A time inside the shift: A runs 06:00-14:30, B 14:30-23:00."""
    rng = random.Random(salt)
    start = 6 * 60 if shift == "A" else 14 * 60 + 30
    minute = start + rng.randrange(0, 8 * 60)
    return stamp(day, time(minute // 60, minute % 60))


def office_stamp(day: date, salt: str) -> str:
    return stamp(day, entry_time(random.Random(salt)))


def month_year(anchor: date, months: int) -> str:
    month = anchor.year * 12 + anchor.month - 1 + months
    return f"{month % 12 + 1:02d}/{month // 12}"


def best_by(day: date, shelf_days: int) -> str:
    """The best-by print on the pack, for example BEST BY 16 OCT 2027."""
    return (day + timedelta(days=shelf_days)).strftime("BEST BY %d %b %Y").upper()


def related_datetime(
    module_key: str, field_key: str, index: int, seed: int, anchor: date,
    counts: Mapping[str, int],
) -> str:  # fmt: skip
    """A timestamp on the record's main working day (used by shared control helpers)."""
    day = activity_date(module_key, index, seed, anchor, counts)
    return office_stamp(day, f"{seed}:{module_key}:{index}:{field_key}:time")


def activity_date(
    module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int]
) -> date:
    from operations.sample.packs.manufacturer.timeline import main_wd

    return working_day(main_wd(module_key, index, counts), anchor)
