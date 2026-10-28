"""School dates follow one teaching period, term rhythm, and event order."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from operations.sample.packs.school.realism import holidays
from operations.sample.realism import entry_time, working_day


def activity_date(
    module_key: str,
    index: int,
    seed: int,
    anchor: date,
    _counts: Mapping[str, int],
) -> date:
    return _activity_date(module_key, index, seed, anchor)


def school_day(day: date, anchor: date) -> date:
    """Move a date to a working day without moving it across the anchor date."""
    if day < anchor:
        low, high = day - timedelta(days=4), anchor - timedelta(days=1)
    elif day > anchor:
        low, high = anchor + timedelta(days=1), day + timedelta(days=4)
    else:
        return day
    return working_day(day, holidays(anchor), low, high)


def _activity_date(module_key: str, index: int, seed: int, anchor: date) -> date:
    return school_day(_window_date(module_key, index, seed, anchor), anchor)


def _window_date(module_key: str, index: int, seed: int, anchor: date) -> date:
    rng = random.Random(f"{seed}:{module_key}:{index}:school-date")
    if module_key in {"admission_inquiries", "applications"}:
        return anchor - timedelta(days=rng.randint(30, 140))
    if module_key == "students":
        return anchor - timedelta(days=rng.randint(5, 300))
    if module_key == "report_card_batches":
        return anchor + timedelta(days=rng.randint(2, 8))
    if module_key == "fee_assessments":
        return anchor + timedelta(days=rng.randint(0, 70))
    if module_key == "staff_leave":
        return anchor + timedelta(days=rng.randint(-70, 30))
    if module_key == "maintenance_requests":
        return anchor + timedelta(days=rng.randint(-70, 10))
    if module_key == "class_sections":
        return anchor - timedelta(days=rng.randint(5, 65))
    if module_key == "assessments":
        return anchor + timedelta(days=rng.randint(-55, 14))
    return anchor - timedelta(days=rng.randint(0, 70))


def related_date(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
    *,
    past_due: bool = False,
) -> date:
    """Return a date field ordered around the record's principal school event."""
    when = _related_date(module_key, field_key, index, seed, anchor, counts, past_due=past_due)
    return when if module_key == "students" else school_day(when, anchor)


def _related_date(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
    *,
    past_due: bool = False,
) -> date:
    rng = random.Random(f"{seed}:{module_key}:{index}:{field_key}:school-date")
    main = _activity_date(module_key, index, seed, anchor)
    if module_key == "admission_inquiries" and field_key == "inquiry_date":
        return anchor - timedelta(days=70 + index % 21)
    if module_key == "applications" and field_key == "submitted_on":
        return anchor - timedelta(days=35 + index % 28)
    if module_key == "applications" and field_key == "entrance_test_on":
        return anchor - timedelta(days=20 + index % 14)
    if module_key == "assessments" and field_key == "assigned_on":
        return main - timedelta(days=7 + index % 15)
    if module_key == "fee_assessments" and field_key == "next_due_date":
        if past_due:
            return anchor - timedelta(days=1 + index % 28)
        return anchor + timedelta(days=14 + index % 70)
    if module_key == "payments" and field_key == "payment_date":
        return min(main + timedelta(days=rng.randint(-2, 2)), anchor)
    if module_key == "clinic_visits" and field_key == "time_in" and index == 0:
        return anchor - timedelta(days=5)
    if module_key == "attendance_exceptions" and field_key == "activity_date" and index == 5:
        return anchor - timedelta(days=5)
    if module_key == "report_card_batches" and field_key == "release_date":
        return anchor + timedelta(days=2 + index % 7)
    if module_key == "maintenance_requests" and field_key == "completed_on":
        return main + timedelta(days=index % 5)
    if module_key == "staff_leave" and field_key == "from_date":
        return main
    if module_key == "staff_leave" and field_key == "to_date":
        return main + timedelta(days=1 + index % 5)
    if module_key == "collection_cases" and field_key == "promised_date":
        return anchor + timedelta(days=3 + index % 24)
    return main + timedelta(days=rng.randint(-2, 2))


def related_datetime(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> str:
    when = related_date(module_key, field_key, index, seed, anchor, counts)
    local_zone = ZoneInfo("Europe/London")
    if field_key == "arrival_at":  # A late arrival is a morning time.
        local_time = time(7 + (index * 5 + seed) % 10, (index * 11 + seed) % 60)
    else:
        local_time = entry_time(random.Random(f"{seed}:{module_key}:{index}:{field_key}:time"))
    return datetime.combine(when, local_time, local_zone).isoformat(timespec="minutes")


def birth_date(index: int, year_group_index: int, seed: int, anchor: date) -> date:
    """Give pupils a plausible age for their year group; DOB is master data."""
    rng = random.Random(f"{seed}:students:{index}:birth_date")
    age = min(18, max(4, year_group_index + 4 + rng.randrange(2)))
    try:
        return anchor.replace(year=anchor.year - age) - timedelta(days=rng.randrange(366))
    except ValueError:
        return anchor.replace(year=anchor.year - age, day=28) - timedelta(days=rng.randrange(366))
