import os
from collections.abc import Generator
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

import pytest
from fastapi import HTTPException
from sqlalchemy import bindparam, create_engine, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.departments.models import Department
from app.systems.fields.models import Field, FieldType
from app.systems.fields.router import delete_field, restore_field, update_field
from app.systems.fields.schemas import FieldUpdate
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.schemas import (
    RelationshipAvailability,
    RelationshipListRequest,
)
from app.systems.relationships.service import (
    RelationshipConflict,
    RelationshipUnavailable,
    assign_relationship,
    create_relationship,
    list_relationships,
    lock_row,
)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def _guard_integration_database(database_url: str) -> None:
    """Keep owner cleanup constrained to the disposable local Supabase database."""

    from tests.conftest import _guard_integration_database as guard

    guard(database_url)


def _owner_cleanup_database_url() -> str:
    """Select a guarded connection that owns relationship_edges for cleanup."""

    for variable in ("MIGRATION_DATABASE_URL", "TEST_DATABASE_URL"):
        database_url = os.getenv(variable)
        if database_url is None:
            continue
        _guard_integration_database(database_url)
        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                is_owner = connection.scalar(
                    text(
                        """
                        SELECT current_user = pg_get_userbyid(c.relowner)
                        FROM pg_class AS c
                        JOIN pg_namespace AS n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname = 'relationship_edges'
                        """
                    )
                )
                if is_owner is True:
                    return database_url
        finally:
            engine.dispose()

    raise RuntimeError(
        "No owner-capable relationship cleanup URL exists; set "
        "MIGRATION_DATABASE_URL or use an owner-capable TEST_DATABASE_URL"
    )


@pytest.fixture  # type: ignore[untyped-decorator]
def owned_ids(integration_db: Session) -> Generator[set[UUID], None, None]:
    """Clean only rows committed by service calls with an owner connection."""

    ids: set[UUID] = set()
    try:
        yield ids
    finally:
        integration_db.rollback()
        # The shared integration fixture uses a savepoint so lifecycle
        # services can exercise commit/rollback behavior. Release its outer
        # transaction before owner-level cleanup opens another connection.
        integration_db.connection().rollback()
        if ids:
            database_url = _owner_cleanup_database_url()
            engine = create_engine(database_url)
            try:
                with engine.begin() as connection:
                    for table in (
                        "relationship_edges",
                        "fields",
                        "records",
                        "modules",
                        "departments",
                    ):
                        connection.execute(
                            text(f"DELETE FROM public.{table} WHERE id IN :ids").bindparams(
                                bindparam("ids", expanding=True)
                            ),
                            {"ids": list(ids)},
                        )
                    connection.execute(
                        text("DELETE FROM public.audit_logs WHERE entity_id IN :ids").bindparams(
                            bindparam("ids", expanding=True)
                        ),
                        {"ids": list(ids)},
                    )
            finally:
                engine.dispose()


def _set_request(session: Session, request_id: UUID) -> None:
    session.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=request_id,
        request_method="POST",
        request_path="/api/relationships",
    )


def _seed_graph(
    db: Session,
    owned: set[UUID],
    *,
    record_count: int = 1,
) -> tuple[Field, Module, Module, list[Record], list[Record]]:
    token = str(uuid7())
    department = Department(department_name=f"Relationship integration {token}")
    db.add(department)
    db.flush()

    source_module = Module(
        department_id=department.id,
        module_name=f"Source {token}",
    )
    target_module = Module(
        department_id=department.id,
        module_name=f"Target {token}",
    )
    db.add_all([source_module, target_module])
    db.flush()

    field = Field(
        module_id=source_module.id,
        name=f"Related {token}",
        type=FieldType.RELATIONSHIP,
        required=False,
        position=0,
        config={},
        relationship_target_module_id=target_module.id,
        relationship_multiple_targets=False,
        relationship_multiple_sources=False,
    )
    sources = [Record(module_id=source_module.id, data={}) for _ in range(record_count)]
    targets = [Record(module_id=target_module.id, data={}) for _ in range(record_count)]
    db.add_all([field, *sources, *targets])
    db.flush()
    owned.update(
        {
            department.id,
            source_module.id,
            target_module.id,
            field.id,
            *(record.id for record in sources),
            *(record.id for record in targets),
        }
    )
    db.commit()
    return field, source_module, target_module, sources, targets


def _seed_committed_graph(
    owned: set[UUID],
    *,
    record_count: int = 1,
    with_edge: bool = False,
) -> tuple[Field, Module, Module, list[Record], list[Record], RelationshipEdge | None]:
    database_url = os.environ["TEST_DATABASE_URL"]
    _guard_integration_database(database_url)
    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            session = AuditSession(bind=connection, expire_on_commit=False)
            _set_request(session, uuid7())
            try:
                graph = _seed_graph(session, owned, record_count=record_count)
                edge = _add_edge(session, owned, graph[0], graph[3][0], graph[4][0]) \
                    if with_edge else None
                return (*graph, edge)
            finally:
                session.close()
    finally:
        engine.dispose()


