"""The `audit_seals` table: its catalog shape and what the runtime may do to it (S1, S2, K28)."""

from collections.abc import Iterator
from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import apply_connection_scope
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.migrations.audit_partition_support import (
    INSUFFICIENT_PRIVILEGE,
    AuditEngines,
    sqlstate,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration

UNIQUE_VIOLATION = "23505"
BOUND = (
    "( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid "
    'AS "nullif")'
)
ORGANIZATION_ROWS = f"((org_id IS NULL) OR (org_id = {BOUND}))"
APPENDS = f"(((org_id IS NULL) OR (org_id = {BOUND})) AND (hour_start <= now()))"
CHECK_VIOLATION = "23514"
COLUMNS = [
    ("id", "uuid", "NO"),
    ("org_id", "uuid", "YES"),
    ("hour_start", "timestamp with time zone", "NO"),
    ("row_count", "bigint", "NO"),
    ("rows_hash", "bytea", "NO"),
    ("chain_hash", "bytea", "NO"),
    ("form", "smallint", "NO"),
    ("sealed_at", "timestamp with time zone", "NO"),
]
CONSTRAINTS = {
    "audit_seals_pkey": "PRIMARY KEY (id)",
    "ck_audit_seals_chain_hash": "CHECK ((octet_length(chain_hash) = 32))",
    "ck_audit_seals_row_count": "CHECK ((row_count >= 0))",
    "ck_audit_seals_rows_hash": "CHECK ((octet_length(rows_hash) = 32))",
    "ck_audit_seals_whole_hour": (
        "CHECK (((EXTRACT(epoch FROM hour_start) % (3600)::numeric) = (0)::numeric))"
    ),
    "fk_audit_seals_org_id_organizations": (
        "FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT"
    ),
    "uq_audit_seals_org_hour": "UNIQUE NULLS NOT DISTINCT (org_id, hour_start)",
}
_INSERT_SEAL = (
    "INSERT INTO public.audit_seals (id, org_id, hour_start, row_count, rows_hash, chain_hash, "
    "form, sealed_at) VALUES (gen_random_uuid(), {org}, '{hour}', 0, "
    "sha256(''::bytea), sha256(''::bytea), 1, now())"
)


def _insert_seal(org: UUID | None, hour: str) -> str:
    return _INSERT_SEAL.format(org=f"'{org}'" if org else "NULL", hour=hour)


def test_the_seal_table_has_its_columns_keys_policies_and_only_two_runtime_rights(
    integration_owner_db: Session,
) -> None:
    connection = integration_owner_db.connection()
    columns = connection.execute(
        text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'audit_seals' "
            "ORDER BY ordinal_position"
        )
    )
    assert [tuple(row) for row in columns] == COLUMNS
    constraints = connection.execute(
        text(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'public.audit_seals'::regclass"
        )
    )
    assert dict(constraints.all()) == CONSTRAINTS
    security = connection.execute(
        text(
            "SELECT relrowsecurity, relforcerowsecurity, relkind FROM pg_class "
            "WHERE oid = 'public.audit_seals'::regclass"
        )
    ).one()
    assert tuple(security) == (True, False, "r")
    policies = connection.execute(
        text(
            "SELECT policyname, cmd, roles::text[], qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = 'audit_seals' ORDER BY policyname"
        )
    )
    assert [tuple(row) for row in policies] == [
        ("organization_appends", "INSERT", ["slateops_app"], None, APPENDS),
        ("organization_rows", "SELECT", ["slateops_app"], ORGANIZATION_ROWS, None),
    ]
    grants = connection.execute(
        text(
            "SELECT grant_row.grantee::regrole::text, "
            "array_agg(grant_row.privilege_type ORDER BY grant_row.privilege_type) "
            "FROM pg_class AS c CROSS JOIN LATERAL aclexplode(c.relacl) AS grant_row "
            "WHERE c.oid = 'public.audit_seals'::regclass AND grant_row.grantee <> c.relowner "
            "GROUP BY grant_row.grantee"
        )
    )
    assert dict(grants.all()) == {"slateops_app": ["INSERT", "SELECT"]}


@dataclass(frozen=True)
class _Chains:
    engines: AuditEngines
    first: UUID
    second: UUID


@pytest.fixture
def chains(audit_engines: AuditEngines) -> Iterator[_Chains]:
    """Two organizations; the owner seals 2026-01-01 00:00 for both and the installation."""

    first, second = uuid7(), uuid7()
    ids = {"first": first, "second": second}
    with audit_engines.owner.begin() as connection:
        for org_id in (first, second):
            connection.execute(
                WorkspaceProfile.__table__.insert().values(
                    id=org_id, slug=f"seal-{org_id}", display_name="Seal", timezone="UTC",
                    locale="en-US",
                )
            )
        for org_id in (first, second, None):
            connection.execute(text(_insert_seal(org_id, "2026-01-01 00:00+00")))
    try:
        yield _Chains(audit_engines, first, second)
    finally:
        with audit_engines.owner.begin() as connection:
            connection.execute(
                text(
                    "DELETE FROM public.audit_seals WHERE org_id IN (:first, :second) "
                    "OR (org_id IS NULL AND hour_start < '2026-01-02')"
                ),
                ids,
            )
            connection.execute(
                text("DELETE FROM public.organizations WHERE id IN (:first, :second)"), ids
            )


def _refused(engines: AuditEngines, org_id: UUID, statement: str) -> str:
    with engines.runtime.connect() as connection:
        apply_connection_scope(connection, org_id)
        with pytest.raises(DBAPIError) as refused:
            connection.execute(text(statement))
        return str(sqlstate(refused.value))


def _visible(connection: Connection) -> set[UUID | None]:
    return set(connection.scalars(text("SELECT org_id FROM public.audit_seals")))


def test_the_runtime_reads_its_chains_and_only_adds_its_own_unsealed_hours(
    chains: _Chains,
) -> None:
    world = chains
    with world.engines.runtime.begin() as connection:
        apply_connection_scope(connection, world.first)
        assert _visible(connection) == {world.first, None}
        connection.execute(text(_insert_seal(world.first, "2026-01-01 01:00+00")))
        connection.execute(text(_insert_seal(None, "2026-01-01 01:00+00")))

    for statement in (
        "UPDATE public.audit_seals SET form = 2",
        "DELETE FROM public.audit_seals",
        "TRUNCATE public.audit_seals",
        _insert_seal(world.second, "2026-01-01 01:00+00"),
        # A seal for an hour that has not started (F1).
        _insert_seal(world.first, "2999-01-01 00:00+00"),
    ):
        assert _refused(world.engines, world.first, statement) == INSUFFICIENT_PRIVILEGE, statement
    # Off the whole hour: the chain hash holds whole seconds (F1).
    misaligned = _insert_seal(world.first, "2026-01-01 02:00:00.5+00")
    assert _refused(world.engines, world.first, misaligned) == CHECK_VIOLATION
    for org_id in (world.first, None):
        duplicate = _insert_seal(org_id, "2026-01-01 00:00+00")
        assert _refused(world.engines, world.first, duplicate) == UNIQUE_VIOLATION, org_id

    with world.engines.owner.connect() as connection:
        sealed = connection.execute(
            text(
                "SELECT org_id, count(*) FROM public.audit_seals "
                "WHERE org_id IN (:first, :second) OR hour_start < '2026-01-02' GROUP BY org_id"
            ),
            {"first": world.first, "second": world.second},
        )
        assert dict(sealed.all()) == {world.first: 2, world.second: 1, None: 2}
