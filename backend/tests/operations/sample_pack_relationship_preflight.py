"""Compact profile-scale relationship cardinality checks without record creation."""

from __future__ import annotations

from collections import Counter
from datetime import date
from uuid import UUID

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.rules import relationship_metadata
from app.systems.sandbox.relationships.locking import validate_relationship_modules
from operations.sample_blueprint import build_document
from operations.sample_catalog import module_counts
from operations.sample_links import parent_indices
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import SampleProfile


def admit_relationship_profile(organization: OrganizationPack, profile: SampleProfile) -> int:
    """Check generated Standard/Large edges against the app's published cardinality rules."""
    counts = module_counts(profile, organization)
    document = SandboxDocument.model_validate(
        build_document(seed=42, anchor_date=date(2026, 9, 30), organization=organization)
    )
    module_rows = {
        module.id: Module(
            id=UUID(module.id),
            department_id=UUID(module.department_id),
            module_name=module.name,
            is_deleted=module.closed,
        )
        for module in document.design.modules
    }
    edge_counts: Counter[str] = Counter()
    for spec, relationship in zip(
        organization.catalog.relationships, document.design.relationships, strict=True
    ):
        assert relationship.cardinality == spec.cardinality
        validate_relationship_modules(
            module_rows[relationship.source_module_id],
            module_rows[relationship.target_module_id],
        )
        outgoing: Counter[int] = Counter()
        incoming: Counter[int] = Counter()
        pairs: set[tuple[int, int]] = set()
        for target_index in range(counts[spec.target]):
            for source_index in parent_indices(spec.key, target_index, counts, organization):
                pair = (source_index, target_index)
                assert pair not in pairs
                pairs.add(pair)
                outgoing[source_index] += 1
                incoming[target_index] += 1
        multiple_targets, multiple_sources = relationship_metadata(relationship)
        if not multiple_sources:
            assert max(incoming.values(), default=0) <= 1
        if not multiple_targets:
            assert max(outgoing.values(), default=0) <= 1
        assert all(0 <= source < counts[spec.source] for source, _target in pairs)
        assert all(0 <= target < counts[spec.target] for _source, target in pairs)
        edge_counts[spec.key] = len(pairs)
    return sum(edge_counts.values())
