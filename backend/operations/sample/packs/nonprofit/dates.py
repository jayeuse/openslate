"""Foundation business dates: twelve months of work, every child dated after its parent."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from operations.sample.packs.nonprofit.realism import date_cluster, holidays
from operations.sample.realism import entry_time, working_day

ZONE = ZoneInfo("Asia/Manila")
SPAN = 360  # Twelve months, inside the Sandbox's one-year earliest date (plan: span).


def work_day(day: date, anchor: date) -> date:
    """Move a date to a working day without moving it across the anchor date."""
    if day < anchor:
        low, high = max(day - timedelta(days=5), anchor - timedelta(days=SPAN)), anchor
        high -= timedelta(days=1)
    elif day > anchor:
        low, high = anchor + timedelta(days=1), day + timedelta(days=5)
    else:
        return last_working_day(anchor)
    return working_day(day, holidays(anchor), low, high)


def last_working_day(anchor: date) -> date:
    day = anchor
    while day.weekday() >= 5 or day in holidays(anchor):
        day -= timedelta(days=1)
    return day


def pick(module_key: str, index: int, seed: int, anchor: date, window: tuple[int, int]) -> date:
    rng = random.Random(f"{seed}:{module_key}:{index}:fcdf-date:{window}")
    return date_cluster(module_key, anchor, *window).pick(rng)


def after(day: date, key: str, low: int, high: int, anchor: date) -> date:
    """A working day a few days after ``day``, never after the anchor date."""
    later = min(day + timedelta(days=random.Random(key).randint(low, high)), anchor)
    moved = working_day(later, holidays(anchor), day, anchor)
    return moved if day <= moved <= anchor else day


def ahead(day: date, key: str, low: int, high: int, anchor: date) -> date:
    """A working day after ``day`` that may fall after the anchor date (a due date)."""
    later = day + timedelta(days=random.Random(key).randint(low, high))
    latest = anchor + timedelta(days=85)
    moved = working_day(min(later, latest), holidays(anchor), day, latest)
    return moved if day <= moved <= latest else day


def floor(day: date, anchor: date) -> date:
    """Keep a derived date inside the twelve months the Sandbox accepts."""
    return max(day, anchor - timedelta(days=SPAN))


def stamp(day: date, at: time) -> str:
    return datetime.combine(day, at, ZONE).isoformat(timespec="minutes")


def entry_stamp(day: date, key: str) -> str:
    return stamp(day, entry_time(random.Random(key)))


def activity_date(
    module_key: str, index: int, seed: int, anchor: date, _counts: Mapping[str, int]
) -> date:
    return work_day(pick(module_key, index, seed, anchor, (-SPAN, 0)), anchor)


def related_datetime(
    module_key: str, field_key: str, index: int, seed: int, anchor: date,
    counts: Mapping[str, int],
) -> str:  # fmt: skip
    """A timestamp on the record's main working day (used by shared control helpers)."""
    day = activity_date(module_key, index, seed, anchor, counts)
    return entry_stamp(day, f"{seed}:{module_key}:{index}:{field_key}:time")


def birth_date(index: int, seed: int, anchor: date) -> date:
    """Registered household members are adults; date of birth is outside the run window."""
    rng = random.Random(f"{seed}:beneficiaries:{index}:birth_date")
    age = rng.choices((rng.randint(18, 35), rng.randint(36, 59), rng.randint(60, 84)),
                      weights=(35, 45, 20))[0]  # fmt: skip
    return anchor.replace(year=anchor.year - age, month=1, day=1) + timedelta(
        days=rng.randrange(365)
    )


def quarter_ends(anchor: date, months: int) -> tuple[date, ...]:
    """Period ends (last day of every ``months`` months) before the anchor, latest first."""
    ends: list[date] = []
    year, month = anchor.year, anchor.month
    while len(ends) < 24:
        first = date(year, month, 1)
        end = first - timedelta(days=1)
        if end.month % months == 0 and end <= anchor - timedelta(days=5):
            if end < anchor - timedelta(days=SPAN):
                break
            ends.append(end)
        year, month = end.year, end.month
    return tuple(ends)
