"""ISO date and Date/Time rules shared by Designer and operational fields."""

from __future__ import annotations

import re
from datetime import UTC, date, datetime

_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
_DATETIME_PATTERN = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?\Z"
)


def valid_date(value: str) -> bool:
    if _DATE_PATTERN.fullmatch(value) is None:
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def valid_datetime(value: str) -> bool:
    return parse_datetime(value) is not None


def parse_datetime(value: str) -> datetime | None:
    """Parse accepted Date/Time text as an instant, treating local input as UTC."""

    if _DATETIME_PATTERN.fullmatch(value) is None:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def date_in_range(
    value: str,
    earliest: str | None,
    latest: str | None,
    *,
    datetime_values: bool,
) -> bool:
    parser = parse_datetime if datetime_values else _parse_date
    parsed = parser(value)
    earliest_value = parser(earliest) if earliest is not None else None
    latest_value = parser(latest) if latest is not None else None
    return (
        parsed is not None
        and (earliest_value is None or parsed >= earliest_value)
        and (latest_value is None or parsed <= latest_value)
    )


def _parse_date(value: str) -> date | None:
    if not valid_date(value):
        return None
    return date.fromisoformat(value)