def _add_edge(
    db: Session,
    owned: set[UUID],
    field: Field,
    source: Record,
    target: Record,
    *,
    deleted: bool = False,
) -> RelationshipEdge:
    edge = RelationshipEdge(
        field_id=field.id,
        source_record_id=source.id,
        target_record_id=target.id,
        is_deleted=deleted,
        deleted_at=datetime.now(UTC) if deleted else None,
    )
    db.add(edge)
    db.flush()
    owned.add(edge.id)
    db.commit()
    return edge


def _edge_audit_rows(db: Session, *entity_ids: UUID) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "relationship_edges",
                AuditLog.entity_id.in_(entity_ids),
            )
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


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
                with pytest.raises(HTTPException) as error:
                    if operation == "update":
                        update_field(field.id, FieldUpdate(name="Renamed"), None, integration_db)
                    elif operation == "delete":
                        delete_field(field.id, None, integration_db)
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


def test_relationship_migration_security_contract_matches_catalog(
    integration_db: Session, owned_ids: set[UUID]
) -> None:
    connection = integration_db.connection()
    relation = connection.execute(
        text(
            """
            SELECT current_user AS database_role,
                   pg_get_userbyid(c.relowner) AS owner_role,
                   c.relrowsecurity AS rls_enabled,
                   current_user = pg_get_userbyid(c.relowner) AS is_owner,
                   'openslate_runtime' = pg_get_userbyid(c.relowner) AS runtime_is_owner
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'relationship_edges'
            """
        )
    ).mappings().one()
    assert relation["rls_enabled"] is True
    assert relation["runtime_is_owner"] is False
    assert relation["database_role"] in {relation["owner_role"], "openslate_runtime"}
    assert relation["is_owner"] is (relation["database_role"] == relation["owner_role"])

    if relation["database_role"] == "openslate_runtime":
        runtime_privileges = connection.execute(
            text(
                """
                SELECT has_table_privilege('openslate_runtime',
                           'public.relationship_edges', 'SELECT') AS can_select,
                       has_table_privilege('openslate_runtime',
                           'public.relationship_edges', 'INSERT') AS can_insert,
                       has_table_privilege('openslate_runtime',
                           'public.relationship_edges', 'UPDATE') AS can_update,
                       has_table_privilege('openslate_runtime',
                           'public.relationship_edges', 'DELETE') AS can_delete
                """
            )
        ).mappings().one()
        assert dict(runtime_privileges) == {
            "can_select": True,
            "can_insert": True,
            "can_update": True,
            "can_delete": True,
        }

    privileges = connection.execute(
        text(
            """
            SELECT has_table_privilege('openslate_app',
                       'public.relationship_edges', 'SELECT') AS can_select,
                   has_table_privilege('openslate_app',
                       'public.relationship_edges', 'INSERT') AS can_insert,
                   has_table_privilege('openslate_app',
                       'public.relationship_edges', 'UPDATE') AS can_update,
                   has_table_privilege('openslate_app',
                       'public.relationship_edges', 'DELETE') AS can_delete
            """
        )
    ).mappings().one()
    assert dict(privileges) == {
        "can_select": True,
        "can_insert": True,
        "can_update": True,
        "can_delete": True,
    }

    for role in ("anon", "authenticated", "service_role"):
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert connection.scalar(
                text(
                    "SELECT has_table_privilege(:role, "
                    "'public.relationship_edges', :privilege)"
                ),
                {"role": role, "privilege": privilege},
            ) is False

    policies = connection.execute(
        text(
            """
            SELECT policyname, cmd, roles::text AS roles
            FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'relationship_edges'
            """
        )
    ).mappings().all()
    assert {
        (row["policyname"], row["cmd"], row["roles"])
        for row in policies
    } == {
        ("openslate_app_relationship_edges_select", "SELECT", "{openslate_app}"),
        ("openslate_app_relationship_edges_insert", "INSERT", "{openslate_app}"),
        ("openslate_app_relationship_edges_update", "UPDATE", "{openslate_app}"),
        ("openslate_app_relationship_edges_delete", "DELETE", "{openslate_app}"),
    }

    indexes = {
        row["indexname"]: row["indexdef"]
        for row in connection.execute(
            text(
                "SELECT indexname, indexdef FROM pg_indexes "
                "WHERE schemaname = 'public' AND tablename = 'relationship_edges'"
            )
        ).mappings()
    }
    assert {
        "uq_relationship_edges_active",
        "ix_relationship_edges_active_source",
        "ix_relationship_edges_active_target",
    } <= indexes.keys()
    assert "unique" in indexes["uq_relationship_edges_active"].casefold()
    assert all(
        "is_deleted = false" in indexes[name]
        for name in (
            "uq_relationship_edges_active",
            "ix_relationship_edges_active_source",
            "ix_relationship_edges_active_target",
        )
    )

    constraints = {
        row["conname"]: row["definition"]
        for row in connection.execute(
            text(
                """
                SELECT conname, pg_get_constraintdef(oid) AS definition
                FROM pg_constraint
                WHERE conrelid = 'public.relationship_edges'::regclass
                """
            )
        ).mappings()
    }
    assert "ck_relationship_edges_distinct_records" in constraints
    assert "source_record_id <> target_record_id" in constraints[
        "ck_relationship_edges_distinct_records"
    ]
