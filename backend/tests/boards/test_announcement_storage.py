"""Attachment-free Board announcement persistence contracts."""

from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, uuid5

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
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "d3c2ce550d4a"
TARGET_REVISION = "2398f489358b"
PUBLICATION_REVISION = "e84debb45901"


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
def test_announcement_migration_adds_restrictive_schema_and_least_privilege_roles() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT to_regclass('public.board_announcements')")) is None
            )
            assert connection.scalar(text("SELECT to_regclass('public.reports')")) is not None
        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
                TARGET_REVISION
            )
            _assert_announcement_schema_and_privileges(connection)
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            owner_engine.dispose()


def _assert_announcement_schema_and_privileges(connection: Connection) -> None:
    for table in ("board_announcements", "board_announcement_revisions"):
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
        for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
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
                text("SELECT has_table_privilege('openslate_inspector', :table, 'UPDATE')"),
                {"table": f"public.{table}"},
            )
            is False
        )
    trigger = connection.scalar(
        text(
            "SELECT count(*) FROM pg_trigger WHERE tgrelid = "
            "'public.board_announcement_revisions'::regclass "
            "AND tgname = 'trg_board_announcement_revisions_immutable' AND NOT tgisinternal"
        )
    )
    assert trigger == 1


@pytest.mark.integration
def test_publication_migration_backfills_legacy_revision_and_display_pointer() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    author_id, board_id, announcement_id, revision_id = (uuid7() for _ in range(4))
    published_at = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)
    try:
        run_alembic(environment, "downgrade", TARGET_REVISION)
        with owner_engine.begin() as connection:
            role_id = connection.scalar(text("SELECT id FROM roles WHERE role = 'member'"))
            assert role_id is not None
            connection.execute(
                text(
                    "INSERT INTO users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": author_id,
                    "email": f"legacy-announcement-{author_id.hex}@example.test",
                    "username": f"legacy_announcement_{author_id.hex[:10]}",
                    "role_id": role_id,
                },
            )
            connection.execute(
                text("INSERT INTO boards (id, owner_id, name) VALUES (:id, :owner_id, :name)"),
                {"id": board_id, "owner_id": author_id, "name": "Legacy publication"},
            )
            connection.execute(
                text(
                    "INSERT INTO board_announcements "
                    "(id, board_id, author_id, title, body, status, publish_at, audience_kind) "
                    "VALUES (:id, :board_id, :author_id, :title, :body, 'scheduled', "
                    ":publish_at, 'everyone')"
                ),
                {
                    "id": announcement_id,
                    "board_id": board_id,
                    "author_id": author_id,
                    "title": "Replacement draft",
                    "body": "Replacement body",
                    "publish_at": published_at + timedelta(days=1),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO board_announcement_revisions "
                    "(id, announcement_id, publication_number, author_id, title, body, "
                    "audience_kind, published_at) "
                    "VALUES (:id, :announcement_id, 1, :author_id, :title, :body, "
                    "'everyone', :published_at)"
                ),
                {
                    "id": revision_id,
                    "announcement_id": announcement_id,
                    "author_id": author_id,
                    "title": "Visible original",
                    "body": "Original private body",
                    "published_at": published_at,
                },
            )
        run_alembic(environment, "upgrade", PUBLICATION_REVISION)
        with owner_engine.connect() as connection:
            pointer = connection.scalar(
                text(
                    "SELECT displayed_publication_number FROM board_announcements "
                    "WHERE id = :id"
                ),
                {"id": announcement_id},
            )
            key, fingerprint = connection.execute(
                text(
                    "SELECT publication_key, content_fingerprint "
                    "FROM board_announcement_revisions WHERE id = :id"
                ),
                {"id": revision_id},
            ).one()
            assert pointer == 1
            assert key == uuid5(NAMESPACE_URL, f"openslate:announcement:{revision_id}")
            assert fingerprint == publication_content_fingerprint(
                author_id=author_id,
                title="Visible original",
                body="Original private body",
                audience_kind="everyone",
            )
            constraints = {
                row.conname
                for row in connection.execute(
                    text(
                        "SELECT conname FROM pg_constraint WHERE conrelid IN "
                        "('board_announcements'::regclass, "
                        "'board_announcement_revisions'::regclass)"
                    )
                )
            }
            assert {
                "ck_board_announcements_displayed_publication_positive",
                "ck_board_announcement_revisions_fingerprint_hex",
                "uq_board_announcement_revisions_publication_key",
            } <= constraints
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
            with owner_engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM board_announcement_revisions WHERE id = :id"),
                    {"id": revision_id},
                )
                connection.execute(
                    text("DELETE FROM board_announcements WHERE id = :id"),
                    {"id": announcement_id},
                )
                connection.execute(text("DELETE FROM boards WHERE id = :id"), {"id": board_id})
                connection.execute(text("DELETE FROM users WHERE id = :id"), {"id": author_id})
        finally:
            owner_engine.dispose()
