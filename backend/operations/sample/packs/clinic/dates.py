"""Clinic business dates: one quarter of visits, with every child dated after its parent."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

from operations.sample.packs.clinic import links
from operations.sample.packs.clinic.realism import date_cluster, holidays
from operations.sample.realism import entry_time, working_day

ZONE = ZoneInfo("America/Chicago")
SPAN = 91  # One quarter of clinic work (plan: span).

# Window of each module's main date, in days from the anchor date: (earliest, latest).
_WINDOWS: dict[str, tuple[int, int]] = {
    "patients": (-SPAN, 0),
    "coverages": (-330, -10),
    "payers": (-360, -30),
    "stock_lots": (-180, -1),
    "suppliers": (-300, -10),
    "purchase_requests": (-SPAN, 0),
    "purchase_orders": (-SPAN, -2),
    "equipment": (-20, 88),
    "incident_reports": (-SPAN, 0),
    "staff_credentials": (-360, -1),
}


def clinic_day(day: date, anchor: date) -> date:
    """Move a date to a working day without moving it across the anchor date."""
    if day < anchor:
        low, high = day - timedelta(days=5), anchor - timedelta(days=1)
    elif day > anchor:
        low, high = anchor + timedelta(days=1), day + timedelta(days=5)
    else:
        return last_working_day(anchor)
    return working_day(day, holidays(anchor), low, high)


def last_working_day(anchor: date) -> date:
    """Today for an open visit; the last day the clinic was open if today it is closed."""
    day = anchor
    while day.weekday() >= 5 or day in holidays(anchor):
        day -= timedelta(days=1)
    return day


def _after(day: date, low: int, high: int, rng: random.Random, anchor: date) -> date:
    """A working day a few days after ``day``, never after the anchor date."""
    later = min(day + timedelta(days=rng.randint(low, high)), anchor)
    moved = working_day(later, holidays(anchor), day, anchor)
    return moved if day <= moved <= anchor else day


def pick(module_key: str, index: int, seed: int, anchor: date, window: tuple[int, int]) -> date:
    rng = random.Random(f"{seed}:{module_key}:{index}:clinic-date")
    return date_cluster(module_key, anchor, *window).pick(rng)


def main_date(module_key: str, index: int, seed: int, anchor: date) -> date:
    return pick(module_key, index, seed, anchor, _WINDOWS.get(module_key, (-SPAN, 0)))


@lru_cache(maxsize=32)
def working_days(anchor: date, total: int) -> tuple[date, ...]:
    """The last ``total`` working days up to the anchor date, oldest first."""
    days: list[date] = []
    day = anchor
    while len(days) < total:
        if day.weekday() < 5 and day not in holidays(anchor):
            days.append(day)
        day -= timedelta(days=1)
    return tuple(reversed(days))


def daily_date(module_key: str, index: int, anchor: date, counts: Mapping[str, int]) -> date:
    """Temperature checks and QC runs happen on every working day, in a fixed rhythm."""
    per_day = (
        2 * links.fridge_count(counts)
        if module_key == "temperature_logs"
        else 3 * links.analyzer_count(counts)
    )
    total = -(-counts[module_key] // per_day)
    return working_days(anchor, total)[index // per_day]


def visit_date(
    module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int], *,
    open_visit: bool, booked: bool,
) -> date:  # fmt: skip
    """An appointment's day; a visit with an appointment takes the appointment's day."""
    if module_key == "encounters":
        appointment = links.encounter_appointment(index, counts)
        if appointment is not None:
            return visit_date("appointments", appointment, seed, anchor, counts,
                              open_visit=open_visit, booked=False)  # fmt: skip
    if open_visit:
        return last_working_day(anchor)
    if booked:
        return pick(module_key, index, seed, anchor, (1, 28))
    return pick(module_key, index, seed, anchor, (-SPAN, -1))


def visit_time(module_key: str, index: int, seed: int) -> time:
    """Clinic slots run every 15 minutes from 08:00 to 16:45."""
    rng = random.Random(f"{seed}:{module_key}:{index}:slot")
    slot = rng.choices(range(36), weights=[3 if slot < 12 else 2 for slot in range(36)])[0]
    return time(8 + slot // 4, (slot % 4) * 15)


def stamp(day: date, at: time) -> str:
    return datetime.combine(day, at, ZONE).isoformat(timespec="minutes")


def after(day: date, key: str, low: int, high: int, anchor: date) -> date:
    return _after(day, low, high, random.Random(key), anchor)


def entry_stamp(day: date, key: str) -> str:
    return stamp(day, entry_time(random.Random(key)))


def related_datetime(
    module_key: str, field_key: str, index: int, seed: int, anchor: date,
    counts: Mapping[str, int],
) -> str:  # fmt: skip
    """A timestamp on the record's main working day (used by shared control helpers)."""
    day = clinic_day(main_date(module_key, index, seed, anchor), anchor)
    return entry_stamp(day, f"{seed}:{module_key}:{index}:{field_key}:time")


def activity_date(
    module_key: str, index: int, seed: int, anchor: date, _counts: Mapping[str, int]
) -> date:
    return clinic_day(main_date(module_key, index, seed, anchor), anchor)


def birth_date(index: int, seed: int, anchor: date) -> date:
    """Patients of every age; date of birth is master data outside the run window."""
    rng = random.Random(f"{seed}:patients:{index}:birth_date")
    age = rng.choices((rng.randint(0, 17), rng.randint(18, 64), rng.randint(65, 92)),
                      weights=(22, 58, 20))[0]  # fmt: skip
    born = anchor.replace(year=anchor.year - age, month=1, day=1) + timedelta(
        days=rng.randrange(365)
    )
    return min(born, anchor - timedelta(days=rng.randint(20, 300)))
