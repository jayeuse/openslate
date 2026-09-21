"""Exact numeric helpers shared by Sandbox design, Test, and live validation."""

from decimal import Decimal, localcontext
from typing import cast


def numeric_matches_step(
    value: int | float,
    minimum: int | float,
    step: int | float,
) -> bool:
    """Return whether a finite numeric value is aligned without float overflow."""

    if step == 0:
        return False
    if all(isinstance(item, int) and not isinstance(item, bool) for item in (value, minimum, step)):
        return (value - minimum) % step == 0
    try:
        decimal_value = Decimal(str(value))
        decimal_minimum = Decimal(str(minimum))
        decimal_step = Decimal(str(step))
        values = (decimal_value, decimal_minimum, decimal_step)
        precision = max(
            28,
            max(item.adjusted() for item in values)
            - min(cast(int, item.as_tuple().exponent) for item in values)
            + 3,
        )
        with localcontext() as context:
            context.prec = precision
            return (decimal_value - decimal_minimum) % decimal_step == 0
    except (ArithmeticError, ValueError):
        return False
