"""Retained content links and publication snapshots block source Record purge."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import (
    BoardPostRevisionRecordLink,
    BoardRecordLink,
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
                "board_record_links": (),
                "board_post_revision_record_links": (),
            },
            set(),
        )
    current = list(
        db.scalars(
            select(BoardRecordLink)
            .where(BoardRecordLink.record_id.in_(record_ids))
            .order_by(BoardRecordLink.id)
        )
    )
    revisions = list(
        db.execute(
            select(BoardPostRevisionRecordLink, BoardPost.board_id)
            .join(
                BoardPostRevision,
                BoardPostRevision.id == BoardPostRevisionRecordLink.revision_id,
            )
            .join(
                BoardPost, BoardPost.id == BoardPostRevision.post_id
            )
            .where(BoardPostRevisionRecordLink.record_id.in_(record_ids))
            .order_by(BoardPostRevisionRecordLink.id)
        ).all()
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for link in current:
        state = row_state("board_record_links", link)
        state.state_fingerprint = fingerprint(
            {
                "board_id": link.board_id,
                "event_id": link.event_id,
                "post_id": link.post_id,
                "record_id": link.record_id,
                "module_id": link.module_id,
            }
        )
        rows.append(state)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_record_links",
                entity_id=link.id,
                detail="Remove this retained Board content link before purging its source Record",
                conflicting_entity_type="boards",
                conflicting_entity_id=link.board_id,
            )
        )
    for link, board_id in revisions:
        state = row_state("board_post_revision_record_links", link)
        state.state_fingerprint = fingerprint(
            {
                "revision_id": link.revision_id,
                "record_id": link.record_id,
                "module_id": link.module_id,
            }
        )
        rows.append(state)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_post_revision_record_links",
                entity_id=link.id,
                detail=(
                    "Permanently delete this published Post revision before "
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
            "board_record_links": tuple(link.id for link in current),
            "board_post_revision_record_links": tuple(link.id for link, _ in revisions),
        },
        {link.board_id for link in current} | {board_id for _, board_id in revisions},
    )
