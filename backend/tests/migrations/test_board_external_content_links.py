"""External-link migration safety on runner-owned PostgreSQL."""

import subprocess
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "56e5accc6972"
TARGET_REVISION = "fbef83381635"
ACCESS_HEAD_REVISION = "2bf95b237416"
TABLES = (
    "board_events",
    "board_announcements",
    "board_announcement_revisions",
)
LINK = '[{"label":"Guide","url":"https://example.test/guide"}]'


@pytest.mark.integration
def test_external_link_upgrade_privileges_and_lossless_downgrade() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    ids = {
        name: uuid7()
        for name in (
            "owner",
            "department",
            "board",
            "event",
            "announcement",
            "revision",
            "new_event",
            "new_announcement",
            "new_revision",
        )
    }

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        _seed_source_rows(owner_engine, ids)

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            _assert_source_rows(connection, ids, links_present=True)
            _assert_link_columns_and_privileges(connection)
        with inspector_engine.connect() as connection:
            for table, key in (
                ("board_events", "event"),
                ("board_announcements", "announcement"),
                ("board_announcement_revisions", "revision"),
            ):
                assert (
                    connection.scalar(
                        text(f"SELECT links FROM public.{table} WHERE id = :id"),
                        {"id": ids[key]},
                    )
                    == []
                )

        _exercise_runtime_dml(runtime_engine, ids)

        with runtime_engine.begin() as connection:
            connection.execute(
                text("UPDATE public.board_events SET links = CAST(:links AS jsonb) WHERE id = :id"),
                {"links": LINK, "id": ids["event"]},
            )
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            assert connection.scalar(
                text("SELECT links FROM public.board_events WHERE id = :id"),
                {"id": ids["event"]},
            ) == [{"label": "Guide", "url": "https://example.test/guide"}]
            _assert_source_rows(connection, ids, links_present=True, event_link=True)

        with runtime_engine.begin() as connection:
            connection.execute(
                text("UPDATE public.board_events SET links = '[]'::jsonb WHERE id = :id"),
                {"id": ids["event"]},
            )
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, SOURCE_REVISION}
            _assert_source_rows(connection, ids, links_present=False)
            for table in TABLES:
                assert (
                    connection.scalar(
                        text(
                            "SELECT count(*) FROM information_schema.columns "
                            "WHERE table_schema = 'public' AND table_name = :table "
                            "AND column_name = 'links'"
                        ),
                        {"table": table},
                    )
                    == 0
                )

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            _assert_source_rows(connection, ids, links_present=True)
            _assert_link_columns_and_privileges(connection)
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            _delete_source_rows(owner_engine, ids)
            inspector_engine.dispose()
            runtime_engine.dispose()
            owner_engine.dispose()


def _seed_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        role_id = connection.scalar(text("SELECT id FROM public.roles WHERE role = 'member'"))
        assert role_id is not None
        connection.execute(
            text(
                "INSERT INTO public.users (id, email, username, status, role_id) "
                "VALUES (:id, :email, :username, 'active', :role_id)"
            ),
            {
                "id": ids["owner"],
                "email": f"link-migration-{ids['owner'].hex}@example.test",
                "username": f"link-migration-{ids['owner'].hex}",
                "role_id": role_id,
            },
        )
        connection.execute(
            text("INSERT INTO public.departments (id, department_name) VALUES (:id, :name)"),
            {"id": ids["department"], "name": "Link migration source"},
        )
        connection.execute(
            text(
                "INSERT INTO public.boards (id, owner_id, department_id, name, status) "
                "VALUES (:id, :owner, :department, 'Existing Board', 'active')"
            ),
            {
                "id": ids["board"],
                "owner": ids["owner"],
                "department": ids["department"],
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.board_events "
                "(id, board_id, author_id, title, all_day, start_date, end_date, "
                "timezone_name, audience_kind) "
                "VALUES (:id, :board, :owner, 'Existing Event', true, "
                "DATE '2026-09-23', DATE '2026-09-23', 'UTC', 'everyone')"
            ),
            {"id": ids["event"], "board": ids["board"], "owner": ids["owner"]},
        )
        connection.execute(
            text(
                "INSERT INTO public.board_announcements "
                "(id, board_id, author_id, title, body, status, audience_kind, "
                "displayed_publication_number) "
                "VALUES (:id, :board, :owner, 'Existing Announcement', 'Retained body', "
                "'published', 'everyone', 1)"
            ),
            {"id": ids["announcement"], "board": ids["board"], "owner": ids["owner"]},
        )
        connection.execute(
            text(
                "INSERT INTO public.board_announcement_revisions "
                "(id, announcement_id, publication_number, publication_key, "
                "content_fingerprint, author_id, title, body, audience_kind, published_at) "
                "VALUES (:id, :announcement, 1, :key, :fingerprint, :owner, "
                "'Existing Announcement', 'Retained body', 'everyone', now())"
            ),
            {
                "id": ids["revision"],
                "announcement": ids["announcement"],
                "key": uuid7(),
                "fingerprint": "a" * 64,
                "owner": ids["owner"],
            },
        )


def _assert_source_rows(
    connection: Connection,
    ids: dict[str, UUID],
    *,
    links_present: bool,
    event_link: bool = False,
) -> None:
    for table, key, title in (
        ("board_events", "event", "Existing Event"),
        ("board_announcements", "announcement", "Existing Announcement"),
        ("board_announcement_revisions", "revision", "Existing Announcement"),
    ):
        fields = "title, links" if links_present else "title"
        row = connection.execute(
            text(f"SELECT {fields} FROM public.{table} WHERE id = :id"),
            {"id": ids[key]},
        ).one()
        assert row[0] == title
        if links_present:
            expected_links = (
                [{"label": "Guide", "url": "https://example.test/guide"}]
                if key == "event" and event_link
                else []
            )
            assert row[1] == expected_links
    assert connection.execute(
        text(
            "SELECT status, body, displayed_publication_number "
            "FROM public.board_announcements WHERE id = :id"
        ),
        {"id": ids["announcement"]},
    ).one() == ("published", "Retained body", 1)
    assert connection.execute(
        text(
            "SELECT announcement_id, publication_number, body "
            "FROM public.board_announcement_revisions WHERE id = :id"
        ),
        {"id": ids["revision"]},
    ).one() == (ids["announcement"], 1, "Retained body")


