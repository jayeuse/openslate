"""City government business dates: one calendar year, every child dated after its parent."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from operations.sample.packs.local_government.realism import date_cluster, holidays
from operations.sample.realism import entry_time, working_day

ZONE = ZoneInfo("Asia/Manila")
SPAN = 360  # One calendar year of city hall work (plan: span), inside the Sandbox window.


def city_day(day: date, anchor: date) -> date:
    """Move a date to a working day without moving it across the anchor date."""
    if day < anchor:
        low = min(day, max(day - timedelta(days=5), anchor - timedelta(days=364)))
        high = anchor - timedelta(days=1)
    elif day > anchor:
        low, high = anchor + timedelta(days=1), day + timedelta(days=5)
    else:
        return last_working_day(anchor)
    return working_day(day, holidays(anchor), low, high)


def last_working_day(anchor: date) -> date:
    """Today, or the last day city hall was open if it is closed today."""
    day = anchor
    while day.weekday() >= 5 or day in holidays(anchor):
        day -= timedelta(days=1)
    return day


def after(day: date, key: str, low: int, high: int, anchor: date) -> date:
    """A working day a few days after ``day``, never after the anchor date."""
    rng = random.Random(key)
    later = min(day + timedelta(days=rng.randint(low, high)), anchor)
    moved = working_day(later, holidays(anchor), day, anchor)
    return moved if day <= moved <= anchor else day


def ahead(anchor: date, key: str, low: int, high: int) -> date:
    """A working day soon after the anchor date: a booked inspection or a planned job."""
    day = anchor + timedelta(days=random.Random(key).randint(low, high))
    return working_day(day, holidays(anchor), anchor + timedelta(days=1), anchor + timedelta(85))


def pick(season: str, key: str, anchor: date, window: tuple[int, int]) -> date:
    return city_day(date_cluster(season, anchor, *window).pick(random.Random(key)), anchor)


_WORKING_CACHE: dict[tuple[date, int], tuple[date, ...]] = {}


def working_days(anchor: date, total: int) -> tuple[date, ...]:
    """The last ``total`` working days up to the anchor date, oldest first."""
    cached = _WORKING_CACHE.get((anchor, total))
    if cached is not None:
        return cached
    days: list[date] = []
    day = last_working_day(anchor)
    while len(days) < total:
        if day.weekday() < 5 and day not in holidays(anchor):
            days.append(day)
        day -= timedelta(days=1)
    result = tuple(reversed(days))
    _WORKING_CACHE[(anchor, total)] = result
    return result


def reports_per_day(counts: Mapping[str, int]) -> int:
    """One deposit report a working day; a Large city has a report for each collector."""
    return max(1, -(-counts["deposit_reports"] // 240))


def daily_date(index: int, anchor: date, counts: Mapping[str, int]) -> date:
    per_day = reports_per_day(counts)
    total = -(-counts["deposit_reports"] // per_day)
    return working_days(anchor, total)[min(index // per_day, total - 1)]


def quarter_release(index: int, anchor: date) -> date:
    """Allotments are released at the start of each quarter (research §12)."""
    starts = [date(year, month, 2) for year in (anchor.year - 1, anchor.year)
              for month in (1, 4, 7, 10)]  # fmt: skip
    starts = [day for day in starts if anchor - timedelta(days=SPAN) <= day <= anchor]
    start = starts[index % len(starts)] if starts else anchor - timedelta(days=30)
    return after(start, f"lg:allotment:{index}", 0, 6, anchor)


def stamp(day: date, at: time) -> str:
    return datetime.combine(day, at, ZONE).isoformat(timespec="minutes")


def entry_stamp(day: date, key: str) -> str:
    return stamp(day, entry_time(random.Random(key)))


def related_datetime(
    module_key: str, field_key: str, index: int, seed: int, anchor: date,
    counts: Mapping[str, int],
) -> str:  # fmt: skip
    """A timestamp on the record's main working day (used by shared control helpers)."""
    del counts
    day = pick(module_key, f"{seed}:{module_key}:{index}:main", anchor, (-SPAN, 0))
    return entry_stamp(day, f"{seed}:{module_key}:{index}:{field_key}:time")


def activity_date(
    module_key: str, index: int, seed: int, anchor: date, _counts: Mapping[str, int]
) -> date:
    return pick(module_key, f"{seed}:{module_key}:{index}:main", anchor, (-SPAN, 0))


def clamp_past(day: date, anchor: date) -> date:
    """The earliest day the Sandbox accepts is a year before the anchor date."""
    return max(day, anchor - timedelta(days=364))
