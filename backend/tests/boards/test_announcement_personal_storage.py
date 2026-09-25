"""Per-user announcement read and bookmark persistence contracts."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.access.users.models import Role, User
from app.systems.boards.announcement_models import BoardAnnouncement
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.models import Board
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "fbef83381635"
TARGET_REVISION = "e53d62ab1617"
ACCESS_HEAD_REVISION = "2bf95b237416"


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
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    author_id, reader_id = uuid7(), uuid7()
    author = User(
        id=author_id,
        email=f"personal-author-{author_id.hex}@example.test",
        username=f"personal_author_{author_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    reader = User(
        id=reader_id,
        email=f"personal-reader-{reader_id.hex}@example.test",
        username=f"personal_reader_{reader_id.hex[:12]}",
        status="active",
        role_id=role.id,
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
def test_announcement_personal_migration_is_additive_and_preserves_role_privileges() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            before_tables = set(
                connection.scalars(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                )
            )
            assert "board_announcements" in before_tables
            assert "board_announcement_personal_states" not in before_tables
            original_privilege = connection.scalar(
                text(
                    "SELECT has_table_privilege('openslate_runtime', "
                    "'public.board_announcements', 'SELECT')"
                )
            )
            assert original_privilege is True

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            after_tables = set(
                connection.scalars(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
                )
            )
            assert after_tables == before_tables | {"board_announcement_personal_states"}
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            columns = {
                name: (nullable, default)
                for name, nullable, default in connection.execute(
                    text(
                        "SELECT column_name, is_nullable, column_default "
                        "FROM information_schema.columns "
                        "WHERE table_schema = 'public' "
                        "AND table_name = 'board_announcement_personal_states'"
                    )
                )
            }
            for name in ("user_id", "announcement_id", "read", "bookmarked"):
                assert columns[name][0] == "NO"
            assert columns["read"][1] == "false"
            assert columns["bookmarked"][1] == "false"
            assert "board_id" not in columns
            definitions = [
                definition
                for definition in connection.scalars(
                    text(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                        "WHERE conrelid = 'public.board_announcement_personal_states'::regclass"
                    )
                )
            ]
            assert any("UNIQUE (user_id, announcement_id)" in item for item in definitions)
            assert any(
                "FOREIGN KEY (announcement_id)" in item and "ON DELETE RESTRICT" in item
                for item in definitions
            )
            assert any(
                "FOREIGN KEY (user_id)" in item and "ON DELETE RESTRICT" in item
                for item in definitions
            )
            assert any(
                "FOREIGN KEY (performed_by)" in item and "ON DELETE SET NULL" in item
                for item in definitions
            )
            assert (
                connection.scalar(
                    text("SELECT to_regclass(:name)"),
                    {"name": "public.ix_board_announcement_personal_states_announcement_id"},
                )
                is not None
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT has_table_privilege('openslate_runtime', "
                        "'public.board_announcements', 'SELECT')"
                    )
                )
                is original_privilege
            )
            for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                assert (
                    connection.scalar(
                        text(
                            "SELECT has_table_privilege('openslate_runtime', "
                            "'public.board_announcement_personal_states', :action)"
                        ),
                        {"action": action},
                    )
                    is True
                )
            assert (
                connection.scalar(
                    text(
                        "SELECT has_table_privilege('openslate_inspector', "
                        "'public.board_announcement_personal_states', 'SELECT')"
                    )
                )
                is True
            )
            for action in ("INSERT", "UPDATE", "DELETE"):
                assert (
                    connection.scalar(
                        text(
                            "SELECT has_table_privilege('openslate_inspector', "
                            "'public.board_announcement_personal_states', :action)"
                        ),
                        {"action": action},
                    )
                    is False
                )
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            owner_engine.dispose()
