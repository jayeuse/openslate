"""Calendar bucket starts, steps and the 366-bucket bound, without PostgreSQL.

``test_aggregate_buckets.py`` keeps the same windows through PostgreSQL: the SQL
``date_trunc`` grouping, the workspace week anchor and the time zones.
"""

from datetime import date, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.sandbox.records.aggregate_buckets import calendar_buckets
from app.systems.sandbox.records.query_schemas import DateSeriesAggregateQuery
from tests.property_support import PROPERTY

_WEEKDAY = {"monday": 0, "sunday": 6}


@pytest.mark.parametrize(
    "bucket,week_start,from_date,to_date,expected",
    [
        ("day", "monday", "2026-10-07", "2026-10-09", ["2026-10-07", "2026-10-08", "2026-10-09"]),
        ("week", "monday", "2026-10-07", "2026-10-13", ["2026-10-05", "2026-10-12"]),
        ("week", "sunday", "2026-10-07", "2026-10-13", ["2026-10-04", "2026-10-11"]),
        ("month", "monday", "2026-12-15", "2027-01-10", ["2026-12-01", "2027-01-01"]),
        (
            "quarter",
            "monday",
            "2026-09-30",
            "2027-01-01",
            ["2026-07-01", "2026-10-01", "2027-01-01"],
        ),
        ("year", "monday", "2026-12-31", "2027-01-01", ["2026-01-01", "2027-01-01"]),
    ],
)
def test_buckets_start_on_their_calendar_boundary(bucket, week_start, from_date, to_date, expected):
    starts = calendar_buckets(
        date.fromisoformat(from_date), date.fromisoformat(to_date), bucket, week_start
    )
    assert [start.isoformat() for start in starts] == expected


@pytest.mark.parametrize(
    "bucket,from_date,to_date",
    [("month", "2020-01-31", "2050-06-01"), ("year", "2000-03-01", "2365-12-31")],
)
def test_a_window_of_exactly_366_buckets_is_legal(bucket, from_date, to_date):
    starts = calendar_buckets(date.fromisoformat(from_date), date.fromisoformat(to_date), bucket)
    assert len(starts) == 366


@pytest.mark.parametrize(
    "bucket,from_date,to_date",
    [("month", "2020-01-31", "2050-07-01"), ("year", "2000-03-01", "2366-12-31")],
)
def test_series_rejects_the_367th_calendar_bucket(bucket, from_date, to_date):
    with pytest.raises(ValidationError):
        DateSeriesAggregateQuery(
            module_id=uuid7(),
            definition={},
            date_field={"field_id": uuid7(), "expected_type": "date"},
            bucket=bucket,
            from_date=from_date,
            to_date=to_date,
        )


@pytest.mark.parametrize("bucket", ["day", "week", "month", "quarter", "year"])
def test_the_last_supported_day_is_one_bucket_without_a_next_start(bucket):
    assert len(calendar_buckets(date.max, date.max, bucket)) == 1


def test_a_sunday_week_before_the_first_supported_day_is_refused():
    with pytest.raises(ValueError, match="starts before the supported date range"):
        calendar_buckets(date.min, date.min, "week", "sunday")


def test_a_reversed_window_is_refused():
    with pytest.raises(ValueError, match="must not precede its start"):
        calendar_buckets(date(2026, 10, 2), date(2026, 10, 1), "day")


def _contains(start: date, day: date, bucket: str, week_start: str) -> bool:
    """Whether *start* is the first day of the bucket that holds *day* (the calendar rule)."""

    if bucket == "day":
        return start == day
    if bucket == "week":
        return start.weekday() == _WEEKDAY[week_start] and 0 <= (day - start).days < 7
    if bucket == "month":
        return start.day == 1 and (start.year, start.month) == (day.year, day.month)
    if bucket == "quarter":
        return (
            start.day == 1
            and start.month in (1, 4, 7, 10)
            and start.year == day.year
            and 0 <= day.month - start.month < 3
        )
    return (start.month, start.day) == (1, 1) and start.year == day.year


def _too_many_buckets(from_date: date, to_date: date, bucket: str) -> bool:
    """A window wider than 366 buckets of its kind, counted from the calendar."""

    months = (to_date.year - from_date.year) * 12 + to_date.month - from_date.month
    return {
        "day": (to_date - from_date).days >= 366,
        # 367 week starts need at least 365 full weeks between the two days.
        "week": (to_date - from_date).days >= 365 * 7,
        "month": months >= 366,
        "quarter": (to_date.year - from_date.year) * 4
        + (to_date.month - 1) // 3
        - (from_date.month - 1) // 3
        >= 366,
        "year": to_date.year - from_date.year >= 366,
    }[bucket]


_SPAN = {"day": 1, "week": 7, "month": 31, "quarter": 92, "year": 366}


@st.composite
def _windows(draw):
    bucket = draw(st.sampled_from(["day", "week", "month", "quarter", "year"]))
    week_start = draw(st.sampled_from(["monday", "sunday"]))
    from_date = draw(st.dates())
    # Mostly windows near the 366-bucket bound, sometimes any later day.
    days = draw(st.integers(0, 400 * _SPAN[bucket]) | st.integers(0, date.max.toordinal()))
    to_date = date.fromordinal(min(from_date.toordinal() + days, date.max.toordinal()))
    return bucket, week_start, from_date, to_date


@PROPERTY
@given(window=_windows())
def test_buckets_are_consecutive_calendar_starts_that_cover_the_window(window):
    bucket, week_start, from_date, to_date = window
    try:
        starts = calendar_buckets(from_date, to_date, bucket, week_start)
    except ValueError:
        near_first_day = bucket == "week" and from_date.toordinal() <= 7
        assert near_first_day or _too_many_buckets(from_date, to_date, bucket)
        return

    assert 1 <= len(starts) <= 366
    assert _contains(starts[0], from_date, bucket, week_start)
    assert _contains(starts[-1], to_date, bucket, week_start)
    for current, following in zip(starts, starts[1:], strict=False):
        assert current < following
        assert _contains(following, following, bucket, week_start)
        assert _contains(current, following - timedelta(days=1), bucket, week_start)
