"""Pack-neutral date generators for logical records and their events."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date

from operations.sample.packs import default_pack
from operations.sample.packs.interface import OrganizationPack


def activity_date(
    module_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> date:
    pack = organization or default_pack()
    return pack.dates.activity_date(pack, module_key, index, seed, anchor, counts)


def related_datetime(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> str:
    pack = organization or default_pack()
    return pack.dates.related_datetime(pack, module_key, field_key, index, seed, anchor, counts)
