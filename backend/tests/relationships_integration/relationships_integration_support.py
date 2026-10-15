import os
from collections.abc import Generator
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import bindparam, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.conftest import guarded_create_engine as create_engine
from tests.rbac.support import organization


def _guard_integration_database(database_url: str) -> None:
    """Keep owner cleanup constrained to the disposable local PostgreSQL database."""

    from tests.conftest import _guard_integration_database as guard

    guard(database_url)


def _owner_cleanup_database_url() -> str:
    """Select a guarded connection that owns relationship_edges for cleanup."""

    database_url = os.getenv("MIGRATION_DATABASE_URL")
    if database_url is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for owner fixture setup")
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
        "MIGRATION_DATABASE_URL"
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
                        text(
                            "DELETE FROM public.audit_logs "
                            "WHERE entity_id IN :ids OR org_id IN :ids"
                        ).bindparams(
                            bindparam("ids", expanding=True)
                        ),
                        {"ids": list(ids)},
                    )
                    connection.execute(
                        text("DELETE FROM public.organizations WHERE id IN :ids").bindparams(
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
    owns_organization = "rbac_organization" not in db.info
    org_id = organization(db).id
    if owns_organization:
        owned.add(org_id)
    department = Department(org_id=org_id, department_name=f"Relationship integration {token}")
    db.add(department)
    db.flush()

    source_module = Module(
        org_id=org_id,
        department_id=department.id,
        module_name=f"Source {token}",
    )
    target_module = Module(
        org_id=org_id,
        department_id=department.id,
        module_name=f"Target {token}",
    )
    db.add_all([source_module, target_module])
    db.flush()

    field = Field(
        org_id=org_id,
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
    sources = [Record(org_id=org_id, module_id=source_module.id, data={})
               for _ in range(record_count)]
    targets = [Record(org_id=org_id, module_id=target_module.id, data={})
               for _ in range(record_count)]
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
        org_id=field.org_id,
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
