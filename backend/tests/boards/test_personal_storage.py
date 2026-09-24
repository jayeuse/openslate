"""Board personal-state storage contracts."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.access.users.models import Role, User
from app.systems.boards.models import Board
from app.systems.boards.personal_models import BoardFavorite, BoardHome
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "1d9ef36b7646"
TARGET_REVISION = "33f6b3cea25b"
ACCESS_HEAD_REVISION = "2bf95b237416"


def test_board_personal_tables_are_registered_for_migrations() -> None:
    assert "board_favorites" in Base.metadata.tables
    assert "board_homes" in Base.metadata.tables


@pytest.mark.integration
def test_personal_rows_enforce_unique_scope_restrict_deletion_and_survive_archive(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    owner_id, viewer_id = uuid7(), uuid7()
    owner = User(
        id=owner_id,
        email=f"personal-owner-{owner_id.hex}@example.test",
        username=f"personal_owner_{owner_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    viewer = User(
        id=viewer_id,
        email=f"personal-viewer-{viewer_id.hex}@example.test",
        username=f"personal_viewer_{viewer_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    db.add_all([owner, viewer])
    db.flush()
    board = Board(owner_id=owner.id, name="Personal state")
    other_board = Board(owner_id=owner.id, name="Another board")
    db.add_all([board, other_board])
    db.flush()

    favorite = BoardFavorite(user_id=viewer.id, board_id=board.id)
    home = BoardHome(user_id=viewer.id, board_id=board.id)
    db.add_all([favorite, home, BoardFavorite(user_id=owner.id, board_id=board.id)])
    db.flush()
    assert (
        db.scalar(
            select(AuditLog).where(
                AuditLog.entity_type == "board_favorites",
                AuditLog.entity_id == favorite.id,
                AuditLog.action == AuditAction.CREATE,
            )
        )
        is not None
    )
    assert (
        db.scalar(
            select(AuditLog).where(
                AuditLog.entity_type == "board_homes",
                AuditLog.entity_id == home.id,
                AuditLog.action == AuditAction.CREATE,
            )
        )
        is not None
    )

    for duplicate in (
        BoardFavorite(user_id=viewer.id, board_id=board.id),
        BoardHome(user_id=viewer.id, board_id=other_board.id),
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(duplicate)
                db.flush()

    board.status = "archived"
    db.flush()
    assert db.get(BoardFavorite, favorite.id) is favorite
    assert db.get(BoardHome, home.id) is home
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.delete(board)
            db.flush()
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.delete(viewer)
            db.flush()


@pytest.mark.integration
def test_personal_migration_keeps_source_schema_and_least_privilege_roles() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.board_favorites')")) is None
            assert connection.scalar(text("SELECT to_regclass('public.board_homes')")) is None
            assert (
                connection.scalar(text("SELECT to_regclass('public.board_templates')")) is not None
            )
        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            for table in ("board_favorites", "board_homes"):
                _assert_personal_schema_and_privileges(connection, table)
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            owner_engine.dispose()


def _assert_personal_schema_and_privileges(connection: Connection, table: str) -> None:
    constraints = {
        row.conname: (row.contype, row.confdeltype)
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = to_regclass(:table)"
            ),
            {"table": f"public.{table}"},
        )
    }
    assert constraints[f"fk_{table}_board_id_boards"] == ("f", "r")
    assert constraints[f"fk_{table}_user_id_users"] == ("f", "r")
    assert constraints[f"fk_{table}_performed_by_users"] == ("f", "n")
    unique_name = (
        "uq_board_favorites_user_board" if table == "board_favorites" else "uq_board_homes_user_id"
    )
    assert constraints[unique_name][0] == "u"
    assert (
        connection.scalar(
            text("SELECT to_regclass(:index)"), {"index": f"public.ix_{table}_board_id"}
        )
        is not None
    )
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
    for action in ("INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_inspector', :table, :action)"),
                {"table": f"public.{table}", "action": action},
            )
            is False
        )
