import os
from uuid import UUID

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from app.systems.sandbox.relationships.service import (
    RelationshipConflict,
    RelationshipUnavailable,
    create_relationship,
)
from tests.conftest import guarded_create_engine as create_engine
from tests.relationships_integration.relationships_integration_support import (
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
                    org_id=field.org_id,
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
