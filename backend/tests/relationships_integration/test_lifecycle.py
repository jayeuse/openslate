import os
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.models import AuditAction
from app.systems.fields.models import Field
from app.systems.fields.router import restore_field, update_field
from app.systems.fields.schemas import FieldUpdate
from app.systems.lifecycle.exceptions import LifecycleError
from app.systems.lifecycle.schemas import LifecycleTargetType
from app.systems.lifecycle.service import close_lifecycle
from app.systems.modules.models import Module
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.service import (
    assign_relationship,
    lock_row,
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

def test_lock_row_refreshes_a_stale_module_before_revalidation(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    _, source_module, _, _, _, _ = _seed_committed_graph(owned_ids)
    stale = integration_db.get(Module, source_module.id)
    assert stale is not None

    database_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(database_url)
    holder_engine = create_engine(database_url)
    try:
        with holder_engine.begin() as connection:
            connection.execute(
                text("UPDATE public.modules SET is_deleted = true WHERE id = :id"),
                {"id": source_module.id},
            )
    finally:
        holder_engine.dispose()

    refreshed = lock_row(integration_db, Module, source_module.id)
    assert refreshed is stale
    assert refreshed is not None and refreshed.is_deleted is True


@pytest.mark.parametrize("operation", ["update", "delete", "restore"])

def test_field_lifecycle_fails_nowait_behind_parent_module_lock(
    operation: str,
    integration_db: AuditSession,
    owned_ids: set[UUID],
) -> None:
    detached_field, source_module, _, _, _, _ = _seed_committed_graph(owned_ids)
    field = integration_db.get(Field, detached_field.id)
    assert field is not None
    if operation == "restore":
        field.is_deleted = True
        field.deleted_at = datetime.now(UTC)
        integration_db.commit()

    database_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(database_url)
    holder_engine = create_engine(database_url)
    try:
        with holder_engine.connect() as holder_connection:
            holder = Session(bind=holder_connection)
            try:
                held = holder.scalar(
                    select(Module)
                    .where(Module.id == source_module.id)
                    .with_for_update()
                )
                assert held is not None
                with pytest.raises((HTTPException, LifecycleError)) as error:
                    if operation == "update":
                        update_field(field.id, FieldUpdate(name="Renamed"), None, integration_db)
                    elif operation == "delete":
                        close_lifecycle(
                            integration_db,
                            LifecycleTargetType.FIELD,
                            field.id,
                            None,
                        )
                    else:
                        restore_field(field.id, SimpleNamespace(id=None), integration_db)
            finally:
                holder.rollback()
                holder.close()
    finally:
        holder_engine.dispose()

    assert error.value.status_code == 503
    assert integration_db.get(Field, field.id) is not None

def test_clear_allows_hidden_target_module_and_audits_edge_soft_delete(
    integration_db: AuditSession, owned_ids: set[UUID]
) -> None:
    field, _, target_module, sources, targets, edge = _seed_committed_graph(
        owned_ids, with_edge=True
    )
    assert edge is not None

    targets[0].is_deleted = True
    targets[0].deleted_at = datetime.now(UTC)
    target_module.is_deleted = True
    target_module.deleted_at = datetime.now(UTC)
    integration_db.commit()

    request_id = uuid7()
    _set_request(integration_db, request_id)
    assert assign_relationship(integration_db, field.id, sources[0].id, None) is None

    integration_db.expire_all()
    archived_edge = integration_db.get(RelationshipEdge, edge.id)
    assert archived_edge is not None and archived_edge.is_deleted is True
    rows = [
        row for row in _edge_audit_rows(integration_db, edge.id) if row.request_id == request_id
    ]
    assert len(rows) == 1
    assert rows[0].action == AuditAction.DELETE
    assert rows[0].before is not None and rows[0].before["is_deleted"] is False
    assert rows[0].after is not None and rows[0].after["is_deleted"] is True
