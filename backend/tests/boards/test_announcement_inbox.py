"""Publication atomically records reference-only inbox recipients."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_service import publish_locked
from app.systems.boards.models import Board
from app.systems.platform.scheduling.announcement_execution import (
    claim_due_announcement_work,
    finalize_announcement_claim,
)
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from tests.boards.test_announcement_routes import _actor, _board, _client, _create_payload, _grant
from tests.boards.test_announcement_schedule_work import _create, _schedule, _subject

pytestmark = pytest.mark.integration


def test_manual_publish_route_commits_revision_and_inbox_before_reply(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "manual-commit-owner")
    board = _board(db, owner)
    db.commit()
    client = _client(db, owner)
    root = f"/api/boards/{board.id}/announcements"
    created = client.post(root, json=_create_payload(1))
    assert created.status_code == 201, created.text
    announcement_id = created.json()["id"]
    published = client.post(
        f"{root}/{announcement_id}/publish",
        json={
            "board_revision": 2,
            "announcement_revision": 1,
            "publication_key": str(uuid7()),
        },
    )
    assert published.status_code == 200, published.text
    with Session(db.get_bind()) as observer:
        revision = observer.scalar(
            select(BoardAnnouncementRevision).where(
                BoardAnnouncementRevision.announcement_id == announcement_id
            )
        )
        assert revision is not None
        work = observer.scalar(
            select(ScheduledWork).where(
                ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
                ScheduledWork.announcement_id == announcement_id,
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


@pytest.mark.parametrize(
    ("audience_kind", "expected_viewer"),
    [("author", False), ("everyone", True)],
)
def test_manual_publication_inbox_snapshots_only_eligible_board_readers(
    integration_owner_db: Session,
    audience_kind: str,
    expected_viewer: bool,
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
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Publication inbox test",
        body="Current Board details",
        audience_kind=audience_kind,
    )
    db.add(item)
    db.commit()
    locked_board = db.scalar(select(Board).where(Board.id == board.id).with_for_update())
    locked_item = db.scalar(
        select(BoardAnnouncement).where(BoardAnnouncement.id == item.id).with_for_update()
    )
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
        announcement_revision=1,
    )
    db.commit()

    work = db.scalar(
        select(ScheduledWork).where(
            ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
            ScheduledWork.announcement_id == item.id,
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
    expected = {owner.id}
    if expected_viewer:
        expected.update((viewer.id, manager.id))
    assert recipients == expected
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
        announcement_revision=1,
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

    claim = claim_due_announcement_work(db, now=due)[0]
    revision_id = finalize_announcement_claim(db, claim, now=due)
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
    assert finalize_announcement_claim(db, claim, now=due) is None
    assert (
        list(
            db.scalars(
                select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
            )
        )
        == recipients
    )
