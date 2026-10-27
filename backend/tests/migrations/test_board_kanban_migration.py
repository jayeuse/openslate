"""The Kanban migration adds five scoped tables and a card owner; a downgrade removes them."""

import os

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool

from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BEFORE_KANBAN = "4e015d0fb2ab"
TABLES = (
    "board_stages", "board_labels", "board_cards", "board_card_labels",
    "board_card_checklist_items",
)
CHECKS = {
    "board_stages": {
        "ck_board_stages_name_nonempty", "ck_board_stages_color", "ck_board_stages_wip_limit",
        "ck_board_stages_card_sort", "ck_board_stages_position",
        "ck_board_stages_revision_positive",
    },
    "board_labels": {
        "ck_board_labels_name_nonempty", "ck_board_labels_color", "ck_board_labels_position",
        "ck_board_labels_revision_positive",
    },
    "board_cards": {
        "ck_board_cards_kind", "ck_board_cards_kind_columns", "ck_board_cards_dates",
        "ck_board_cards_description_length", "ck_board_cards_revision_positive",
    },
    "board_card_labels": set(),
    "board_card_checklist_items": {
        "ck_board_card_checklist_items_text", "ck_board_card_checklist_items_position",
        "ck_board_card_checklist_items_revision_positive",
    },
}
PARTIAL_INDEXES = {
    "uq_board_stages_board_position_active": "archived_at IS NULL",
    "uq_board_cards_board_record_active": "record_id IS NOT NULL",
    "uq_board_cards_stage_rank_active": "archived_at IS NULL",
}


def _constraints(connection: Connection, table: str, kind: str) -> set[str]:
    return set(connection.scalars(
        text("SELECT conname FROM pg_constraint WHERE conrelid = to_regclass(:table) "
             "AND contype = :kind"),
        {"table": f"public.{table}", "kind": kind},
    ))


def _owner_check(connection: Connection, table: str) -> str:
    return str(connection.scalar(
        text("SELECT pg_get_constraintdef(oid) FROM pg_constraint "
             "WHERE conname = :name AND conrelid = to_regclass(:table)"),
        {"name": f"ck_{table}_one_owner", "table": f"public.{table}"},
    ))


def _guards_know_cards(connection: Connection) -> list[bool]:
    return [
        "card_id" in str(connection.scalar(
            text("SELECT pg_get_functiondef(to_regprocedure(:name))"), {"name": name}
        ))
        for name in (
            "public.board_record_link_guard()",
            "public.reject_board_attachment_owner_change()",
            "public.validate_board_attachment()",
        )
    ]


def test_upgrade_creates_scoped_kanban_tables_and_downgrade_removes_them() -> None:
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    assert head != BEFORE_KANBAN
    # No pooled fixture connection may hold locks while the schema changes.
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        run_alembic(environment, "downgrade", BEFORE_KANBAN)
        with engine.connect() as connection:
            for table in TABLES:
                assert connection.scalar(text(f"SELECT to_regclass('public.{table}')")) is None
            assert "num_nonnulls" not in _owner_check(connection, "board_record_links")
            assert _guards_know_cards(connection) == [False, False, False]
        run_alembic(environment, "upgrade", head)
        run_alembic(environment, "check")
        with engine.connect() as connection:
            assert _guards_know_cards(connection) == [True, True, True]
            for table in TABLES:
                assert connection.execute(text(
                    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                    "WHERE oid = to_regclass(:table)"
                ), {"table": f"public.{table}"}).one() == (True, False), table
                assert connection.scalars(text(
                    "SELECT policyname FROM pg_policies WHERE schemaname = 'public' "
                    "AND tablename = :table"
                ), {"table": table}).all() == ["organization_rows"], table
                assert CHECKS[table] <= _constraints(connection, table, "c"), table
                foreign = _constraints(connection, table, "f")
                assert f"fk_{table}_performed_by_users" in foreign, table
                assert f"fk_{table}_board_id_boards" in foreign, table
                assert connection.scalar(text(
                    "SELECT has_table_privilege('openslate_runtime', :table, 'INSERT')"
                ), {"table": f"public.{table}"}), table
            for index, predicate in PARTIAL_INDEXES.items():
                definition = str(connection.scalar(
                    text("SELECT indexdef FROM pg_indexes WHERE indexname = :name"),
                    {"name": index},
                ))
                assert "UNIQUE" in definition and predicate in definition, index
            for table in ("board_attachments", "board_record_links"):
                assert "num_nonnulls(event_id, post_id, card_id) = 1" in _owner_check(
                    connection, table
                )
                assert f"fk_{table}_card_id_board_cards" in _constraints(connection, table, "f")

        run_alembic(environment, "downgrade", BEFORE_KANBAN)
        with engine.connect() as connection:
            for table in TABLES:
                assert connection.scalar(text(f"SELECT to_regclass('public.{table}')")) is None
            for table in ("board_attachments", "board_record_links"):
                assert connection.scalar(text(
                    "SELECT count(*) FROM information_schema.columns WHERE table_schema = "
                    "'public' AND table_name = :table AND column_name = 'card_id'"
                ), {"table": table}) == 0
                assert "num_nonnulls" not in _owner_check(connection, table)
            assert _guards_know_cards(connection) == [False, False, False]
    finally:
        run_alembic(environment, "upgrade", head)
        engine.dispose()
