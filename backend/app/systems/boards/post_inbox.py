"""In-transaction publication notification fanout to every reader of the Board."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.boards.access import board_reader_ids
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.platform.scheduling.models import (
    InAppNotification,
    NotificationKind,
    ScheduledWork,
    WorkKind,
    WorkState,
)


def stage_publication_inbox(
    db: Session,
    board: Board,
    item: BoardPost,
    actor: User,
    published: BoardPostRevision,
    *,
    source_revision: int,
    published_at: datetime,
    scheduled_work: ScheduledWork | None,
) -> None:
    """Keep publication and one notification for each current Board reader together."""

    with db.no_autoflush:
        work = scheduled_work or db.scalar(
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.POST_PUBLISH,
                ScheduledWork.post_id == item.id,
                ScheduledWork.source_revision == source_revision,
            )
            .with_for_update()
        )
    if work is None:
        work = ScheduledWork(
            id=uuid7(),
            kind=WorkKind.POST_PUBLISH,
            post_id=item.id,
            source_revision=source_revision,
            scheduling_actor_id=actor.id,
            scheduled_for=published_at,
            next_attempt_at=published_at,
            state=WorkState.SUCCEEDED,
            publication_result_id=published.id,
        )
        db.add(work)
    elif scheduled_work is None:
        work.state = WorkState.SUCCEEDED
        work.scheduled_for = published_at
        work.next_attempt_at = published_at
        work.publication_result_id = published.id
        work.failure_code = None
        work.lease_token = None
        work.lease_expires_at = None

    db.flush()
    with db.no_autoflush:
        recipients = sorted(board_reader_ids(db, board))
    db.add_all(
        InAppNotification(
            work_id=work.id,
            recipient_id=recipient_id,
            kind=NotificationKind.POST_PUBLISH,
            subject_type="board_post",
            subject_id=item.id,
        )
        for recipient_id in recipients
    )
