"""Board event-series storage contracts."""

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.core.database import Base, model_registry  # noqa: F401
from app.systems.access.users.models import User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")


def test_board_event_series_is_registered_for_migrations() -> None:
    assert "board_events" in Base.metadata.tables


@pytest.mark.integration
def test_event_series_enforces_temporal_and_recurrence_modes(integration_owner_db) -> None:
    db = integration_owner_db
    role = "member"
    assert role is not None
    owner_id, author_id = uuid7(), uuid7()
    owner = User(
        id=owner_id,
        email=f"event-owner-{owner_id.hex}@example.test",
        username=f"event_owner_{owner_id.hex[:12]}",
        status="active",
        role=role,
    )
    author = User(
        id=author_id,
        email=f"event-author-{author_id.hex}@example.test",
        username=f"event_author_{author_id.hex[:12]}",
        status="active",
        role=role,
    )
    department = Department(department_name=f"Event department {uuid7().hex}")
    db.add_all([owner, author, department])
    db.flush()
    board = Board(scope="department", department_id=department.id, name="Events")
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
    }
    invalid_overrides = (
        {"end_date": date(2026, 9, 13)},
        {"start_at": timed_start},
        {"recurrence": "daily"},
        {"recurrence": "weekly", "repeat_until": date(2026, 9, 13)},
        {"recurrence": "yearly", "repeat_until": date(2027, 9, 14)},
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

    db.add(BoardEvent(**base))
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
def test_event_baseline_preserves_temporal_schema_and_supabase_role_boundaries(
    integration_owner_db,
) -> None:
    # The old source-head upgrade is archived; verify the event series in the fresh baseline.
    connection = integration_owner_db.connection()
    assert connection.scalar(text("SELECT to_regclass('public.board_events')")) is not None
    _assert_event_schema_and_privileges(connection)


def _assert_event_schema_and_privileges(connection: Connection) -> None:
    expected_indexes = {
        "ix_board_events_board_id",
        "ix_board_events_author_id",
    }
    actual_indexes = set(
        connection.scalars(
            text(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
                "AND tablename = 'board_events'"
            )
        )
    )
    assert expected_indexes <= actual_indexes
    constraints = {
        row.conname: (row.contype, row.confdeltype)
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = 'public.board_events'::regclass"
            )
        )
    }
    for suffix in ("author_id_users", "board_id_boards"):
        assert constraints[f"fk_board_events_{suffix}"] == ("f", "r")
    assert constraints["fk_board_events_performed_by_users"] == ("f", "n")
    assert "ck_board_events_audience" not in constraints
    for name in (
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
    for action in TABLE_ACTIONS:
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                {"table": "public.board_events", "action": action},
            )
            is True
        )
    for role in SUPABASE_DATABASE_ROLES:
        for action in TABLE_ACTIONS:
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege(:role, :table, :action)"),
                    {"role": role, "table": "public.board_events", "action": action},
                )
                is False
            ), f"Supabase database role {role} must not access board_events"
