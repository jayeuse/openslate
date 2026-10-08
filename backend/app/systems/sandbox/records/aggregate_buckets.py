"""Bounded calendar starts shared by series validation and PostgreSQL grouping."""

from datetime import date, timedelta
from typing import Any, Literal

from sqlalchemy import Date, DateTime, func
from sqlalchemy.sql.elements import ColumnElement

AggregateBucket = Literal["day", "week", "month", "quarter", "year"]
MAX_SERIES_BUCKETS = 366


def bucket_start(value: date, bucket: AggregateBucket, week_start: str) -> date:
    if bucket == "week":
        offset = (value.weekday() + (1 if week_start == "sunday" else 0)) % 7
        if value.toordinal() <= offset:
            raise ValueError("The calendar bucket starts before the supported date range")
        return value - timedelta(days=offset)
    if bucket == "month":
        return value.replace(day=1)
    if bucket == "quarter":
        return value.replace(month=((value.month - 1) // 3) * 3 + 1, day=1)
    if bucket == "year":
        return value.replace(month=1, day=1)
    return value


def next_bucket(value: date, bucket: AggregateBucket) -> date | None:
    if bucket in {"day", "week"}:
        ordinal = value.toordinal() + (7 if bucket == "week" else 1)
        return None if ordinal > date.max.toordinal() else date.fromordinal(ordinal)
    if bucket == "year":
        return None if value.year == date.max.year else value.replace(year=value.year + 1)
    month_index = (value.year - 1) * 12 + value.month - 1 + (3 if bucket == "quarter" else 1)
    year, month = divmod(month_index, 12)
    return None if year >= date.max.year else date(year + 1, month + 1, 1)


def calendar_buckets(
    from_date: date, to_date: date, bucket: AggregateBucket, week_start: str = "monday"
) -> list[date]:
    if to_date < from_date:
        raise ValueError("Date series end must not precede its start")
    current = bucket_start(from_date, bucket, week_start)
    last = bucket_start(to_date, bucket, week_start)
    result = []
    while True:
        result.append(current)
        if len(result) > MAX_SERIES_BUCKETS:
            raise ValueError("Date series must contain at most 366 calendar buckets")
        if current == last:
            return result
        following = next_bucket(current, bucket)
        if following is None:
            raise ValueError("The calendar bucket exceeds the supported date range")
        current = following


def validate_bucket_window(from_date: date, to_date: date, bucket: AggregateBucket) -> None:
    if bucket != "week":
        calendar_buckets(from_date, to_date, bucket)
        return
    # The request schema has no workspace I/O. The service checks the actual anchor.
    errors = []
    for start in ("monday", "sunday"):
        try:
            calendar_buckets(from_date, to_date, bucket, start)
            return
        except ValueError as error:
            errors.append(error)
    raise errors[0]


def sql_bucket_start(
    local_date: ColumnElement[Any], bucket: AggregateBucket, week_start: str
) -> ColumnElement[Any]:
    if bucket == "day":
        return local_date
    timestamp = local_date.cast(DateTime(timezone=False))
    if bucket == "week" and week_start == "sunday":
        return (func.date_trunc("week", timestamp + timedelta(days=1)) - timedelta(days=1)).cast(
            Date()
        )
    return func.date_trunc(bucket, timestamp).cast(Date())
