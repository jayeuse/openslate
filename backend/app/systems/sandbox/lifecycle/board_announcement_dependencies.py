"""Retained Board announcement audiences that block Department purge."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def load_announcement_purge_dependencies(
    db: Session,
    department_ids: list[UUID],
    departments_by_id: dict[UUID, Department],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]]]:
    """Count retained current and publication audiences, including deleted rows."""

    announcements = (
        list(
            db.scalars(
                select(BoardAnnouncement)
                .where(BoardAnnouncement.audience_department_id.in_(department_ids))
                .order_by(BoardAnnouncement.id)
            )
        )
        if department_ids
        else []
    )
    revisions = (
        list(
            db.scalars(
                select(BoardAnnouncementRevision)
                .where(BoardAnnouncementRevision.audience_department_id.in_(department_ids))
                .order_by(BoardAnnouncementRevision.id)
            )
        )
        if department_ids
        else []
    )
    parent_ids = sorted({revision.announcement_id for revision in revisions})
    parents = (
        list(db.scalars(select(BoardAnnouncement).where(BoardAnnouncement.id.in_(parent_ids))))
        if parent_ids
        else []
    )
    parent_board_ids = {parent.id: parent.board_id for parent in parents}
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for announcement in announcements:
        state = row_state("board_announcements", announcement)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(announcement, key)
                for key in (
                    "board_id",
                    "author_id",
                    "title",
                    "body",
                    "status",
                    "publish_at",
                    "expires_at",
                    "pinned",
                    "audience_kind",
                    "audience_user_id",
                    "audience_department_id",
                    "revision",
                )
            }
        )
        rows.append(state)
        department_id = announcement.audience_department_id
        assert department_id is not None  # The query above excludes NULL audiences.
        department = departments_by_id.get(department_id)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_announcements",
                entity_id=announcement.id,
                detail=(
                    "Permanently delete this Board announcement or change its audience before "
                    "purging the Department; this operation will not delete the announcement"
                ),
                conflicting_entity_type="departments",
                conflicting_entity_id=department_id,
                department_id=department_id,
                department_name=(department.department_name if department is not None else None),
            )
        )
    for revision in revisions:
        board_id = parent_board_ids[revision.announcement_id]
        state = row_state("board_announcement_revisions", revision)
        state.state_fingerprint = fingerprint(
            {
                **{
                    key: getattr(revision, key)
                    for key in (
                        "announcement_id",
                        "publication_number",
                        "author_id",
                        "title",
                        "body",
                        "audience_kind",
                        "audience_user_id",
                        "audience_department_id",
                        "published_at",
                        "expires_at",
                    )
                },
                "parent_board_id": board_id,
            }
        )
        rows.append(state)
        department_id = revision.audience_department_id
        assert department_id is not None  # The query above excludes NULL audiences.
        department = departments_by_id.get(department_id)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_announcement_revisions",
                entity_id=revision.id,
                detail=(
                    "Permanently delete this retained Board announcement publication before "
                    "purging the Department; changing the current audience will not remove it"
                ),
                conflicting_entity_type="departments",
                conflicting_entity_id=department_id,
                department_id=department_id,
                department_name=(department.department_name if department is not None else None),
            )
        )
    return (
        rows,
        blockers,
        {
            "board_announcements": tuple(
                sorted({announcement.id for announcement in announcements}
                       | {revision.announcement_id for revision in revisions})
            ),
            "board_announcement_revisions": tuple(revision.id for revision in revisions),
            "boards": tuple(sorted({announcement.board_id for announcement in announcements}
                                   | set(parent_board_ids.values()))),
        },
    )
