"""Retained announcement audiences must block Department physical purge."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Connection
from uuid6 import uuid7
from views.test_access import actor

from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
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


def test_department_purge_counts_and_locks_retained_announcement_audiences(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    owner = actor(db)
    now = datetime.now(UTC)
    target = Department(
        department_name=f"Announcement audience {uuid7().hex}",
        is_deleted=True,
        deleted_at=now,
    )
    unrelated = Department(department_name=f"Announcement Board parent {uuid7().hex}")
    db.add_all([target, unrelated])
    db.flush()
    board = Board(
        owner_id=owner.id,
        department_id=unrelated.id,
        name="Other Department Board",
        status=BoardStatus.ARCHIVED,
        is_deleted=True,
        deleted_at=now,
    )
    db.add(board)
    db.flush()
    draft = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Private draft",
        body="Private body",
        audience_kind="department",
        audience_department_id=target.id,
    )
    archived = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Archived draft",
        body="Private body",
        status="archived",
        audience_kind="department",
        audience_department_id=target.id,
        is_deleted=True,
        deleted_at=now,
    )
    republished = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Now for everyone",
        body="Current body",
        status="published",
        publish_at=now,
        audience_kind="everyone",
    )
    db.add_all([draft, archived, republished])
    db.flush()
    prior = BoardAnnouncementRevision(
        announcement_id=republished.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=owner.id,
        title="Prior private publication",
        body="Prior private body",
        audience_kind="department",
        audience_department_id=target.id,
        published_at=now,
    )
    deleted_prior = BoardAnnouncementRevision(
        announcement_id=republished.id,
        publication_number=2,
        publication_key=uuid7(),
        content_fingerprint="b" * 64,
        author_id=owner.id,
        title="Soft-deleted private publication",
        body="Prior private body",
        audience_kind="department",
        audience_department_id=target.id,
        published_at=now,
        is_deleted=True,
        deleted_at=now,
    )
    db.add_all([prior, deleted_prior])
    db.commit()

    plan = plan_lifecycle(db, "department", target.id, "purge", owner.id)
    assert set(plan.scope_ids["board_announcements"]) == {
        draft.id,
        archived.id,
        republished.id,
    }
    assert set(plan.scope_ids["board_announcement_revisions"]) == {
        prior.id,
        deleted_prior.id,
    }
    assert board.id in plan.scope_ids["boards"]
    assert {row.entity_id for row in plan.rows if row.entity_type == "board_announcements"} == {
        draft.id,
        archived.id,
    }
    revision_states = [
        row for row in plan.rows if row.entity_type == "board_announcement_revisions"
    ]
    assert {row.entity_id for row in revision_states} == {prior.id, deleted_prior.id}
    assert all(len(row.state_fingerprint) == 64 for row in revision_states)
    announcement_blockers = [
        blocker
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    ]
    assert {blocker.entity_id for blocker in announcement_blockers} == {
        draft.id,
        archived.id,
        prior.id,
        deleted_prior.id,
    }
    assert {blocker.conflicting_entity_id for blocker in announcement_blockers} == {target.id}
    assert all(
        "Private" not in blocker.detail and "body" not in blocker.detail
        for blocker in announcement_blockers
    )

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
    for table in ("board_announcements", "board_announcement_revisions"):
        assert any(
            f"FROM {table}" in statement and "FOR UPDATE NOWAIT" in statement
            for statement in statements
        )
    assert db.get(Department, target.id) is not None

    draft.title = "Changed title"
    db.commit()
    assert plan_lifecycle(db, "department", target.id, "purge", owner.id).impact_digest != (
        plan.impact_digest
    )
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, plan)
