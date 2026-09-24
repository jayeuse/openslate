"""A retained event's audience is a Department purge dependency."""

from datetime import UTC, date, datetime

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Connection
from uuid6 import uuid7
from views.test_access import actor

from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode

pytestmark = pytest.mark.integration


def test_department_purge_counts_fingerprints_and_locks_retained_event_audiences(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    owner = actor(db)
    target = Department(
        department_name=f"Event audience target {uuid7().hex}",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    unrelated = Department(department_name=f"Event Board parent {uuid7().hex}")
    db.add_all([target, unrelated])
    db.flush()
    board = Board(
        owner_id=owner.id,
        department_id=unrelated.id,
        name="Other Department Board",
        status=BoardStatus.ARCHIVED,
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(board)
    db.flush()

    rows = []
    for archived, deleted in ((False, False), (True, False), (True, True)):
        row = BoardEvent(
            board_id=board.id,
            author_id=owner.id,
            title="Retained event",
            all_day=True,
            start_date=date(2026, 9, 23),
            end_date=date(2026, 9, 23),
            timezone_name="Asia/Manila",
            audience_kind="department",
            audience_department_id=target.id,
            archived=archived,
            is_deleted=deleted,
            deleted_at=datetime.now(UTC) if deleted else None,
        )
        rows.append(row)
    db.add_all(rows)
    db.commit()

    plan = plan_lifecycle(db, "department", target.id, "purge", owner.id)
    event_ids = {row.id for row in rows}
    assert set(plan.scope_ids["board_events"]) == event_ids
    assert board.id in plan.scope_ids["boards"]
    event_states = [row for row in plan.rows if row.entity_type == "board_events"]
    assert {row.entity_id for row in event_states} == event_ids
    assert all(len(row.state_fingerprint) == 64 for row in event_states)
    event_blockers = [
        blocker
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    ]
    assert {blocker.entity_id for blocker in event_blockers} == event_ids
    assert {blocker.conflicting_entity_id for blocker in event_blockers} == {target.id}

    statements: list[str] = []
    connection: Connection = db.connection()

    def collect_sql(_connection, _cursor, statement, _parameters, _context, _executemany) -> None:
        statements.append(statement)

    event.listen(connection, "before_cursor_execute", collect_sql)
    try:
        with pytest.raises(LifecyclePreflightError):
            execute_lifecycle(db, plan)
    finally:
        event.remove(connection, "before_cursor_execute", collect_sql)
    assert any(
        "FROM board_events" in statement and "FOR UPDATE NOWAIT" in statement
        for statement in statements
    )
    assert db.get(Department, target.id) is not None

    rows[0].title = "Changed title"
    db.commit()
    changed = plan_lifecycle(db, "department", target.id, "purge", owner.id)
    assert changed.impact_digest != plan.impact_digest
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, plan)
