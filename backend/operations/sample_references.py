"""Pack-neutral textual references between generated records."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample_links import reference_parents
from operations.sample_packs import default_pack
from operations.sample_packs.interface import OrganizationPack
from operations.sample_text import reference_code


def _reference_code(module_key: str, index: int, seed: int, organization: OrganizationPack) -> str:
    code = reference_code(module_key, index, seed, organization)
    if code is None:
        raise ValueError(f"{module_key} records have no reference number")
    return code


def sample_reference_value(
    module_key: str,
    field_key: str,
    index: int,
    counts: Mapping[str, int],
    seed: int,
    organization: OrganizationPack | None = None,
) -> str:
    """Return a UI-enterable code matching the corresponding generated record."""
    pack = organization or default_pack()
    parents = reference_parents(module_key, field_key, index, counts, pack)
    return "; ".join(
        _reference_code(target, target_index, seed, pack) for target, target_index in parents
    )
