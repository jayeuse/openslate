"""External-link schema and privilege contracts on the fresh baseline."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import DBAPIError
from uuid6 import uuid7

from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from tests.conftest import create_member, create_organization

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")
LINK_TABLES = (
    "board_events",
    "board_posts",
    "board_post_revisions",
)


@pytest.mark.integration
def test_external_link_baseline_preserves_schema_and_application_role_boundaries(
    integration_owner_db,
    integration_db,
) -> None:
    # Historical upgrade/backfill/downgrade assertions are out of scope for a fresh baseline.
    connection = integration_owner_db.connection()
    for table in LINK_TABLES:
        assert connection.scalar(text("SELECT to_regclass(:table)"), {"table": f"public.{table}"})
    _assert_link_columns_and_privileges(connection)
    _assert_published_revision_links_are_immutable(integration_db)


def _assert_link_columns_and_privileges(connection: Connection) -> None:
    for table in LINK_TABLES:
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
        for action in TABLE_ACTIONS:
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
        for role in SUPABASE_DATABASE_ROLES:
            for action in TABLE_ACTIONS:
                assert (
                    connection.scalar(
                        text("SELECT has_table_privilege(:role, :table, :action)"),
                        {"role": role, "table": f"public.{table}", "action": action},
                    )
                    is False
                ), f"Supabase database role {role} must not access {table}"
            for action in ("SELECT", "INSERT", "UPDATE"):
                assert (
                    connection.scalar(
                        text("SELECT has_column_privilege(:role, :table, 'links', :action)"),
                        {"role": role, "table": f"public.{table}", "action": action},
                    )
                    is False
                ), f"Supabase database role {role} must not access {table}.links"


def _assert_published_revision_links_are_immutable(db) -> None:
    role = "member"
    assert role is not None
    user_id = uuid7()
    organization = create_organization(db)
    user, _membership = create_member(db, organization,
        id=user_id,
        email=f"link-baseline-{user_id.hex}@example.test",
        username=f"link_baseline_{user_id.hex[:12]}",
        status="active",
        role=role,
    )
    board = Board(org_id=organization.id, scope="project", name="Link baseline")
    db.add(board)
    db.flush()

    post = BoardPost(
        org_id=organization.id,
        board_id=board.id,
        author_id=user.id,
        title="Published notice",
        body="Immutable publication content",
        status="published",
        displayed_publication_number=1,
    )
    db.add(post)
    db.flush()
    revision = BoardPostRevision(
        org_id=organization.id,
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=user.id,
        title=post.title,
        body=post.body,
        links=[{"label": "Guide", "url": "https://example.test/guide"}],
        published_at=datetime.now(UTC),
    )
    db.add(revision)
    db.flush()

    with pytest.raises(DBAPIError, match="published post revisions are immutable"):
        with db.begin_nested():
            db.connection().execute(
                text(
                    "UPDATE public.board_post_revisions SET links = '[]'::jsonb "
                    "WHERE id = :id"
                ),
                {"id": revision.id},
            )
