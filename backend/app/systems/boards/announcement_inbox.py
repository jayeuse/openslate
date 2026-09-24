"""In-transaction publication notification fanout."""

from datetime import datetime

from sqlalchemy import exists, select
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserDepartmentMembership, UserStatus
from app.systems.boards.access import can_access_board
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.models import Board, BoardPermission
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)


def stage_publication_inbox(
    db: Session,
    board: Board,
    item: BoardAnnouncement,
    actor: User,
    published: BoardAnnouncementRevision,
    *,
    source_revision: int,
    published_at: datetime,
    scheduled_work: ScheduledWork | None,
) -> None:
    """Keep publication and eligible recipient references in one transaction."""

    # Imported here to avoid a module cycle: publication service calls this helper.
    from app.systems.boards.announcement_service import audience_clause, board_grants

    with db.no_autoflush:
        work = scheduled_work or db.scalar(
            select(ScheduledWork)
            .where(
                ScheduledWork.kind == WorkKind.ANNOUNCEMENT_PUBLISH,
                ScheduledWork.announcement_id == item.id,
                ScheduledWork.source_revision == source_revision,
            )
            .with_for_update()
        )
    if work is None:
        work = ScheduledWork(
            id=uuid7(),
            kind=WorkKind.ANNOUNCEMENT_PUBLISH,
            announcement_id=item.id,
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
    candidates = (
        select(User)
        .options(joinedload(User.role))
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
        )
    )
    if item.audience_kind == "author":
        candidates = candidates.where(User.id == item.author_id)
    elif item.audience_kind == "user":
        candidates = candidates.where(User.id == item.audience_user_id)
    elif item.audience_kind == "role":
        candidates = candidates.where(User.role_id == item.audience_role_id)
    elif item.audience_kind == "department":
        candidates = candidates.where(
            exists(
                select(UserDepartmentMembership.id).where(
                    UserDepartmentMembership.user_id == User.id,
                    UserDepartmentMembership.department_id == item.audience_department_id,
                    UserDepartmentMembership.is_deleted.is_(False),
                    UserDepartmentMembership.deleted_at.is_(None),
                )
            )
        )
    elif item.audience_kind != "everyone":
        return

    recipients = []
    with db.no_autoflush:
        grants = board_grants(db, board)
        for candidate in db.scalars(candidates.order_by(User.id)):
            if not can_access_board(board, candidate, BoardPermission.VIEW, grants):
                continue
            if (
                db.scalar(
                    select(BoardAnnouncement.id).where(
                        BoardAnnouncement.id == item.id,
                        audience_clause(BoardAnnouncement, candidate),
                    )
                )
                is not None
            ):
                recipients.append(candidate.id)
    db.add_all(
        InAppNotification(work_id=work.id, recipient_id=recipient_id) for recipient_id in recipients
    )
