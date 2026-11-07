"""The catalog shape of the partitioned audit table (DBI-12, D4, D20)."""

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.orm import Session

from tests.migrations.audit_partition_support import (
    DEFAULT_PARTITION,
    leaf_names,
    month_starts,
    partition_name,
)

pytestmark = pytest.mark.integration

ON_PARENT = "ON ONLY public.audit_logs USING btree"
INDEXES = {
    "audit_logs_pkey": f"CREATE UNIQUE INDEX audit_logs_pkey {ON_PARENT} (id, created_at)",
    "ix_audit_logs_action": f"CREATE INDEX ix_audit_logs_action {ON_PARENT} (action)",
    "ix_audit_logs_actor": (
        f"CREATE INDEX ix_audit_logs_actor {ON_PARENT} (performed_by, created_at) "
        "WHERE (performed_by IS NOT NULL)"
    ),
    "ix_audit_logs_created_at_id": (
        f"CREATE INDEX ix_audit_logs_created_at_id {ON_PARENT} (created_at, id)"
    ),
    "ix_audit_logs_department_created_at_id": (
        f"CREATE INDEX ix_audit_logs_department_created_at_id {ON_PARENT} "
        "(department_id, created_at, id) WHERE (department_id IS NOT NULL)"
    ),
    "ix_audit_logs_entity": (
        f"CREATE INDEX ix_audit_logs_entity {ON_PARENT} (entity_type, entity_id, created_at)"
    ),
    "ix_audit_logs_org_created_at_id": (
        f"CREATE INDEX ix_audit_logs_org_created_at_id {ON_PARENT} (org_id, created_at, id)"
    ),
    "ix_audit_logs_request": (
        f"CREATE INDEX ix_audit_logs_request {ON_PARENT} (request_id) "
        "WHERE (request_id IS NOT NULL)"
    ),
}
FOREIGN_KEYS = {
    "fk_audit_logs_org_id_organizations": (
        "FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT"
    ),
    "fk_audit_logs_performed_by_users": (
        "FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL"
    ),
}
ORGANIZATION_ROWS = (
    "((org_id IS NULL) OR (org_id = ( SELECT "
    "(NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS \"nullif\")))"
)


def _parent_indexes(connection: Connection) -> dict[str, str]:
    definitions = connection.execute(
        text("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'audit_logs'")
    )
    return dict(definitions.all())


def _constraints(connection: Connection, kind: str) -> dict[str, str]:
    rows = connection.execute(
        text(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = 'public.audit_logs'::regclass AND contype = :kind"
        ),
        {"kind": kind},
    )
    return dict(rows.all())


def test_the_parent_has_its_partition_key_indexes_constraints_and_policies(
    integration_owner_db: Session,
) -> None:
    connection = integration_owner_db.connection()
    key = connection.scalar(text("SELECT pg_get_partkeydef('public.audit_logs'::regclass)"))
    assert key == "RANGE (created_at)"
    assert _constraints(connection, "p") == {"audit_logs_pkey": "PRIMARY KEY (id, created_at)"}
    assert _parent_indexes(connection) == INDEXES
    assert _constraints(connection, "f") == FOREIGN_KEYS
    assert sorted(_constraints(connection, "c")) == [
        "ck_audit_logs_action",
        "ck_audit_logs_organization",
    ]
    assert _constraints(connection, "u") == {}
    grants = connection.execute(
        text(
            "SELECT grant_row.grantee::regrole::text, "
            "array_agg(grant_row.privilege_type ORDER BY grant_row.privilege_type) "
            "FROM pg_class AS c CROSS JOIN LATERAL aclexplode(c.relacl) AS grant_row "
            "WHERE c.oid = 'public.audit_logs'::regclass AND grant_row.grantee <> c.relowner "
            "GROUP BY grant_row.grantee"
        )
    )
    assert dict(grants.all()) == {"slateops_app": ["INSERT", "SELECT"]}

    policies = connection.execute(
        text(
            "SELECT policyname, cmd, roles::text[], qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = 'audit_logs' ORDER BY policyname"
        )
    ).all()
    assert [tuple(row) for row in policies] == [
        ("organization_appends", "INSERT", ["slateops_app"], None, "true"),
        ("organization_rows", "SELECT", ["slateops_app"], ORGANIZATION_ROWS, None),
    ]
    security = connection.execute(
        text(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE oid = 'public.audit_logs'::regclass"
        )
    ).one()
    assert tuple(security) == (True, False)


def test_a_default_partition_and_this_month_and_the_next_two_exist(
    integration_owner_db: Session,
) -> None:
    connection = integration_owner_db.connection()
    default = connection.scalar(
        text(
            "SELECT partdefid::regclass::text FROM pg_partitioned_table "
            "WHERE partrelid = 'public.audit_logs'::regclass"
        )
    )
    assert default == DEFAULT_PARTITION
    months = [partition_name(first_day) for first_day in month_starts(connection)]
    assert set(months) <= set(leaf_names(connection))


def test_each_leaf_is_closed_to_every_role_but_its_owner(integration_owner_db: Session) -> None:
    connection = integration_owner_db.connection()
    leaves = leaf_names(connection)
    assert DEFAULT_PARTITION in leaves
    grantees = dict(
        connection.execute(
            text(
                "SELECT c.relname, array_agg(DISTINCT grant_row.grantee::regrole::text) "
                "FROM pg_class AS c CROSS JOIN LATERAL aclexplode(c.relacl) AS grant_row "
                "WHERE c.relname = ANY(:leaves) AND c.relnamespace = 'public'::regnamespace "
                "GROUP BY c.relname"
            ),
            {"leaves": leaves},
        ).all()
    )
    assert grantees == dict.fromkeys(leaves, ["slateops_owner"])
    secured = connection.scalars(
        text(
            "SELECT c.relname FROM pg_class AS c WHERE c.relname = ANY(:leaves) "
            "AND c.relnamespace = 'public'::regnamespace AND c.relrowsecurity ORDER BY 1"
        ),
        {"leaves": leaves},
    )
    assert list(secured) == leaves


def test_each_leaf_has_a_child_of_every_parent_index(integration_owner_db: Session) -> None:
    connection = integration_owner_db.connection()
    leaves = leaf_names(connection)
    assert leaves
    for leaf in leaves:
        attached = connection.scalars(
            text(
                "SELECT parent.relname FROM pg_index AS leaf_index "
                "JOIN pg_inherits AS link ON link.inhrelid = leaf_index.indexrelid "
                "JOIN pg_class AS parent ON parent.oid = link.inhparent "
                "WHERE leaf_index.indrelid = to_regclass(:leaf)"
            ),
            {"leaf": f"public.{leaf}"},
        )
        assert sorted(attached) == sorted(INDEXES), leaf
