"""Per-user announcement read and bookmark persistence contracts."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.access.users.models import User
from app.systems.boards.announcement_models import BoardAnnouncement
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.models import Board
from app.systems.manage.audit.models import AuditAction, AuditLog

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")


def test_announcement_personal_state_is_registered_with_private_unique_scope() -> None:
    table = Base.metadata.tables["board_announcement_personal_states"]
    assert table.c.user_id.nullable is False
    assert table.c.announcement_id.nullable is False
    assert table.c.read.nullable is False
    assert table.c.bookmarked.nullable is False
    assert "board_id" not in table.c


@pytest.mark.integration
def test_announcement_personal_flags_are_audited_and_database_scoped(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    role = "member"
    assert role is not None
    author_id, reader_id = uuid7(), uuid7()
    author = User(
        id=author_id,
        email=f"personal-author-{author_id.hex}@example.test",
        username=f"personal_author_{author_id.hex[:12]}",
        status="active",
        role=role,
    )
    reader = User(
        id=reader_id,
        email=f"personal-reader-{reader_id.hex}@example.test",
        username=f"personal_reader_{reader_id.hex[:12]}",
        status="active",
        role=role,
    )
    db.add_all([author, reader])
    db.flush()
    board = Board(owner_id=author.id, name="Announcement personal state")
    db.add(board)
    db.flush()
    announcement = BoardAnnouncement(
        board_id=board.id,
        author_id=author.id,
        title="Private notice",
        body="Private announcement content",
        audience_kind="everyone",
    )
    db.add(announcement)
    db.flush()

    state = BoardAnnouncementPersonalState(user_id=reader.id, announcement_id=announcement.id)
    db.add(state)
    db.flush()
    assert (state.read, state.bookmarked) == (False, False)
    created = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_announcement_personal_states",
            AuditLog.entity_id == state.id,
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert created is not None and created.after is not None
    assert created.after["read"] is False
    assert created.after["bookmarked"] is False

    state.read = True
    state.bookmarked = True
    db.flush()
    updated = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_announcement_personal_states",
            AuditLog.entity_id == state.id,
            AuditLog.action == AuditAction.UPDATE,
        )
    )
    assert updated is not None and updated.before is not None and updated.after is not None
    assert updated.before == {"read": False, "bookmarked": False}
    assert updated.after == {"read": True, "bookmarked": True}
    assert "Private notice" not in str((created.after, updated.before, updated.after))
    assert "Private announcement content" not in str((created.after, updated.before, updated.after))

    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                BoardAnnouncementPersonalState(user_id=reader.id, announcement_id=announcement.id)
            )
            db.flush()
    for statement, parameter in (
        ("DELETE FROM board_announcements WHERE id = :id", announcement.id),
        ("DELETE FROM users WHERE id = :id", reader.id),
        ("UPDATE board_announcement_personal_states SET read = NULL WHERE id = :id", state.id),
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.connection().execute(text(statement), {"id": parameter})


@pytest.mark.integration
def test_announcement_personal_baseline_keeps_private_unique_scope_and_role_boundaries(
    integration_owner_db,
) -> None:
    # The old additive migration transition is archived; the fresh baseline contains both tables.
    connection = integration_owner_db.connection()
    for table in ("board_announcements", "board_announcement_personal_states"):
        assert connection.scalar(text("SELECT to_regclass(:name)"), {"name": f"public.{table}"})
        _assert_runtime_crud_and_supabase_denial(connection, table)

    columns = {
        name: (nullable, default)
        for name, nullable, default in connection.execute(
            text(
                "SELECT column_name, is_nullable, column_default "
                "FROM information_schema.columns WHERE table_schema = 'public' "
                "AND table_name = 'board_announcement_personal_states'"
            )
        )
    }
    for name in ("user_id", "announcement_id", "read", "bookmarked"):
        assert columns[name][0] == "NO"
    assert columns["read"][1] == "false"
    assert columns["bookmarked"][1] == "false"
    assert "board_id" not in columns
    definitions = list(
        connection.scalars(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conrelid = 'public.board_announcement_personal_states'::regclass"
            )
        )
    )
    assert any("UNIQUE (user_id, announcement_id)" in item for item in definitions)
    assert any(
        "FOREIGN KEY (announcement_id)" in item and "ON DELETE RESTRICT" in item
        for item in definitions
    )
    assert any(
        "FOREIGN KEY (user_id)" in item and "ON DELETE RESTRICT" in item for item in definitions
    )
    assert any(
        "FOREIGN KEY (performed_by)" in item and "ON DELETE SET NULL" in item
        for item in definitions
    )
    assert connection.scalar(
        text("SELECT to_regclass(:name)"),
        {"name": "public.ix_board_announcement_personal_states_announcement_id"},
    )


def _assert_runtime_crud_and_supabase_denial(connection, table: str) -> None:
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
