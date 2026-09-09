import os
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]

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