def _assert_link_columns_and_privileges(connection: Connection) -> None:
    for table in TABLES:
        assert connection.execute(
            text(
                "SELECT is_nullable, column_default FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = :table AND column_name = 'links'"
            ),
            {"table": table},
        ).one() == ("NO", "'[]'::jsonb")
        assert (
            connection.scalar(
                text(
                    "SELECT 1 FROM pg_constraint WHERE conrelid = CAST(:table AS regclass) "
                    "AND conname = :name"
                ),
                {"table": f"public.{table}", "name": f"ck_{table}_links_array_limit"},
            )
            == 1
        )
        for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                    {"table": f"public.{table}", "action": action},
                )
                is True
            )
        for action in ("SELECT", "INSERT", "UPDATE"):
            assert (
                connection.scalar(
                    text(
                        "SELECT has_column_privilege('openslate_runtime', :table, 'links', :action)"
                    ),
                    {"table": f"public.{table}", "action": action},
                )
                is True
            )
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_inspector', :table, 'SELECT')"),
                {"table": f"public.{table}"},
            )
            is True
        )
        assert (
            connection.scalar(
                text(
                    "SELECT has_column_privilege('openslate_inspector', :table, 'links', 'SELECT')"
                ),
                {"table": f"public.{table}"},
            )
            is True
        )
        for action in ("INSERT", "UPDATE", "DELETE"):
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege('openslate_inspector', :table, :action)"),
                    {"table": f"public.{table}", "action": action},
                )
                is False
            )
        for action in ("INSERT", "UPDATE"):
            assert (
                connection.scalar(
                    text(
                        "SELECT has_column_privilege("
                        "'openslate_inspector', :table, 'links', :action)"
                    ),
                    {"table": f"public.{table}", "action": action},
                )
                is False
            )


def _exercise_runtime_dml(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.board_events "
                "(id, board_id, author_id, title, all_day, start_date, end_date, "
                "timezone_name, audience_kind, links) "
                "VALUES (:id, :board, :owner, 'Runtime Event', true, "
                "DATE '2026-09-24', DATE '2026-09-24', 'UTC', 'everyone', CAST(:links AS jsonb))"
            ),
            {"id": ids["new_event"], "board": ids["board"], "owner": ids["owner"], "links": LINK},
        )
        connection.execute(
            text(
                "INSERT INTO public.board_announcements "
                "(id, board_id, author_id, title, body, audience_kind, links) "
                "VALUES (:id, :board, :owner, 'Runtime Announcement', 'Body', "
                "'everyone', CAST(:links AS jsonb))"
            ),
            {
                "id": ids["new_announcement"],
                "board": ids["board"],
                "owner": ids["owner"],
                "links": LINK,
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.board_announcement_revisions "
                "(id, announcement_id, publication_number, publication_key, "
                "content_fingerprint, author_id, title, body, audience_kind, published_at, links) "
                "VALUES (:id, :announcement, 1, :key, :fingerprint, :owner, "
                "'Runtime Announcement', 'Body', 'everyone', now(), CAST(:links AS jsonb))"
            ),
            {
                "id": ids["new_revision"],
                "announcement": ids["new_announcement"],
                "key": uuid7(),
                "fingerprint": "b" * 64,
                "owner": ids["owner"],
                "links": LINK,
            },
        )
        for table, key in (
            ("board_events", "new_event"),
            ("board_announcements", "new_announcement"),
            ("board_announcement_revisions", "new_revision"),
        ):
            assert connection.scalar(
                text(f"SELECT links FROM public.{table} WHERE id = :id"),
                {"id": ids[key]},
            ) == [{"label": "Guide", "url": "https://example.test/guide"}]
        for table, key in (
            ("board_events", "new_event"),
            ("board_announcements", "new_announcement"),
        ):
            connection.execute(
                text(f"UPDATE public.{table} SET links = '[]'::jsonb WHERE id = :id"),
                {"id": ids[key]},
            )
        connection.execute(
            text("DELETE FROM public.board_announcement_revisions WHERE id = :id"),
            {"id": ids["new_revision"]},
        )
        connection.execute(
            text("DELETE FROM public.board_announcements WHERE id = :id"),
            {"id": ids["new_announcement"]},
        )
        connection.execute(
            text("DELETE FROM public.board_events WHERE id = :id"),
            {"id": ids["new_event"]},
        )
    with pytest.raises(DBAPIError, match="published announcement revisions are immutable"):
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.board_announcement_revisions "
                    "SET links = '[]'::jsonb WHERE id = :id"
                ),
                {"id": ids["revision"]},
            )


def _delete_source_rows(engine: Engine, ids: dict[str, UUID]) -> None:
    with engine.begin() as connection:
        for table, key in (
            ("board_announcement_revisions", "new_revision"),
            ("board_announcement_revisions", "revision"),
            ("board_announcements", "new_announcement"),
            ("board_announcements", "announcement"),
            ("board_events", "new_event"),
            ("board_events", "event"),
            ("boards", "board"),
            ("departments", "department"),
            ("users", "owner"),
        ):
            connection.execute(text(f"DELETE FROM public.{table} WHERE id = :id"), {"id": ids[key]})
