"""Post schedule intent and lifecycle are one durable Board mutation."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_router import router
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.platform.scheduling.post_execution import (
    claim_due_post_work,
    finalize_post_claim,
)
from tests.boards.support import board_group
from tests.boards.support import client as board_client
from tests.conftest import create_member
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def _subject(db: Session) -> tuple[TestClient, Board, User]:
    role = "member"
    actor_id = uuid7()
    actor, _membership = create_member(db, organization(db),
        id=actor_id,
        email=f"post-scheduler-{actor_id.hex}@example.test",
        username=f"post_scheduler_{actor_id.hex[:12]}",
        status="active",
        role=role,
    )
    db.add(actor)
    db.flush()
    board = Board(scope="project", name=f"Post schedule {uuid7().hex[:8]}")
    db.add(board)
    db.flush()
    board_group(db, board, [actor], "write")
    db.commit()
    return board_client(db, actor, router), board, actor


def _create(client: TestClient, board: Board) -> tuple[str, str]:
    root = f"/api/boards/{board.id}/posts"
    created = client.post(
        root,
        json={
            "board_revision": board.revision,
            "title": "Scheduled notice",
            "body": "Publication content",
        },
    )
    assert created.status_code == 201
    return root, created.json()["id"]


def _schedule(
    client: TestClient,
    root: str,
    item_id: str,
    board_revision: int,
    item_revision: int,
    when: datetime,
) -> dict[str, int | str]:
    result = client.post(
        f"{root}/{item_id}/schedule",
        json={
            "board_revision": board_revision,
            "post_revision": item_revision,
            "publish_at": when.isoformat(),
        },
    )
    assert result.status_code == 200, result.text
    return result.json()


def _work(db: Session, item_id: str) -> list[ScheduledWork]:
    return list(
        db.scalars(
            select(ScheduledWork)
            .where(ScheduledWork.post_id == item_id)
            .order_by(ScheduledWork.source_revision)
        )
    )


def test_schedule_creates_one_due_work_and_supersede_cancels_the_old_occurrence(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    client, board, actor = _subject(db)
    root, item_id = _create(client, board)
    first_time = datetime.now(UTC) + timedelta(days=2)

    first = _schedule(client, root, item_id, 2, 1, first_time)
    rows = _work(db, item_id)
    assert len(rows) == 1
    assert rows[0].kind == WorkKind.POST_PUBLISH
    assert rows[0].state == WorkState.PENDING
    assert rows[0].source_revision == first["post_revision"] == 2
    assert rows[0].scheduled_for == first_time
    assert rows[0].next_attempt_at == first_time
    assert rows[0].scheduling_actor_id == actor.id

    second_time = first_time + timedelta(days=1)
    second = _schedule(client, root, item_id, 3, 2, second_time)
    rows = _work(db, item_id)
    assert len(rows) == 2
    assert [row.state for row in rows] == [WorkState.CANCELED, WorkState.PENDING]
    assert rows[0].failure_code == "schedule_changed"
    assert rows[0].finished_at is not None
    assert rows[0].last_attempt_started_at is None
    assert rows[1].source_revision == second["post_revision"] == 3
    assert rows[1].scheduled_for == second_time


@pytest.mark.parametrize("mutation", ["patch", "publish", "archive"])
def test_mutating_scheduled_post_resolves_pending_work(
    integration_owner_db: Session,
    mutation: str,
) -> None:
    db = integration_owner_db
    client, board, _ = _subject(db)
    root, item_id = _create(client, board)
    _schedule(client, root, item_id, 2, 1, datetime.now(UTC) + timedelta(days=2))
    body: dict[str, object] = {"board_revision": 3, "post_revision": 2}
    if mutation == "patch":
        body["title"] = "Edited before publication"
        result = client.patch(f"{root}/{item_id}", json=body)
    elif mutation == "publish":
        body["publication_key"] = str(uuid7())
        result = client.post(f"{root}/{item_id}/publish", json=body)
    else:
        result = client.post(f"{root}/{item_id}/archive", json=body)
    assert result.status_code == 200, result.text
    row = _work(db, item_id)[0]
    assert row.state == (WorkState.SUCCEEDED if mutation == "publish" else WorkState.CANCELED)
    if mutation == "publish":
        assert row.publication_result_id is not None
        assert row.scheduled_for <= datetime.now(UTC)
    assert row.lease_token is None and row.lease_expires_at is None
    assert row.finished_at is not None
    assert row.last_attempt_started_at is None


def test_stale_schedule_denial_does_not_create_or_cancel_work(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    client, board, actor = _subject(db)
    root, item_id = _create(client, board)
    first = _schedule(client, root, item_id, 2, 1, datetime.now(UTC) + timedelta(days=2))
    denied = client.post(
        f"{root}/{item_id}/schedule",
        json={
            "board_revision": first["board_revision"],
            "post_revision": 1,
            "publish_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
        },
    )
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "stale_post_revision"
    outsider_id = uuid7()
    outsider, _membership = create_member(db, organization(db),
        id=outsider_id,
        email=f"post-outsider-{outsider_id.hex}@example.test",
        username=f"post_outsider_{outsider_id.hex[:12]}",
        status="active",
        role="member",
    )
    db.add(outsider)
    db.commit()
    forbidden = board_client(db, outsider, router).post(
        f"{root}/{item_id}/schedule",
        json={
            "board_revision": first["board_revision"],
            "post_revision": first["post_revision"],
            "publish_at": (datetime.now(UTC) + timedelta(days=3)).isoformat(),
        },
    )
    assert forbidden.status_code == 404
    rows = _work(db, item_id)
    assert len(rows) == 1 and rows[0].state == WorkState.PENDING


def test_edit_cancels_an_already_claimed_publication_before_finalization(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    client, board, _ = _subject(db)
    root, item_id = _create(client, board)
    publish_at = datetime.now(UTC) + timedelta(days=2)
    _schedule(client, root, item_id, 2, 1, publish_at)
    claim = claim_due_post_work(db, now=publish_at)[0]
    assert _work(db, item_id)[0].state == WorkState.RUNNING

    changed = client.patch(
        f"{root}/{item_id}",
        json={"board_revision": 3, "post_revision": 2, "title": "Replaced draft"},
    )
    assert changed.status_code == 200
    assert _work(db, item_id)[0].state == WorkState.CANCELED
    assert finalize_post_claim(db, claim, now=publish_at) is None
    revisions = db.scalars(
        select(BoardPostRevision).where(BoardPostRevision.post_id == item_id)
    ).all()
    assert revisions == []


def test_unpublish_cancels_replacement_schedule_without_deleting_prior_revision(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    client, board, _ = _subject(db)
    root, item_id = _create(client, board)
    published = client.post(
        f"{root}/{item_id}/publish",
        json={"board_revision": 2, "post_revision": 1, "publication_key": str(uuid7())},
    )
    assert published.status_code == 200
    revision_id = published.json()["id"]
    _schedule(client, root, item_id, 3, 2, datetime.now(UTC) + timedelta(days=2))

    unpublished = client.post(
        f"{root}/{item_id}/unpublish",
        json={"board_revision": 4, "post_revision": 3},
    )
    assert unpublished.status_code == 200
    assert _work(db, item_id)[-1].state == WorkState.CANCELED
    assert db.get(BoardPostRevision, revision_id) is not None


def test_delete_removes_a_scheduled_draft_and_archives_a_published_post_with_its_work(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    client, board, actor = _subject(db)
    root, draft_id = _create(client, board)
    _schedule(client, root, draft_id, 2, 1, datetime.now(UTC) + timedelta(days=2))
    [draft_work] = _work(db, draft_id)
    removed = client.request(
        "DELETE", f"{root}/{draft_id}", json={"board_revision": 3, "post_revision": 2}
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["outcome"] == "deleted"
    assert db.get(BoardPost, draft_id) is None
    assert db.get(ScheduledWork, draft_work.id) is None

    db.refresh(board)
    root, item_id = _create(client, board)
    published = client.post(
        f"{root}/{item_id}/publish",
        json={"board_revision": 5, "post_revision": 1, "publication_key": str(uuid7())},
    )
    assert published.status_code == 200
    manual_revision_id = published.json()["id"]
    publish_at = datetime.now(UTC) + timedelta(days=2)
    _schedule(client, root, item_id, 6, 2, publish_at)
    work = _work(db, item_id)[-1]
    claim = claim_due_post_work(db, now=publish_at)[0]
    revision_id = finalize_post_claim(db, claim, now=publish_at)
    assert revision_id is not None
    notice = db.scalar(
        select(InAppNotification).where(
            InAppNotification.work_id == work.id,
            InAppNotification.recipient_id == actor.id,
        )
    )
    assert notice is not None
    kept = client.request(
        "DELETE", f"{root}/{item_id}", json={"board_revision": 8, "post_revision": 4}
    )
    assert kept.status_code == 200, kept.text
    assert kept.json()["outcome"] == "archived"
    assert db.get(BoardPost, item_id).status == "archived"
    for model, row_id in (
        (BoardPostRevision, revision_id),
        (BoardPostRevision, manual_revision_id),
        (ScheduledWork, work.id),
        (InAppNotification, notice.id),
    ):
        assert db.get(model, row_id) is not None


def test_schedule_locks_board_then_post_then_prior_work(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    client, board, _ = _subject(db)
    root, item_id = _create(client, board)
    _schedule(client, root, item_id, 2, 1, datetime.now(UTC) + timedelta(days=2))
    statements: list[str] = []
    connection: Connection = db.connection()

    def collect_sql(_connection, _cursor, statement, _parameters, _context, _executemany) -> None:
        if "FOR UPDATE" in statement:
            statements.append(statement)

    event.listen(connection, "before_cursor_execute", collect_sql)
    try:
        result = _schedule(client, root, item_id, 3, 2, datetime.now(UTC) + timedelta(days=3))
        assert result["post_revision"] == 3
    finally:
        event.remove(connection, "before_cursor_execute", collect_sql)
    board_lock = next(i for i, sql in enumerate(statements) if "FROM boards " in sql)
    item_lock = next(i for i, sql in enumerate(statements) if "FROM board_posts " in sql)
    work_lock = next(i for i, sql in enumerate(statements) if "FROM scheduled_work " in sql)
    assert board_lock < item_lock < work_lock
