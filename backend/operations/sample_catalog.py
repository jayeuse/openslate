"""Pack-neutral catalog types and lookups used by the sample-data engine."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from operations.sample_packs import default_pack
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import (
    OMIT as _OMIT,
)
from operations.sample_packs.types import (
    ActorKey,
    FieldSpec,
    FieldType,
    JsonValue,
    ModuleSpec,
    RelationshipSpec,
    SampleProfile,
)

__all__ = [
    "ActorKey",
    "FieldSpec",
    "FieldType",
    "JsonValue",
    "ModuleSpec",
    "RelationshipSpec",
    "SampleProfile",
    "_OMIT",
    "_anchor",
    "_doc_id",
    "module_counts",
]


def module_counts(
    profile: SampleProfile, organization: OrganizationPack | None = None
) -> dict[str, int]:
    """Return this pack's exact module counts for a documented profile."""
    pack = organization or default_pack()
    try:
        return dict(pack.catalog.counts_by_profile[profile])
    except KeyError:
        raise ValueError(f"Unknown sample profile: {profile}") from None


def _doc_id(seed: int, kind: str, key: str, organization: OrganizationPack | None = None) -> str:
    pack = organization or default_pack()
    return str(
        uuid5(
            NAMESPACE_URL,
            f"{pack.identity.uuid_namespace}:{seed}:{kind}:{key}",
        )
    )


def _anchor(anchor_date: date | None, organization: OrganizationPack | None = None) -> date:
    pack = organization or default_pack()
    return anchor_date or datetime.now(ZoneInfo(pack.identity.timezone)).date()


def __getattr__(name: str) -> Any:
    """Keep the historical catalog names available to tests and operator helpers."""
    if name not in {
        "_DEPARTMENTS",
        "_MODULES",
        "_RELATIONSHIPS",
        "_SPECIAL_STATUSES",
    }:
        raise AttributeError(name)
    pack = default_pack()
    compatibility = {
        "_DEPARTMENTS": pack.catalog.departments,
        "_MODULES": pack.catalog.modules,
        "_RELATIONSHIPS": pack.catalog.relationships,
        "_SPECIAL_STATUSES": pack.catalog.special_statuses,
    }
    try:
        return compatibility[name]
    except KeyError:
        raise AttributeError(name) from None
