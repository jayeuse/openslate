"""S15's exact application schema, search access paths and empty-data round trip."""


import pytest
from sqlalchemy import inspect, text

from tests.migrations.test_organization_root import COMMS_TABLES, ORGANIZATION_TABLES

pytestmark = pytest.mark.integration
CURRENT_COMMS_TABLES = {name for name in ORGANIZATION_TABLES if name.startswith("comms_")}


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


