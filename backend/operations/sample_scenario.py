"""Build organization packs into the common plan and logical-data structures."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import cast

from operations.sample_actors import assignee_key, creator_keys, edge_creator_key
from operations.sample_blueprint import (
    SampleDataset,
    SampleEdge,
    SampleRecord,
    SampleTestVector,
    _build_document,
    _build_test_vectors,
    build_document,
)
from operations.sample_catalog import _OMIT, _anchor, _doc_id, module_counts
from operations.sample_links import parent_indices
from operations.sample_packs import default_pack
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import JsonValue, SampleProfile

__all__ = ["SampleDataset", "SampleTestVector", "build_dataset", "build_document", "module_counts"]


def _record_id(module_key: str, index: int) -> str:
    return f"{module_key}:{index + 1:06d}"


def _build_records(
    organization: OrganizationPack,
    seed: int,
    anchor: date,
    counts: dict[str, int],
    field_ids: dict[str, dict[str, str]],
) -> tuple[SampleRecord, ...]:
    records: list[SampleRecord] = []
    for module in organization.catalog.modules:
        creators = creator_keys(
            module.key, module.department, counts[module.key], seed, organization
        )
        for index in range(counts[module.key]):
            data: dict[str, JsonValue] = {}
            for field in module.fields:
                value = organization.generators.field_value(
                    organization, module, field, index, seed, anchor, counts
                )
                if value is not _OMIT:
                    data[field_ids[module.key][field.key]] = cast(JsonValue, value)
            records.append(
                SampleRecord(
                    _record_id(module.key, index),
                    module.key,
                    module.department,
                    data,
                    creator_key=creators[index],
                    assignee_key=assignee_key(
                        module.key, module.department, index, seed, organization
                    ),
                )
            )
    return tuple(records)


def _edges(
    organization: OrganizationPack,
    counts: Mapping[str, int],
    relationship_ids: Mapping[str, str],
    records: tuple[SampleRecord, ...],
) -> tuple[SampleEdge, ...]:
    output: list[SampleEdge] = []
    by_logical = {record.logical_id: record for record in records}
    for spec in organization.catalog.relationships:
        for target in range(counts[spec.target]):
            for source in parent_indices(spec.key, target, counts, organization):
                source_id, target_id = (
                    _record_id(spec.source, source),
                    _record_id(spec.target, target),
                )
                output.append(
                    SampleEdge(
                        relationship_ids[spec.key],
                        source_id,
                        target_id,
                        edge_creator_key(
                            by_logical[source_id], by_logical[target_id], organization
                        ),
                    )
                )
    return tuple(output)


def build_dataset(
    profile: SampleProfile = "small",
    seed: int = 42,
    anchor_date: date | None = None,
    *,
    organization: OrganizationPack | None = None,
    module_counts_override: Mapping[str, int] | None = None,
) -> SampleDataset:
    """Build the design, records and plan from one immutable organization pack."""
    pack = organization or default_pack()
    counts = (
        dict(module_counts(profile, pack))
        if module_counts_override is None
        else dict(module_counts_override)
    )
    anchor = _anchor(anchor_date, pack)
    document, maps = _build_document(seed, anchor, pack)
    department_ids = cast(dict[str, str], maps["department_ids"])
    module_ids = cast(dict[str, str], maps["module_ids"])
    field_ids = cast(dict[str, dict[str, str]], maps["field_ids"])
    relationship_ids = cast(dict[str, str], maps["relationship_ids"])
    records = _build_records(pack, seed, anchor, counts, field_ids)
    trigger_ids = {key: _doc_id(seed, "trigger", key, pack) for key in pack.generators.trigger_keys}
    return SampleDataset(
        organization=pack,
        profile=profile,
        seed=seed,
        anchor_date=anchor,
        document=document,
        module_counts=counts,
        department_ids=department_ids,
        module_ids=module_ids,
        field_ids=field_ids,
        relationship_ids=relationship_ids,
        trigger_ids=trigger_ids,
        records=records,
        edges=_edges(pack, counts, relationship_ids, records),
        test_vectors=_build_test_vectors(
            seed, module_ids, field_ids, records, document, trigger_ids
        ),
        named_scenarios=pack.generators.named_scenarios,
    )
