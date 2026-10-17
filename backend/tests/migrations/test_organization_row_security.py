"""Row-level security keeps each transaction inside the organization bound to it."""

from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import Engine, inspect, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import (
    apply_connection_scope,
    scope_session,
    worker_organization,
)
from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from tests.conftest import guarded_create_engine
from tests.migrations.test_organization_root import MIXED_TABLES, ORGANIZATION_TABLES

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class _TwoOrganizations:
    owner: Engine
    runtime: Engine
    first: UUID
    second: UUID
    first_department: UUID
    second_department: UUID


@pytest.fixture
def two_organizations() -> Iterator[_TwoOrganizations]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    first, second = uuid7(), uuid7()
    first_department, second_department = uuid7(), uuid7()
    with owner.begin() as connection:
        for org_id in (first, second):
            connection.execute(WorkspaceProfile.__table__.insert().values(
                id=org_id, slug=f"rls-{org_id}", display_name="RLS", timezone="UTC",
                locale="en-US",
            ))
        for org_id, department_id in ((first, first_department), (second, second_department)):
            connection.execute(Department.__table__.insert().values(
                id=department_id, org_id=org_id, department_name=f"RLS {department_id.hex}",
            ))
    try:
        yield _TwoOrganizations(owner, runtime, first, second, first_department, second_department)
    finally:
        with owner.begin() as connection:
            for table in ("audit_logs", "departments"):
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE org_id IN (:first, :second)"),
                    {"first": first, "second": second},
                )
            connection.execute(
                text("DELETE FROM public.organizations WHERE id IN (:first, :second)"),
                {"first": first, "second": second},
            )
        owner.dispose()
        runtime.dispose()


def _department_ids(connection, world: _TwoOrganizations) -> set[UUID]:
    return set(connection.scalars(
        text("SELECT id FROM public.departments WHERE org_id IN (:first, :second)"),
        {"first": world.first, "second": world.second},
    ))


def test_every_organization_table_has_row_security_except_memberships(integration_owner_db):
    rows = integration_owner_db.connection().execute(text(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class "
        "WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'"
    )).all()
    protected = {name for name, enabled, _ in rows if enabled}
    assert protected == ORGANIZATION_TABLES - {"memberships"}
    assert not any(forced for _, _, forced in rows)
    inspector = inspect(integration_owner_db.connection())
    for table in protected:
        assert "org_id" in {column["name"] for column in inspector.get_columns(table, "public")}
    assert MIXED_TABLES <= protected


def test_runtime_reads_only_the_bound_organization(two_organizations):
    world = two_organizations
    with world.runtime.connect() as connection:
        assert _department_ids(connection, world) == set()
        connection.rollback()
        apply_connection_scope(connection, world.first)
        assert _department_ids(connection, world) == {world.first_department}
        connection.rollback()
        apply_connection_scope(connection, world.second)
        assert _department_ids(connection, world) == {world.second_department}
        connection.commit()
        # The setting is transaction-local, so the pooled connection does not keep it.
        assert _department_ids(connection, world) == set()
    with world.owner.connect() as connection:
        assert _department_ids(connection, world) == {
            world.first_department, world.second_department,
        }


def test_runtime_cannot_write_into_another_organization(two_organizations):
    world = two_organizations
    with world.runtime.connect() as connection:
        apply_connection_scope(connection, world.first)
        with pytest.raises(ProgrammingError, match="row-level security"):
            connection.execute(Department.__table__.insert().values(
                id=uuid7(), org_id=world.second, department_name="Elsewhere",
            ))
        connection.rollback()
        apply_connection_scope(connection, world.first)
        moved = connection.execute(
            text("UPDATE public.departments SET department_name = 'moved' WHERE id = :id"),
            {"id": world.second_department},
        )
        assert moved.rowcount == 0
        connection.rollback()


def test_session_scope_survives_commit_and_rollback(two_organizations):
    world = two_organizations
    with AuditSession(world.runtime) as db:
        scope_session(db, world.first)
        assert db.get(Department, world.first_department) is not None
        db.commit()
        assert db.get(Department, world.second_department) is None
        db.rollback()
        current = text("SELECT current_setting('openslate.org_id', true)")
        assert db.connection().scalar(current) == str(world.first)
    with AuditSession(world.runtime) as db:
        assert db.get(Department, world.first_department) is None


def test_worker_organization_binds_sessions_and_raw_connections(two_organizations):
    world = two_organizations
    with worker_organization(world.second):
        with AuditSession(world.runtime) as db:
            assert db.get(Department, world.second_department) is not None
            assert db.get(Department, world.first_department) is None
        with Session(world.runtime) as db:
            assert db.get(Department, world.second_department) is not None
        with world.runtime.begin() as connection:
            assert _department_ids(connection, world) == {world.second_department}
    with AuditSession(world.runtime) as db:
        assert db.get(Department, world.second_department) is None
    with world.runtime.connect() as connection:
        assert _department_ids(connection, world) == set()


def test_audit_rows_append_for_any_organization_but_read_only_in_scope(two_organizations):
    world = two_organizations
    with AuditSession(world.runtime) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(request_id=uuid7())
        scope_session(db, world.first)
        department = db.get(Department, world.first_department)
        assert department is not None
        department.department_name = "Audited"
        db.commit()
    audited = text("SELECT count(*) FROM public.audit_logs WHERE org_id = :org_id")
    with world.runtime.connect() as connection:
        apply_connection_scope(connection, world.second)
        assert connection.scalar(audited, {"org_id": world.first}) == 0
        connection.rollback()
        apply_connection_scope(connection, world.first)
        assert connection.scalar(audited, {"org_id": world.first}) >= 1
