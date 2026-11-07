"""What the runtime role can do to the audit table and its partitions (K12, SEC-R6)."""

from collections.abc import Iterator
from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from uuid6 import uuid7

from app.core.database.organization_scope import apply_connection_scope
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.migrations.audit_partition_support import (
    DEFAULT_PARTITION,
    INSUFFICIENT_PRIVILEGE,
    AuditEngines,
    insert_audit_row,
    leaf_names,
    month_starts,
    partition_name,
    sqlstate,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration

PROVIDER_ROLES = ("anon", "authenticated", "service_role")
PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE")


@dataclass(frozen=True)
class _Organizations:
    engines: AuditEngines
    first: UUID
    second: UUID


@pytest.fixture
def organizations(audit_engines: AuditEngines) -> Iterator[_Organizations]:
    first, second = uuid7(), uuid7()
    ids = {"first": first, "second": second}
    with audit_engines.owner.begin() as connection:
        for org_id in (first, second):
            connection.execute(
                WorkspaceProfile.__table__.insert().values(
                    id=org_id,
                    slug=f"audit-{org_id}",
                    display_name="Audit",
                    timezone="UTC",
                    locale="en-US",
                )
            )
    try:
        yield _Organizations(audit_engines, first, second)
    finally:
        with audit_engines.owner.begin() as connection:
            where = "IN (:first, :second)"
            connection.execute(text(f"DELETE FROM public.audit_logs WHERE org_id {where}"), ids)
            connection.execute(text(f"DELETE FROM public.organizations WHERE id {where}"), ids)


def _denied(engines: AuditEngines, org_id: UUID, statement: str) -> str:
    with engines.runtime.connect() as connection:
        apply_connection_scope(connection, org_id)
        with pytest.raises(DBAPIError) as denied:
            connection.execute(text(statement))
        return str(sqlstate(denied.value))


def test_the_runtime_reads_and_appends_through_the_parent_and_nothing_else(
    organizations: _Organizations,
) -> None:
    world = organizations
    with world.engines.owner.connect() as connection:
        now_month = month_starts(connection, 1)[0]
        leaves = leaf_names(connection)
    assert leaves
    created_at = f"{now_month} 12:00:00+00"
    with world.engines.runtime.begin() as connection:
        apply_connection_scope(connection, world.first)
        first_row = insert_audit_row(connection, created_at, org_id=world.first)
    with world.engines.runtime.begin() as connection:
        apply_connection_scope(connection, world.second)
        second_row = insert_audit_row(connection, created_at, org_id=world.second)
    with world.engines.runtime.connect() as connection:
        apply_connection_scope(connection, world.first)
        visible = connection.scalars(
            text("SELECT id FROM public.audit_logs WHERE id IN (:mine, :other)"),
            {"mine": first_row, "other": second_row},
        )
        assert list(visible) == [first_row]

    for command in ("UPDATE public.audit_logs SET note = 'x'", "DELETE FROM public.audit_logs"):
        assert _denied(world.engines, world.first, command) == INSUFFICIENT_PRIVILEGE
    for leaf in leaves:
        for command in (
            f"SELECT 1 FROM public.{leaf}",
            f"INSERT INTO public.{leaf} (id, created_at, action, entity_type) "
            f"VALUES (gen_random_uuid(), '{created_at}', 'create', 'users')",
            f"UPDATE public.{leaf} SET note = 'x'",
            f"DELETE FROM public.{leaf}",
        ):
            assert _denied(world.engines, world.first, command) == INSUFFICIENT_PRIVILEGE, command


def test_no_provider_role_holds_a_privilege_on_any_leaf(audit_engines: AuditEngines) -> None:
    with audit_engines.owner.connect() as connection:
        leaves = leaf_names(connection)
        assert leaves
        held = [
            (role, leaf, privilege)
            for role in PROVIDER_ROLES
            for leaf in leaves
            for privilege in PRIVILEGES
            if connection.scalar(
                text("SELECT has_table_privilege(:role, to_regclass(:leaf), :privilege)"),
                {"role": role, "leaf": f"public.{leaf}", "privilege": privilege},
            )
        ]
    assert held == []


def test_each_row_goes_to_its_month_or_to_default_and_reads_through_the_parent(
    audit_engines: AuditEngines,
) -> None:
    with audit_engines.runtime.connect() as connection:
        # Installation rows, which every session reads; the rollback removes them.
        next_month = month_starts(connection, 2)[1]
        rows = {
            insert_audit_row(connection, f"{next_month} 00:00:00+00"): partition_name(next_month),
            insert_audit_row(connection, "2099-06-15 12:00:00+00"): DEFAULT_PARTITION,
            insert_audit_row(connection, "1999-06-15 12:00:00+00"): DEFAULT_PARTITION,
        }
        stored = connection.execute(
            text(
                "SELECT id, tableoid::regclass::text FROM public.audit_logs "
                "WHERE id = ANY(:ids)"
            ),
            {"ids": list(rows)},
        )
        assert dict(stored.all()) == rows
        connection.rollback()
