"""Confirmed execution shared by reset contract tests."""

from typing import Any

from operations.reset import execution


def apply_confirmed(database: Any, plan: Any, **extra: Any) -> Any:
    return execution.apply_reset(
        database,
        plan,
        execute=True,
        stdin_is_tty=True,
        confirmation=plan.impact_digest,
        **extra,
    )
