"""Scalar bounds shared by temporary Sandbox value validation."""

from collections.abc import Mapping

from app.systems.sandbox.designs.date_values import date_in_range
from app.systems.sandbox.numeric import numeric_matches_step


def within_length(value: str, config: Mapping[str, object]) -> bool:
    maximum = config.get("maxLength")
    return not isinstance(maximum, int) or len(value) <= maximum


def number_is_valid(value: int | float, config: Mapping[str, object]) -> bool:
    minimum = config.get("min")
    maximum = config.get("max")
    step = config.get("step")
    if isinstance(minimum, (int, float)) and not isinstance(minimum, bool) and value < minimum:
        return False
    if isinstance(maximum, (int, float)) and not isinstance(maximum, bool) and value > maximum:
        return False
    if isinstance(step, (int, float)) and not isinstance(step, bool):
        if step <= 0:
            return False
        origin = (
            minimum if isinstance(minimum, (int, float)) and not isinstance(minimum, bool) else 0
        )
        return numeric_matches_step(value, origin, step)
    return True


def date_is_valid(value: str, config: Mapping[str, object], *, is_datetime: bool) -> bool:
    earliest = config.get("earliest")
    latest = config.get("latest")
    return date_in_range(
        value,
        earliest if isinstance(earliest, str) else None,
        latest if isinstance(latest, str) else None,
        datetime_values=is_datetime,
    )
