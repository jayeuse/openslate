"""Pack-neutral link planners backed by each organization's relationship rules."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from operations.sample_packs import default_pack
from operations.sample_packs.interface import OrganizationPack


def parent_indices(
    key: str,
    target: int,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> tuple[int, ...]:
    pack = organization or default_pack()
    return pack.links.parent_indices(pack, key, target, counts)


def reference_parents(
    module_key: str,
    field_key: str,
    index: int,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> tuple[tuple[str, int], ...]:
    pack = organization or default_pack()
    return pack.links.reference_parents(pack, module_key, field_key, index, counts)


def __getattr__(name: str) -> Any:
    if name == "REFERENCE_FIELDS":
        return default_pack().links.reference_fields
    raise AttributeError(name)
