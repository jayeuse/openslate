import os
from datetime import UTC, datetime
from unittest.mock import patch
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.models import AuditAction
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.schemas import RelationshipAvailability, RelationshipListRequest
from app.systems.relationships.service import (
    RelationshipConflict,
    assign_relationship,
    create_relationship,
    list_relationships,
)
from tests.relationships_integration_support import (
    _add_edge,
    _edge_audit_rows,
    _seed_committed_graph,
    _seed_graph,
    _set_request,
)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]

def test_postgres_constraints_reject_self_and_active_duplicates(
    integration_db: Session, owned_ids: set[UUID]
) -> None:
    field, _, _, sources, targets = _seed_graph(integration_db, owned_ids)

    with pytest.raises(IntegrityError):
        with integration_db.begin_nested():
            integration_db.add(
                RelationshipEdge(
                    field_id=field.id,
                    source_record_id=sources[0].id,
                    target_record_id=sources[0].id,
                )
            )
            integration_db.flush()

    _add_edge(integration_db, owned_ids, field, sources[0], targets[0])
    with pytest.raises(IntegrityError):
        with integration_db.begin_nested():
            integration_db.add(
                RelationshipEdge(
                    field_id=field.id,
                    source_record_id=sources[0].id,
                    target_record_id=targets[0].id,
                )
            )
            integration_db.flush()

def test_postgres_partial_unique_allows_relink_after_soft_delete(
    integration_db: Session, owned_ids: set[UUID]
) -> None:
    field, _, _, sources, targets = _seed_graph(integration_db, owned_ids)
    original = _add_edge(integration_db, owned_ids, field, sources[0], targets[0])

    original.is_deleted = True
    original.deleted_at = datetime.now(UTC)
    integration_db.commit()
    replacement = _add_edge(integration_db, owned_ids, field, sources[0], targets[0])

    edges = list(
        integration_db.scalars(
            select(RelationshipEdge)
            .where(
                RelationshipEdge.field_id == field.id,
                RelationshipEdge.source_record_id == sources[0].id,
                RelationshipEdge.target_record_id == targets[0].id,
            )
        ).all()
    )
    assert {edge.id for edge in edges} == {original.id, replacement.id}
    assert sum(not edge.is_deleted for edge in edges) == 1

def test_service_cardinality_counts_hidden_archived_edges_as_reserved(
    integration_db: Session, owned_ids: set[UUID]
) -> None:
    field, _, target_module, sources, targets = _seed_graph(integration_db, owned_ids)
    _add_edge(integration_db, owned_ids, field, sources[0], targets[0])

    targets[0].is_deleted = True
    targets[0].deleted_at = datetime.now(UTC)
    new_target = Record(module_id=target_module.id, data={})
    integration_db.add(new_target)
    integration_db.flush()
    owned_ids.add(new_target.id)
    integration_db.commit()

    with pytest.raises(RelationshipConflict, match="Source already has"):
        create_relationship(integration_db, field.id, sources[0].id, new_target.id)

    assert integration_db.scalar(
        select(RelationshipEdge.id).where(
            RelationshipEdge.field_id == field.id,
            RelationshipEdge.source_record_id == sources[0].id,
            RelationshipEdge.is_deleted.is_(False),
        )
    ) is not None

def test_assignment_commits_delete_and_create_audits_same_request(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    field, _, target_module, sources, targets = _seed_graph(integration_db, owned_ids)
    original = create_relationship(integration_db, field.id, sources[0].id, targets[0].id)
    owned_ids.add(original.id)
    new_target = Record(module_id=target_module.id, data={})
    integration_db.add(new_target)
    integration_db.flush()
    owned_ids.add(new_target.id)
    integration_db.commit()

    request_id = uuid7()
    _set_request(integration_db, request_id)
    replacement = assign_relationship(integration_db, field.id, sources[0].id, new_target.id)
    assert replacement is not None
    owned_ids.add(replacement.id)

    integration_db.expire_all()
    original_after = integration_db.get(RelationshipEdge, original.id)
    replacement_after = integration_db.get(RelationshipEdge, replacement.id)
    assert original_after is not None and original_after.is_deleted is True
    assert replacement_after is not None and replacement_after.is_deleted is False

    rows = [
        row
        for row in _edge_audit_rows(integration_db, original.id, replacement.id)
        if row.request_id == request_id
    ]
    assert {row.action for row in rows} == {AuditAction.DELETE, AuditAction.CREATE}
    assert len(rows) == 2
    deleted = next(row for row in rows if row.action == AuditAction.DELETE)
    created = next(row for row in rows if row.action == AuditAction.CREATE)
    assert deleted.entity_id == original.id
    assert deleted.before is not None and deleted.before["is_deleted"] is False
    assert deleted.after is not None and deleted.after["is_deleted"] is True
    assert created.entity_id == replacement.id
    assert created.after is not None and created.after["target_record_id"] == str(new_target.id)

def test_assignment_rollback_removes_replacement_and_audit_mutations(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    field, _, target_module, sources, targets, original = _seed_committed_graph(
        owned_ids, with_edge=True
    )
    assert original is not None
    new_target = Record(module_id=target_module.id, data={})
    integration_db.add(new_target)
    integration_db.flush()
    owned_ids.add(new_target.id)
    integration_db.commit()

    request_id = uuid7()
    _set_request(integration_db, request_id)

    def flush_then_fail() -> None:
        integration_db.flush()
        raise IntegrityError("forced integration rollback", {}, RuntimeError("forced"))

    with patch.object(integration_db, "commit", side_effect=flush_then_fail):
        with pytest.raises(RelationshipConflict, match="Unable to assign"):
            assign_relationship(integration_db, field.id, sources[0].id, new_target.id)

    integration_db.expire_all()
    active_edges = list(
        integration_db.scalars(
            select(RelationshipEdge).where(
                RelationshipEdge.field_id == field.id,
                RelationshipEdge.is_deleted.is_(False),
            )
        ).all()
    )
    assert [edge.id for edge in active_edges] == [original.id]
    assert not [row for row in _edge_audit_rows(integration_db, original.id)
                if row.request_id == request_id]

def test_relationship_list_filters_visibility_and_pagination_in_postgresql(
    integration_db: Session, owned_ids: set[UUID]
) -> None:
    field, _, _, sources, targets = _seed_graph(
        integration_db, owned_ids, record_count=4
    )
    edges = [
        _add_edge(integration_db, owned_ids, field, source, target)
        for source, target in zip(sources, targets, strict=True)
    ]
    targets[2].is_deleted = True
    targets[2].deleted_at = datetime.now(UTC)
    edges[3].is_deleted = True
    edges[3].deleted_at = datetime.now(UTC)
    integration_db.commit()

    visible, visible_page = list_relationships(
        integration_db,
        RelationshipListRequest(field_id=field.id),
    )
    assert {item.id for item in visible} == {edges[0].id, edges[1].id}
    assert visible_page.total == 2

    hidden, hidden_page = list_relationships(
        integration_db,
        RelationshipListRequest(
            field_id=field.id,
            availability=RelationshipAvailability.HIDDEN,
        ),
    )
    assert [item.id for item in hidden] == [edges[2].id]
    assert hidden_page.total == 1

    all_items, all_page = list_relationships(
        integration_db,
        RelationshipListRequest(
            field_id=field.id,
            source_module_id=field.module_id,
            target_module_id=field.relationship_target_module_id,
            availability=RelationshipAvailability.ALL,
            deleted="include",
            limit=2,
            offset=1,
        ),
    )
    assert len(all_items) == 2
    assert all_page.total == 4
    assert all_page.count == 2
    assert all_page.has_more is True
