"""Pack-neutral link planners backed by each organization's relationship rules."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

from operations.sample.packs import default_pack
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import RelationshipSpec


def parent_indices(
    key: str,
    child: int,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> tuple[int, ...]:
    """Indexes of the earlier records that one later (child) record links to."""
    pack = organization or default_pack()
    return pack.links.parent_indices(pack, key, child, counts)


def link_pairs(
    spec: RelationshipSpec,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> Iterator[tuple[int, int]]:
    """Yield (source index, target index) for each edge, in the child end's record order."""
    child = spec.source if spec.child == "source" else spec.target
    for child_index in range(counts[child]):
        for parent_index in parent_indices(spec.key, child_index, counts, organization):
            if spec.child == "source":
                yield child_index, parent_index
            else:
                yield parent_index, child_index


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
