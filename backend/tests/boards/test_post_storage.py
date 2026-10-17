"""Attachment-free Board post persistence contracts."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError, IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.boards.models import Board
from app.systems.boards.post_models import (
    BoardPost,
    BoardPostRevision,
    publication_content_fingerprint,
)
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.conftest import create_member
from tests.rbac.support import organization

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")


def test_post_and_published_revision_tables_are_registered() -> None:
    assert "board_posts" in Base.metadata.tables
    assert "board_post_revisions" in Base.metadata.tables


def test_publication_storage_declares_display_pointer_and_idempotency_fields() -> None:
    post = Base.metadata.tables["board_posts"]
    revision = Base.metadata.tables["board_post_revisions"]
    assert post.c.displayed_publication_number.nullable is True
    assert revision.c.publication_key.nullable is False
    assert revision.c.content_fingerprint.nullable is False


def test_publication_fingerprint_is_canonical_and_changes_with_content() -> None:
    author_id = uuid7()
    content = {
        "author_id": author_id,
        "title": "Private post",
        "body": "Confidential body",
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
    role = "member"
    assert role is not None
    author_id, reader_id = uuid7(), uuid7()
    author, _author_membership = create_member(db, organization(db),
        id=author_id,
        email=f"post-author-{author_id.hex}@example.test",
        username=f"post_author_{author_id.hex[:10]}",
        status="active",
        role=role,
    )
    reader, _reader_membership = create_member(db, organization(db),
        id=reader_id,
        email=f"post-reader-{reader_id.hex}@example.test",
        username=f"post_reader_{reader_id.hex[:10]}",
        status="active",
        role=role,
    )
    db.add_all([author, reader])
    db.flush()
    board = Board(org_id=organization(db).id, scope="project", name="Posts")
    db.add(board)
    db.flush()
    now = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)
    post = BoardPost(
        org_id=board.org_id,
        board_id=board.id,
        author_id=author.id,
        title="First published title",
        body="First private body",
        status="published",
        publish_at=now,
        displayed_publication_number=1,
    )
    db.add(post)
    db.flush()
    published = BoardPostRevision(
        org_id=post.org_id,
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint=publication_content_fingerprint(
            author_id=author.id,
            title=post.title,
            body=post.body,
            expires_at=now + timedelta(days=2),
        ),
        author_id=author.id,
        title=post.title,
        body=post.body,
        published_at=now,
        expires_at=now + timedelta(days=2),
    )
    db.add(published)
    db.flush()

    post.title = "Next scheduled title"
    post.body = "Next restricted body"
    post.status = "scheduled"
    post.publish_at = now + timedelta(days=1)
    post.revision += 1
    db.flush()

    stored = db.scalar(
        select(BoardPostRevision).where(
            BoardPostRevision.post_id == post.id
        )
    )
    assert stored is published
    assert (stored.title, stored.body) == ("First published title", "First private body")
    assert post.displayed_publication_number == 1
    updated = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_posts",
            AuditLog.entity_id == post.id,
            AuditLog.action == AuditAction.UPDATE,
        )
    )
    assert updated is not None
    assert updated.before is not None and updated.after is not None
    for content_field in ("title", "body"):
        assert updated.before[content_field] == "[REDACTED]"
        assert updated.after[content_field] == "[REDACTED]"
    for entity_type, entity_id in (
        ("board_posts", post.id),
        ("board_post_revisions", published.id),
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
        if entity_type == "board_post_revisions":
            assert created.after["content_fingerprint"] == "[REDACTED]"

    with pytest.raises(DBAPIError):
        with db.begin_nested():
            db.connection().execute(
                text("UPDATE board_post_revisions SET title = :title WHERE id = :id"),
                {"title": "Overwritten history", "id": published.id},
            )
    assert db.get(BoardPostRevision, published.id).title == "First published title"

    post.status = "archived"
    db.flush()
    assert db.get(BoardPostRevision, published.id) is published
    savepoint = db.begin_nested()
    db.delete(post)
    with pytest.raises(IntegrityError):
        db.flush()
    savepoint.rollback()
    db.delete(published)
    db.flush()
    db.delete(post)
    db.flush()
    assert db.get(BoardPostRevision, published.id) is None


@pytest.mark.integration
def test_post_constraints_reject_invalid_timing_and_duplicate_publication(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    role = "member"
    assert role is not None
    author_id = uuid7()
    author, _membership = create_member(db, organization(db),
        id=author_id,
        email=f"post-constraints-{author_id.hex}@example.test",
        username=f"post_constraints_{author_id.hex[:8]}",
        status="active",
        role=role,
    )
    db.add(author)
    db.flush()
    board = Board(org_id=organization(db).id, scope="project", name="Constraint board")
    db.add(board)
    db.flush()
    now = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)
    base = {
        "org_id": board.org_id,
        "board_id": board.id,
        "author_id": author.id,
        "title": "Notice",
        "body": "Details",
    }
    for override in (
        {"status": "scheduled"},
        {"status": "unknown"},
        {"publish_at": now, "expires_at": now},
        {"title": "  "},
        {"body": "  "},
        {"body": "x" * 2001},
        {"revision": 0},
        {"displayed_publication_number": 0},
    ):
        savepoint = db.begin_nested()
        db.add(BoardPost(**(base | override)))
        with pytest.raises(IntegrityError):
            db.flush()
        savepoint.rollback()

    post = BoardPost(**base)
    db.add(post)
    db.flush()
    published = BoardPostRevision(
        org_id=post.org_id,
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint=publication_content_fingerprint(
            author_id=author.id,
            title="Notice",
            body="Details",
        ),
        author_id=author.id,
        title="Notice",
        body="Details",
        published_at=now,
    )
    db.add(published)
    db.flush()
    revision_base = {
        "org_id": post.org_id,
        "post_id": post.id,
        "publication_number": 2,
        "publication_key": uuid7(),
        "content_fingerprint": publication_content_fingerprint(
            author_id=author.id,
            title="Notice",
            body="Details",
        ),
        "author_id": author.id,
        "title": "Notice",
        "body": "Details",
        "published_at": now,
    }
    for override in (
        {"publication_number": 1},
        {"publication_key": published.publication_key, "body": "Different details"},
        {"publication_number": 0},
        {"content_fingerprint": "not-a-sha256"},
        {"expires_at": now},
        {"body": "x" * 2001},
    ):
        savepoint = db.begin_nested()
        db.add(BoardPostRevision(**(revision_base | override)))
        with pytest.raises(IntegrityError):
            db.flush()
        savepoint.rollback()


@pytest.mark.integration
def test_post_baseline_has_restrictive_schema_and_supabase_role_boundaries(
    integration_owner_db,
) -> None:
    connection = integration_owner_db.connection()
    assert connection.scalar(text("SELECT to_regclass('public.board_posts')")) is not None
    assert (
        connection.scalar(text("SELECT to_regclass('public.board_post_revisions')"))
        is not None
    )
    _assert_post_schema_and_privileges(connection)


def _assert_post_schema_and_privileges(connection: Connection) -> None:
    indexes = {
        "board_posts": {
            "ix_board_posts_board_id",
            "ix_board_posts_author_id",
        },
        "board_post_revisions": {
            "uq_board_post_revisions_publication",
            "uq_board_post_revisions_publication_key",
            "ix_board_post_revisions_author_id",
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
        for name in ("body_nonempty", "body_length", "title_nonempty"):
            assert constraints[f"ck_{table}_{name}"][0] == "c"
        assert constraints[f"fk_{table}_author_id_users"] == ("f", "r")
        assert not any("audience" in name for name in constraints)
        if table == "board_posts":
            assert constraints["ck_board_posts_displayed_publication_positive"][0] == "c"
        else:
            assert constraints["ck_board_post_revisions_fingerprint_hex"][0] == "c"
            assert constraints["uq_board_post_revisions_publication"][0] == "u"
            assert constraints["uq_board_post_revisions_publication_key"][0] == "u"
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
            "'public.board_post_revisions'::regclass "
            "AND tgname = 'trg_board_post_revisions_immutable' AND NOT tgisinternal"
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
                "AND table_name IN ('board_posts', 'board_post_revisions')"
            )
        )
    }
    assert columns[("board_posts", "displayed_publication_number")] == (
        "YES",
        "integer",
    )
    assert columns[("board_post_revisions", "publication_key")][0] == "NO"
    assert columns[("board_post_revisions", "content_fingerprint")][0] == "NO"
    constraints = set(
        connection.scalars(
            text(
                "SELECT conname FROM pg_constraint WHERE conrelid IN "
                "('public.board_posts'::regclass, "
                "'public.board_post_revisions'::regclass)"
            )
        )
    )
    assert {
        "ck_board_posts_displayed_publication_positive",
        "ck_board_post_revisions_fingerprint_hex",
        "uq_board_post_revisions_publication",
        "uq_board_post_revisions_publication_key",
    } <= constraints
