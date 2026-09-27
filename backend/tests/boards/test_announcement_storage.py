"""Attachment-free Board announcement persistence contracts."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError, IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.access.users.models import Role, User
from app.systems.boards.announcement_models import (
    BoardAnnouncement,
    BoardAnnouncementRevision,
    publication_content_fingerprint,
)
from app.systems.boards.models import Board
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")


def test_announcement_and_published_revision_tables_are_registered() -> None:
    assert "board_announcements" in Base.metadata.tables
    assert "board_announcement_revisions" in Base.metadata.tables


def test_publication_storage_declares_display_pointer_and_idempotency_fields() -> None:
    announcement = Base.metadata.tables["board_announcements"]
    revision = Base.metadata.tables["board_announcement_revisions"]
    assert announcement.c.displayed_publication_number.nullable is True
    assert revision.c.publication_key.nullable is False
    assert revision.c.content_fingerprint.nullable is False


def test_publication_fingerprint_is_canonical_and_changes_with_content() -> None:
    author_id = uuid7()
    content = {
        "author_id": author_id,
        "title": "Private announcement",
        "body": "Confidential body",
        "audience_kind": "everyone",
    }
    first = publication_content_fingerprint(**content)
    reversed_content = dict(reversed(list(content.items())))
    assert publication_content_fingerprint(**reversed_content) == first
    assert publication_content_fingerprint(**(content | {"body": "Revised body"})) != first
    assert len(first) == 64
    assert "Confidential" not in first


@pytest.mark.integration
def test_published_snapshot_remains_private_and_immutable_during_scheduled_replacement(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    author_id, reader_id = uuid7(), uuid7()
    author = User(
        id=author_id,
        email=f"announcement-author-{author_id.hex}@example.test",
        username=f"announcement_author_{author_id.hex[:10]}",
        status="active",
        role_id=role.id,
    )
    reader = User(
        id=reader_id,
        email=f"announcement-reader-{reader_id.hex}@example.test",
        username=f"announcement_reader_{reader_id.hex[:10]}",
        status="active",
        role_id=role.id,
    )
    department = Department(department_name=f"Announcement department {uuid7().hex}")
    db.add_all([author, reader, department])
    db.flush()
    board = Board(owner_id=author.id, name="Announcements")
    db.add(board)
    db.flush()
    now = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)
    announcement = BoardAnnouncement(
        board_id=board.id,
        author_id=author.id,
        title="First published title",
        body="First private body",
        status="published",
        publish_at=now,
        audience_kind="user",
        audience_user_id=reader.id,
        displayed_publication_number=1,
    )
    db.add(announcement)
    db.flush()
    published = BoardAnnouncementRevision(
        announcement_id=announcement.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint=publication_content_fingerprint(
            author_id=author.id,
            title=announcement.title,
            body=announcement.body,
            audience_kind="user",
            audience_user_id=reader.id,
            expires_at=now + timedelta(days=2),
        ),
        author_id=author.id,
        title=announcement.title,
        body=announcement.body,
        audience_kind="user",
        audience_user_id=reader.id,
        published_at=now,
        expires_at=now + timedelta(days=2),
    )
    db.add(published)
    db.flush()

    announcement.title = "Next scheduled title"
    announcement.body = "Next restricted body"
    announcement.status = "scheduled"
    announcement.publish_at = now + timedelta(days=1)
    announcement.audience_kind = "department"
    announcement.audience_user_id = None
    announcement.audience_department_id = department.id
    announcement.revision += 1
    db.flush()

    stored = db.scalar(
        select(BoardAnnouncementRevision).where(
            BoardAnnouncementRevision.announcement_id == announcement.id
        )
    )
    assert stored is published
    assert (stored.title, stored.body, stored.audience_kind, stored.audience_user_id) == (
        "First published title",
        "First private body",
        "user",
        reader.id,
    )
    assert announcement.audience_kind == "department"
    assert announcement.displayed_publication_number == 1
    updated = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_announcements",
            AuditLog.entity_id == announcement.id,
            AuditLog.action == AuditAction.UPDATE,
        )
    )
    assert updated is not None
    assert updated.before is not None and updated.after is not None
    for content_field in ("title", "body"):
        assert updated.before[content_field] == "[REDACTED]"
        assert updated.after[content_field] == "[REDACTED]"
    for entity_type, entity_id in (
        ("board_announcements", announcement.id),
        ("board_announcement_revisions", published.id),
    ):
        created = db.scalar(
            select(AuditLog).where(
                AuditLog.entity_type == entity_type,
                AuditLog.entity_id == entity_id,
                AuditLog.action == AuditAction.CREATE,
            )
        )
        assert created is not None and created.after is not None
        assert created.after["title"] == "[REDACTED]"
        assert created.after["body"] == "[REDACTED]"
        if entity_type == "board_announcement_revisions":
            assert created.after["content_fingerprint"] == "[REDACTED]"

    with pytest.raises(DBAPIError):
        with db.begin_nested():
            db.connection().execute(
                text("UPDATE board_announcement_revisions SET title = :title WHERE id = :id"),
                {"title": "Overwritten history", "id": published.id},
            )
    assert db.get(BoardAnnouncementRevision, published.id).title == "First published title"

    announcement.status = "archived"
    db.flush()
    assert db.get(BoardAnnouncementRevision, published.id) is published
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.delete(announcement)
            db.flush()
    db.delete(published)
    db.flush()
    db.delete(announcement)
    db.flush()
    assert db.get(BoardAnnouncementRevision, published.id) is None


@pytest.mark.integration
def test_announcement_constraints_reject_invalid_audience_timing_and_duplicate_publication(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    author_id = uuid7()
    author = User(
        id=author_id,
        email=f"announcement-constraints-{author_id.hex}@example.test",
        username=f"announcement_constraints_{author_id.hex[:8]}",
        status="active",
        role_id=role.id,
    )
    db.add(author)
    db.flush()
    board = Board(owner_id=author.id, name="Constraint board")
    db.add(board)
    db.flush()
    now = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)
    base = {
        "board_id": board.id,
        "author_id": author.id,
        "title": "Notice",
        "body": "Details",
        "audience_kind": "everyone",
    }
    for override in (
        {"status": "scheduled"},
        {"status": "unknown"},
        {"publish_at": now, "expires_at": now},
        {"audience_kind": "user"},
        {"audience_role_id": role.id},
        {"title": "  "},
        {"body": "  "},
        {"body": "x" * 2001},
        {"revision": 0},
        {"displayed_publication_number": 0},
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(BoardAnnouncement(**(base | override)))
                db.flush()

    announcement = BoardAnnouncement(**base)
    db.add(announcement)
    db.flush()
    published = BoardAnnouncementRevision(
        announcement_id=announcement.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint=publication_content_fingerprint(
            author_id=author.id,
            title="Notice",
            body="Details",
            audience_kind="everyone",
        ),
        author_id=author.id,
        title="Notice",
        body="Details",
        audience_kind="everyone",
        published_at=now,
    )
    db.add(published)
    db.flush()
    revision_base = {
        "announcement_id": announcement.id,
        "publication_number": 2,
        "publication_key": uuid7(),
        "content_fingerprint": publication_content_fingerprint(
            author_id=author.id,
            title="Notice",
            body="Details",
            audience_kind="everyone",
        ),
        "author_id": author.id,
        "title": "Notice",
        "body": "Details",
        "audience_kind": "everyone",
        "published_at": now,
    }
    for override in (
        {"publication_number": 1},
        {"publication_key": published.publication_key, "body": "Different details"},
        {"publication_number": 0},
        {"content_fingerprint": "not-a-sha256"},
        {"audience_kind": "department"},
        {"expires_at": now},
        {"body": "x" * 2001},
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(BoardAnnouncementRevision(**(revision_base | override)))
                db.flush()


@pytest.mark.integration
def test_announcement_baseline_has_restrictive_schema_and_supabase_role_boundaries(
    integration_owner_db,
) -> None:
    connection = integration_owner_db.connection()
    assert connection.scalar(text("SELECT to_regclass('public.board_announcements')")) is not None
    assert (
        connection.scalar(text("SELECT to_regclass('public.board_announcement_revisions')"))
        is not None
    )
    _assert_announcement_schema_and_privileges(connection)


def _assert_announcement_schema_and_privileges(connection: Connection) -> None:
    indexes = {
        "board_announcements": {
            "ix_board_announcements_board_id",
            "ix_board_announcements_author_id",
            "ix_board_announcements_audience_role_id",
            "ix_board_announcements_audience_user_id",
            "ix_board_announcements_audience_department_id",
        },
        "board_announcement_revisions": {
            "uq_board_announcement_revisions_publication",
            "uq_board_announcement_revisions_publication_key",
            "ix_board_announcement_revisions_author_id",
            "ix_board_announcement_revisions_audience_role_id",
            "ix_board_announcement_revisions_audience_user_id",
            "ix_board_announcement_revisions_audience_department_id",
        },
    }
    for table in indexes:
        constraints = {
            row.conname: (row.contype, row.confdeltype)
            for row in connection.execute(
                text(
                    "SELECT conname, contype, confdeltype FROM pg_constraint "
                    "WHERE conrelid = CAST(:table AS regclass)"
                ),
                {"table": f"public.{table}"},
            )
        }
        for name in ("audience", "body_nonempty", "body_length", "title_nonempty"):
            assert constraints[f"ck_{table}_{name}"][0] == "c"
        assert constraints[f"fk_{table}_author_id_users"] == ("f", "r")
        assert [
            value
            for name, value in constraints.items()
            if name.startswith(f"fk_{table}_audience_department_id_")
        ] == [("f", "r")]
        if table == "board_announcements":
            assert constraints["ck_board_announcements_displayed_publication_positive"][0] == "c"
        else:
            assert constraints["ck_board_announcement_revisions_fingerprint_hex"][0] == "c"
            assert constraints["uq_board_announcement_revisions_publication"][0] == "u"
            assert constraints["uq_board_announcement_revisions_publication_key"][0] == "u"
        actual_indexes = set(
            connection.scalars(
                text(
                    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
                    "AND tablename = :table"
                ),
                {"table": table},
            )
        )
        assert indexes[table] <= actual_indexes
        for action in TABLE_ACTIONS:
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                    {"table": f"public.{table}", "action": action},
                )
                is True
            )
        for role in SUPABASE_DATABASE_ROLES:
            for action in TABLE_ACTIONS:
                assert (
                    connection.scalar(
                        text("SELECT has_table_privilege(:role, :table, :action)"),
                        {"role": role, "table": f"public.{table}", "action": action},
                    )
                    is False
                ), f"Supabase database role {role} must not access {table}"
    trigger = connection.scalar(
        text(
            "SELECT count(*) FROM pg_trigger WHERE tgrelid = "
            "'public.board_announcement_revisions'::regclass "
            "AND tgname = 'trg_board_announcement_revisions_immutable' AND NOT tgisinternal"
        )
    )
    assert trigger == 1


@pytest.mark.integration
def test_publication_baseline_keeps_current_pointer_and_snapshot_constraints(
    integration_owner_db,
) -> None:
    # Legacy UUID5/key/fingerprint backfill is archived with the old migration chain. Fresh
    # installs use the active baseline, so assert its resulting snapshot invariants instead.
    connection = integration_owner_db.connection()
    columns = {
        (row.table_name, row.column_name): (row.is_nullable, row.data_type)
        for row in connection.execute(
            text(
                "SELECT table_name, column_name, is_nullable, data_type "
                "FROM information_schema.columns WHERE table_schema = 'public' "
                "AND table_name IN ('board_announcements', 'board_announcement_revisions')"
            )
        )
    }
    assert columns[("board_announcements", "displayed_publication_number")] == (
        "YES",
        "integer",
    )
    assert columns[("board_announcement_revisions", "publication_key")][0] == "NO"
    assert columns[("board_announcement_revisions", "content_fingerprint")][0] == "NO"
    constraints = set(
        connection.scalars(
            text(
                "SELECT conname FROM pg_constraint WHERE conrelid IN "
                "('public.board_announcements'::regclass, "
                "'public.board_announcement_revisions'::regclass)"
            )
        )
    )
    assert {
        "ck_board_announcements_displayed_publication_positive",
        "ck_board_announcement_revisions_fingerprint_hex",
        "uq_board_announcement_revisions_publication",
        "uq_board_announcement_revisions_publication_key",
    } <= constraints
