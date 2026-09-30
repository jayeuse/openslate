"""Generate visible reference codes for business links the schema keeps textual."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample_links import reference_parents
from operations.sample_text import reference_code


def _reference_code(module_key: str, index: int, seed: int) -> str:
    code = reference_code(module_key, index, seed)
    if code is None:
        raise ValueError(f"{module_key} records have no reference number")
    return code


def sample_reference_value(
    module_key: str, field_key: str, index: int, counts: Mapping[str, int], seed: int
) -> str:
    """Return a UI-enterable code matching the corresponding generated record."""
    parents = reference_parents(module_key, field_key, index, counts)
    return "; ".join(
        _reference_code(target, target_index, seed) for target, target_index in parents
    )
