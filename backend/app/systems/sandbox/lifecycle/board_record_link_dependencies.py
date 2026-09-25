"""Retained content links and publication snapshots block source Record purge."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.record_link_models import (
    BoardAnnouncementRevisionRecordLink,
    BoardContentRecordLink,
)
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def load_board_record_link_purge_dependencies(
    db: Session,
    record_ids: list[UUID],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]], set[UUID]]:
    if not record_ids:
        return (
            [],
            [],
            {
                "board_content_record_links": (),
                "board_announcement_revision_record_links": (),
            },
            set(),
        )
    current = list(
        db.scalars(
            select(BoardContentRecordLink)
            .where(BoardContentRecordLink.record_id.in_(record_ids))
            .order_by(BoardContentRecordLink.id)
        )
    )
    revisions = list(
        db.execute(
            select(BoardAnnouncementRevisionRecordLink, BoardAnnouncement.board_id)
            .join(
                BoardAnnouncementRevision,
                BoardAnnouncementRevision.id == BoardAnnouncementRevisionRecordLink.revision_id,
            )
            .join(
                BoardAnnouncement, BoardAnnouncement.id == BoardAnnouncementRevision.announcement_id
            )
            .where(BoardAnnouncementRevisionRecordLink.record_id.in_(record_ids))
            .order_by(BoardAnnouncementRevisionRecordLink.id)
        ).all()
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for link in current:
        state = row_state("board_content_record_links", link)
        state.state_fingerprint = fingerprint(
            {
                "board_id": link.board_id,
                "event_id": link.event_id,
                "announcement_id": link.announcement_id,
                "record_id": link.record_id,
                "module_id": link.module_id,
                "label": link.label,
            }
        )
        rows.append(state)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_content_record_links",
                entity_id=link.id,
                detail="Remove this retained Board content link before purging its source Record",
                conflicting_entity_type="boards",
                conflicting_entity_id=link.board_id,
            )
        )
    for link, board_id in revisions:
        state = row_state("board_announcement_revision_record_links", link)
        state.state_fingerprint = fingerprint(
            {
                "revision_id": link.revision_id,
                "record_id": link.record_id,
                "module_id": link.module_id,
                "label": link.label,
            }
        )
        rows.append(state)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_announcement_revision_record_links",
                entity_id=link.id,
                detail=(
                    "Permanently delete this published Announcement revision before "
                    "purging its source Record"
                ),
                conflicting_entity_type="boards",
                conflicting_entity_id=board_id,
            )
        )
    return (
        rows,
        blockers,
        {
            "board_content_record_links": tuple(link.id for link in current),
            "board_announcement_revision_record_links": tuple(link.id for link, _ in revisions),
        },
        {link.board_id for link in current} | {board_id for _, board_id in revisions},
    )
