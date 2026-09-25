"""Board event-series storage contracts."""

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.access.users.models import Role, User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "33f6b3cea25b"
TARGET_REVISION = "18958e485e0c"
ACCESS_HEAD_REVISION = "2bf95b237416"


def test_board_event_series_is_registered_for_migrations() -> None:
    assert "board_events" in Base.metadata.tables


@pytest.mark.integration
def test_event_series_enforces_temporal_audience_and_recurrence_modes(integration_owner_db) -> None:
    db = integration_owner_db
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    owner_id, author_id = uuid7(), uuid7()
    owner = User(
        id=owner_id,
        email=f"event-owner-{owner_id.hex}@example.test",
        username=f"event_owner_{owner_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    author = User(
        id=author_id,
        email=f"event-author-{author_id.hex}@example.test",
        username=f"event_author_{author_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    department = Department(department_name=f"Event department {uuid7().hex}")
    db.add_all([owner, author, department])
    db.flush()
    board = Board(owner_id=owner.id, department_id=department.id, name="Events")
    db.add(board)
    db.flush()

    all_day = BoardEvent(
        board_id=board.id,
        author_id=author.id,
        title="Private operations day",
        details="Restricted details",
        location="Restricted room",
        all_day=True,
        start_date=date(2026, 1, 31),
        end_date=date(2026, 1, 31),
        timezone_name="Asia/Manila",
        recurrence="monthly",
        repeat_until=date(2026, 4, 30),
        audience_kind="department",
        audience_department_id=department.id,
    )
    timed_start = datetime(2026, 9, 14, 1, 0, tzinfo=UTC)
    timed = BoardEvent(
        board_id=board.id,
        author_id=author.id,
        title="Team call",
        all_day=False,
        start_at=timed_start,
        end_at=timed_start + timedelta(hours=1),
        timezone_name="Asia/Manila",
        audience_kind="author",
    )
    db.add_all([all_day, timed])
    db.flush()
    assert timed.start_at == timed_start
    assert timed.recurrence == "none"
    assert timed.archived is False
    assert timed.revision == 1

    created = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_events",
            AuditLog.entity_id == all_day.id,
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert created is not None and created.after is not None
    for private_field in ("title", "details", "location"):
        assert created.after[private_field] == "[REDACTED]"

    base = {
        "board_id": board.id,
        "author_id": author.id,
        "title": "Invalid event",
        "all_day": True,
        "start_date": date(2026, 9, 14),
        "end_date": date(2026, 9, 14),
        "timezone_name": "Asia/Manila",
        "audience_kind": "everyone",
    }
    invalid_overrides = (
        {"end_date": date(2026, 9, 13)},
        {"start_at": timed_start},
        {"recurrence": "daily"},
        {"recurrence": "weekly", "repeat_until": date(2026, 9, 13)},
        {"recurrence": "yearly", "repeat_until": date(2027, 9, 14)},
        {"audience_kind": "role"},
        {"audience_role_id": role.id},
        {"audience_kind": "department", "audience_department_id": uuid7()},
        {"timezone_name": "   "},
        {"title": "   "},
        {"details": "x" * 4001},
        {"revision": 0},
    )
    for override in invalid_overrides:
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(BoardEvent(**(base | override)))
                db.flush()

    for audience_kind, reference in (
        ("everyone", {}),
        ("author", {}),
        ("role", {"audience_role_id": role.id}),
        ("user", {"audience_user_id": owner.id}),
    ):
        db.add(BoardEvent(**(base | {"audience_kind": audience_kind} | reference)))
    db.flush()

    board.status = "archived"
    all_day.archived = True
    all_day.is_deleted = True
    db.flush()
    assert db.get(BoardEvent, all_day.id) is all_day
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.delete(board)
            db.flush()
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.delete(author)
            db.flush()


@pytest.mark.integration
def test_event_migration_preserves_personal_head_and_least_privilege_roles() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.board_events')")) is None
            assert connection.scalar(text("SELECT to_regclass('public.board_homes')")) is not None
        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            _assert_event_schema_and_privileges(connection)
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            owner_engine.dispose()


def _assert_event_schema_and_privileges(connection: Connection) -> None:
    constraints = {
        row.conname: (row.contype, row.confdeltype)
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = 'public.board_events'::regclass"
            )
        )
    }
    for suffix in (
        "author_id_users",
        "board_id_boards",
        "audience_role_id_roles",
        "audience_user_id_users",
        "audience_department_id_departments",
    ):
        assert constraints[f"fk_board_events_{suffix}"] == ("f", "r")
    assert constraints["fk_board_events_performed_by_users"] == ("f", "n")
    for name in (
        "audience",
        "temporal_mode",
        "recurrence",
        "all_day_repeat_until",
    ):
        assert constraints[f"ck_board_events_{name}"][0] == "c"
    columns = dict(
        connection.execute(
            text(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'board_events'"
            )
        ).all()
    )
    assert columns["start_date"] == columns["end_date"] == "date"
    assert columns["repeat_until"] == "date"
    assert columns["start_at"] == columns["end_at"] == "timestamp with time zone"
    for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                {"table": "public.board_events", "action": action},
            )
            is True
        )
    assert (
        connection.scalar(
            text(
                "SELECT has_table_privilege('openslate_inspector', 'public.board_events', 'SELECT')"
            )
        )
        is True
    )
    for action in ("INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_inspector', :table, :action)"),
                {"table": "public.board_events", "action": action},
            )
            is False
        )
