"""S15's exact application schema, search access paths and empty-data round trip."""

import os

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.migrations.test_organization_root import COMMS_TABLES, ORGANIZATION_TABLES
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BASELINE = "226847298ae4"
CURRENT_COMMS_TABLES = {name for name in ORGANIZATION_TABLES if name.startswith("comms_")}
# Later revisions that are not Comms also change the table set, and the
# downgrade to BASELINE passes through them: the Boards relayout removed board
# widgets and added the Kanban and calendar sources.
LATER_ADDED_TABLES = {
    "board_stages",
    "board_cards",
    "board_labels",
    "board_card_labels",
    "board_card_checklist_items",
    "board_calendar_sources",
}
LATER_REMOVED_TABLES = {"board_widgets"}


def test_comms_inventory_contains_the_foundation_and_current_approved_extensions(
    integration_owner_db,
):
    tables = inspect(integration_owner_db.connection()).get_table_names(schema="public")
    assert {name for name in tables if name.startswith("comms_")} == CURRENT_COMMS_TABLES
    assert len(COMMS_TABLES) == 19


def test_message_search_and_feed_indexes_exist_on_the_actual_database(integration_owner_db):
    connection = integration_owner_db.connection()
    columns = {
        column["name"]: column
        for column in inspect(connection).get_columns(
            "comms_messages",
            schema="public",
        )
    }
    generated = columns["body_tsv"]["computed"]
    assert generated["persisted"] is True
    assert "to_tsvector" in generated["sqltext"]
    assert "simple" in generated["sqltext"]
    indexes = connection.execute(
        text("""
        SELECT am.amname, ARRAY(
            SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
            JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
            ORDER BY k.position
        ) AS columns, pg_get_expr(i.indpred,i.indrelid) AS predicate
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        JOIN pg_am am ON am.oid=c.relam
        WHERE i.indrelid='public.comms_messages'::regclass AND i.indisvalid
    """)
    ).all()
    assert any(method == "gin" and names == ["body_tsv"] for method, names, _ in indexes)
    assert any(
        method == "btree" and names == ["author_id", "created_at"] and predicate is None
        for method, names, predicate in indexes
    )
    assert any(names[-2:] == ["parent_id", "seq"] for _, names, _ in indexes)
    assert any(
        names[:2] == ["org_id", "conversation_id"]
        and "seq" in names
        and predicate
        and "parent_id IS NULL" in predicate
        and "is_deleted" in predicate
        for _, names, predicate in indexes
    )


def _provider_catalog(connection):
    # Structural catalogs only: no provider records, secrets or credential columns.
    schemas = connection.execute(
        text("""
        SELECT nspname,nspowner::regrole::text,nspacl::text FROM pg_namespace
         WHERE nspname IN ('auth','storage','realtime') ORDER BY nspname
    """)
    ).all()
    relations = connection.execute(
        text("""
        SELECT n.nspname,c.relname,c.relkind,c.relowner::regrole::text,
               c.relacl::text,c.relrowsecurity,c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname IN ('auth','storage','realtime') ORDER BY 1,2
    """)
    ).all()
    routines = connection.execute(
        text("""
        SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),
               p.proowner::regrole::text,p.proacl::text,p.prosecdef
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname IN ('auth','storage','realtime') ORDER BY 1,2,3
    """)
    ).all()
    roles = connection.execute(
        text("""
        SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls
          FROM pg_roles WHERE rolname IN
          ('openslate_owner','openslate_runtime','openslate_app','anon','authenticated',
           'service_role','supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin')
         ORDER BY rolname
    """)
    ).all()
    memberships = connection.execute(
        text("""
        SELECT roleid::regrole::text,member::regrole::text,admin_option,inherit_option,set_option
          FROM pg_auth_members ORDER BY 1,2
    """)
    ).all()
    policies = connection.execute(
        text("""
        SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
          FROM pg_policies WHERE schemaname IN ('auth','storage','realtime') ORDER BY 1,2,3
    """)
    ).all()
    return schemas, relations, routines, roles, memberships, policies


def test_empty_comms_downgrade_upgrade_removes_owned_triggers_without_provider_changes():
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    assert head != BASELINE, "S15 revision has not been generated"
    # No active fixture transaction may hold schema locks during the migration.
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT count(*) FROM organizations")) == 0
            for table in CURRENT_COMMS_TABLES:
                assert connection.scalar(text(f"SELECT count(*) FROM {table}")) == 0
            before = _provider_catalog(connection)
            non_comms = (
                set(inspect(connection).get_table_names(schema="public")) - CURRENT_COMMS_TABLES
            )
            triggers = connection.execute(
                text("""
                SELECT c.relname,p.oid::regprocedure::text
                  FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
                  JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname IN
                       ('comms_messages','comms_message_revisions') AND NOT t.tgisinternal
            """)
            ).all()
            assert {table for table, _ in triggers} == {
                "comms_messages",
                "comms_message_revisions",
            }, "missing revision/fingerprint immutability guards"
            functions = {function for _, function in triggers}
        run_alembic(environment, "downgrade", BASELINE)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == BASELINE
            assert (
                set(inspect(connection).get_table_names(schema="public"))
                == (non_comms - LATER_ADDED_TABLES) | LATER_REMOVED_TABLES
            )
            for function in functions:
                assert (
                    connection.scalar(text("SELECT to_regprocedure(:name)"), {"name": function})
                    is None
                )
            assert _provider_catalog(connection) == before
        run_alembic(environment, "upgrade", head)
        run_alembic(environment, "check")
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == head
            assert set(inspect(connection).get_table_names(schema="public")) == (
                non_comms | CURRENT_COMMS_TABLES
            )
            assert _provider_catalog(connection) == before
    finally:
        # Failure remains a failed disposable run; never guess a repair/stamp in finally.
        engine.dispose()
