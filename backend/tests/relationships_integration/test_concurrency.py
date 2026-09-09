import os
from uuid import UUID

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.models import AuditLog
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.service import (
    RelationshipConflict,
    RelationshipUnavailable,
    create_relationship,
)
from tests.relationships_integration_support import (
    _edge_audit_rows,
    _guard_integration_database,
    _seed_committed_graph,
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

def test_relationship_operation_fails_nowait_behind_held_dependency_lock(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    field, _, _, sources, targets, _ = _seed_committed_graph(owned_ids)
    request_id = uuid7()
    _set_request(integration_db, request_id)
    database_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(database_url)
    holder_engine = create_engine(database_url)
    try:
        with holder_engine.connect() as holder_connection:
            holder = Session(bind=holder_connection)
            try:
                holder.scalar(
                    select(Record)
                    .where(Record.id == sources[0].id)
                    .with_for_update()
                )
                with pytest.raises(RelationshipUnavailable):
                    create_relationship(
                        integration_db,
                        field.id,
                        sources[0].id,
                        targets[0].id,
                    )
            finally:
                holder.rollback()
                holder.close()
    finally:
        holder_engine.dispose()

    assert integration_db.scalar(select(RelationshipEdge.id)) is None
    assert not [row for row in _edge_audit_rows(integration_db, field.id)
                if row.request_id == request_id]

def test_single_target_race_returns_unavailable_then_committed_conflict(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    field, _, _, sources, targets, _ = _seed_committed_graph(
        owned_ids, record_count=2
    )
    assert field.relationship_multiple_targets is False
    source = sources[0]
    holder_target = targets[0]
    competing_target = targets[1]
    competing_request_id = uuid7()
    _set_request(integration_db, competing_request_id)

    database_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(database_url)
    holder_engine = create_engine(database_url)
    try:
        with holder_engine.connect() as holder_connection:
            holder = AuditSession(bind=holder_connection, expire_on_commit=False)
            _set_request(holder, uuid7())
            try:
                held_source = holder.scalar(
                    select(Record)
                    .where(Record.id == source.id)
                    .with_for_update()
                )
                assert held_source is not None

                holder_edge = RelationshipEdge(
                    field_id=field.id,
                    source_record_id=source.id,
                    target_record_id=holder_target.id,
                )
                holder.add(holder_edge)
                holder.flush()
                owned_ids.add(holder_edge.id)

                with pytest.raises(RelationshipUnavailable) as unavailable:
                    create_relationship(
                        integration_db,
                        field.id,
                        source.id,
                        competing_target.id,
                    )
                assert unavailable.value.status_code == 503
                assert integration_db.scalar(
                    select(RelationshipEdge.id).where(
                        RelationshipEdge.field_id == field.id,
                        RelationshipEdge.source_record_id == source.id,
                        RelationshipEdge.target_record_id == competing_target.id,
                    )
                ) is None
                assert not integration_db.scalar(
                    select(AuditLog.id).where(
                        AuditLog.request_id == competing_request_id
                    )
                )

                holder.commit()
            finally:
                holder.rollback()
                holder.close()
    finally:
        holder_engine.dispose()

    with pytest.raises(RelationshipConflict) as conflict:
        create_relationship(
            integration_db,
            field.id,
            source.id,
            competing_target.id,
        )
    assert conflict.value.status_code == 409

    integration_db.expire_all()
    active_edges = list(
        integration_db.scalars(
            select(RelationshipEdge).where(
                RelationshipEdge.field_id == field.id,
                RelationshipEdge.is_deleted.is_(False),
            )
        ).all()
    )
    assert len(active_edges) <= 1
    assert [edge.id for edge in active_edges] == [holder_edge.id]
    assert not integration_db.scalar(
        select(AuditLog.id).where(AuditLog.request_id == competing_request_id)
    )
