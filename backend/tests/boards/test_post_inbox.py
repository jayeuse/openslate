"""Publication atomically records reference-only inbox recipients."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_service import publish_locked
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
from tests.boards.test_post_routes import _actor, _board, _client, _create_payload, _grant
from tests.boards.test_post_schedule_work import _create, _schedule, _subject

pytestmark = pytest.mark.integration


def test_manual_publish_route_commits_revision_and_inbox_before_reply(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manual-commit-owner")
    board = _board(db, owner)
    db.commit()
    client = _client(db, owner)
    root = f"/api/boards/{board.id}/posts"
    created = client.post(root, json=_create_payload(1))
    assert created.status_code == 201, created.text
    post_id = created.json()["id"]
    published = client.post(
        f"{root}/{post_id}/publish",
        json={
            "board_revision": 2,
            "post_revision": 1,
            "publication_key": str(uuid7()),
        },
    )
    assert published.status_code == 200, published.text
    with Session(db.get_bind()) as observer:
        revision = observer.scalar(
            select(BoardPostRevision).where(
                BoardPostRevision.post_id == post_id
            )
        )
        assert revision is not None
        work = observer.scalar(
            select(ScheduledWork).where(
                ScheduledWork.kind == WorkKind.POST_PUBLISH,
                ScheduledWork.post_id == post_id,
            )
        )
        assert work is not None and work.publication_result_id == revision.id
        assert (
            observer.scalar(
                select(InAppNotification.id).where(
                    InAppNotification.work_id == work.id,
                    InAppNotification.recipient_id == owner.id,
                )
            )
            is not None
        )


def test_manual_publication_inbox_snapshots_only_current_board_readers(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "inbox-owner")
    viewer = _actor(db, "inbox-viewer")
    manager = _actor(db, "inbox-manager")
    expired_viewer = _actor(db, "inbox-expired-viewer")
    expired_viewer.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    outsider = _actor(db, "inbox-outsider")
    board = _board(db, owner)
    _grant(db, board, viewer, "view")
    _grant(db, board, manager, "manage")
    _grant(db, board, expired_viewer, "view")
    item = BoardPost(
        board_id=board.id,
        author_id=owner.id,
        title="Publication inbox test",
        body="Current Board details",
    )
    db.add(item)
    db.commit()
    locked_board = db.scalar(select(Board).where(Board.id == board.id).with_for_update())
    locked_item = db.scalar(select(BoardPost).where(BoardPost.id == item.id).with_for_update())
    assert locked_board is not None and locked_item is not None

    key = uuid7()
    published = publish_locked(
        db,
        locked_board,
        locked_item,
        owner,
        publication_key=key,
        published_at=datetime.now(UTC),
        board_revision=1,
        post_revision=1,
    )
    db.commit()

    work = db.scalar(
        select(ScheduledWork).where(
            ScheduledWork.kind == WorkKind.POST_PUBLISH,
            ScheduledWork.post_id == item.id,
            ScheduledWork.source_revision == 1,
        )
    )
    assert work is not None
    assert work.state == WorkState.SUCCEEDED
    assert work.publication_result_id == published.id
    recipients = set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
        )
    )
    assert {owner.id, viewer.id, manager.id} <= recipients
    assert outsider.id not in recipients
    assert expired_viewer.id not in recipients

    replay = publish_locked(
        db,
        locked_board,
        locked_item,
        owner,
        publication_key=key,
        published_at=datetime.now(UTC),
        board_revision=1,
        post_revision=1,
    )
    assert replay.id == published.id
    assert (
        set(
            db.scalars(
                select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
            )
        )
        == recipients
    )


def test_scheduled_publication_fans_out_to_eligible_board_reader_once(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner_client, board, _ = _subject(db)
    viewer = _actor(db, "scheduled-inbox-viewer")
    outsider = _actor(db, "scheduled-inbox-outsider")
    _grant(db, board, viewer, "view")
    db.commit()
    root, item_id = _create(owner_client, board)
    due = datetime.now(UTC) + timedelta(days=2)
    _schedule(owner_client, root, item_id, 2, 1, due)

    claim = claim_due_post_work(db, now=due)[0]
    revision_id = finalize_post_claim(db, claim, now=due)
    assert revision_id is not None
    work = db.get(ScheduledWork, claim.id)
    assert work is not None and work.state == WorkState.SUCCEEDED
    assert work.publication_result_id == revision_id
    recipients = list(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
        )
    )
    assert recipients.count(viewer.id) == 1
    assert outsider.id not in recipients
    assert finalize_post_claim(db, claim, now=due) is None
    assert (
        list(
            db.scalars(
                select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
            )
        )
        == recipients
    )
