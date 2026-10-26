"""Shared Kanban rules: Board locks, stage and card loading, ranks, and card reads.

Lock order: every Kanban write locks the Board row first (as posts, events and
purges do), then its stages, cards, labels or checklist items. The Board lock
serializes Kanban writes on one Board, so rank arithmetic never races.

Ranks are gapped integers inside a stage (``GAP`` apart). A move takes the midpoint
of its new neighbours; when no integer is left between them, the stage is
renumbered in one transaction (through negative values first, because the active
``(stage_id, rank)`` index is unique and cannot be deferred).
"""

from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.access import board_level
from app.systems.boards.card_summary import card_records
from app.systems.boards.kanban_models import (
    BoardCard,
    BoardCardChecklistItem,
    BoardCardLabel,
    BoardLabel,
    BoardStage,
)
from app.systems.boards.kanban_schemas import (
    CardDetail,
    CardResponse,
    ChecklistItemResponse,
    ChecklistProgress,
)
from app.systems.boards.models import Board, BoardStatus
from app.systems.boards.router import _board_with_access

GAP = 1024
MAX_RANK = 2_000_000_000
MAX_STAGES = 20
MAX_LABELS = 20
MAX_CHECKLIST_ITEMS = 50


def kanban_error(code: str, message: str, status_code: int = 409) -> HTTPException:
    return HTTPException(status_code, detail={"code": code, "message": message})


def not_found(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail=f"{what} not found")


def now() -> datetime:
    return datetime.now(UTC)


def read_board(db: Session, actor: User, board_id: UUID) -> Board:
    return _board_with_access(db, actor, board_id, AccessLevel.READ)


def write_board(db: Session, actor: User, board_id: UUID, level: AccessLevel) -> Board:
    """Lock a live, active Board the actor holds ``level`` on (404 hidden, 403 below)."""

    board = _board_with_access(db, actor, board_id, level, lock=True)
    if board.status != BoardStatus.ACTIVE:
        raise kanban_error("board_archived", "Restore the Board before changing its Kanban")
    return board


def commit(db: Session, code: str, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise kanban_error(code, message) from error
    except SQLAlchemyError:
        db.rollback()
        raise


def check_revision(row: BoardStage | BoardCard | BoardLabel | BoardCardChecklistItem,
                   revision: int, code: str) -> None:
    if row.revision != revision:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={
                "code": code,
                "message": "Changed by someone else; reload before saving",
                "current_revision": row.revision,
            },
        )


def stage(db: Session, board_id: UUID, stage_id: UUID, *, lock: bool = False) -> BoardStage:
    statement = select(BoardStage).where(
        BoardStage.id == stage_id, BoardStage.board_id == board_id,
        BoardStage.is_deleted.is_(False),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(statement)
    if found is None:
        raise not_found("Stage")
    return found


def active_stage(db: Session, board_id: UUID, stage_id: UUID) -> BoardStage:
    """A stage named in a request body; an archived or foreign one is a conflict."""

    found = db.scalar(
        select(BoardStage)
        .where(
            BoardStage.id == stage_id, BoardStage.board_id == board_id,
            BoardStage.is_deleted.is_(False), BoardStage.archived_at.is_(None),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if found is None:
        raise kanban_error("stage_unavailable", "The stage is archived or not on this Board")
    return found


def card(db: Session, board_id: UUID, card_id: UUID, *, lock: bool = False) -> BoardCard:
    statement = select(BoardCard).where(
        BoardCard.id == card_id, BoardCard.board_id == board_id,
        BoardCard.is_deleted.is_(False),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(statement)
    if found is None:
        raise not_found("Card")
    return found


def _stage_cards(db: Session, stage_id: UUID, exclude: UUID | None) -> list[BoardCard]:
    statement = (
        select(BoardCard)
        .where(
            BoardCard.stage_id == stage_id,
            BoardCard.archived_at.is_(None),
            BoardCard.is_deleted.is_(False),
        )
        .order_by(BoardCard.rank, BoardCard.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if exclude is not None:
        statement = statement.where(BoardCard.id != exclude)
    return list(db.scalars(statement))


def place(db: Session, item: BoardCard, stage_id: UUID, position: int | None) -> None:
    """Put an active card at ``position`` (default: last) among a stage's active cards."""

    siblings = _stage_cards(db, stage_id, item.id)
    index = len(siblings) if position is None else min(position, len(siblings))
    before = siblings[index - 1].rank if index > 0 else 0
    after = siblings[index].rank if index < len(siblings) else before + 2 * GAP
    rank = (before + after) // 2
    if before < rank < after and rank <= MAX_RANK:
        item.stage_id, item.rank = stage_id, rank
        return
    ordered = [*siblings[:index], item, *siblings[index:]]
    for offset, row in enumerate(ordered, start=1):
        row.stage_id, row.rank = stage_id, -offset
    db.flush()
    for offset, row in enumerate(ordered, start=1):
        row.rank = offset * GAP


def valid_assignee(db: Session, board: Board, assignee_id: UUID | None) -> None:
    """An assignee is an active account that can read the Board now."""

    if assignee_id is None:
        return
    person = db.get(User, assignee_id)
    if person is None or board_level(db, person, board) is None:
        raise kanban_error("assignee_unavailable", "The assignee cannot read this Board")


def check_labels(db: Session, board: Board, label_ids: list[UUID] | None) -> None:
    """Every label is on this Board; checked before the card changes."""

    wanted = set(label_ids or ())
    if not wanted:
        return
    found = set(
        db.scalars(
            select(BoardLabel.id).where(
                BoardLabel.board_id == board.id, BoardLabel.id.in_(sorted(wanted)),
                BoardLabel.is_deleted.is_(False),
            )
        )
    )
    if found != wanted:
        raise kanban_error("label_unavailable", "A label is not on this Board")


def set_labels(db: Session, board: Board, item: BoardCard, label_ids: list[UUID]) -> bool:
    """Replace the card's labels (already checked); True when the set changed."""

    wanted = set(label_ids)
    current = {
        row.label_id: row
        for row in db.scalars(
            select(BoardCardLabel).where(BoardCardLabel.card_id == item.id).with_for_update()
        )
    }
    for label_id, row in current.items():
        if label_id not in wanted:
            db.delete(row)
    for label_id in sorted(wanted - current.keys()):
        db.add(BoardCardLabel(
            org_id=board.org_id, board_id=board.id, card_id=item.id, label_id=label_id
        ))
    return wanted != current.keys()


def stage_card_counts(db: Session, stage_ids: list[UUID]) -> dict[UUID, int]:
    """Active cards per stage. Locked record cards count too: they keep their place."""

    if not stage_ids:
        return {}
    return {
        stage_id: int(count)
        for stage_id, count in db.execute(
            select(BoardCard.stage_id, func.count(BoardCard.id))
            .where(
                BoardCard.stage_id.in_(stage_ids),
                BoardCard.archived_at.is_(None),
                BoardCard.is_deleted.is_(False),
            )
            .group_by(BoardCard.stage_id)
        ).tuples()
    }


def card_responses(db: Session, viewer: User, cards: list[BoardCard]) -> list[CardResponse]:
    """Cards as the Kanban and Gantt draw them, with three bounded batch reads."""

    ids = [item.id for item in cards]
    labels: dict[UUID, list[UUID]] = defaultdict(list)
    progress: dict[UUID, tuple[int, int]] = {}
    if ids:
        for card_id, label_id in db.execute(
            select(BoardCardLabel.card_id, BoardCardLabel.label_id)
            .join(BoardLabel, BoardLabel.id == BoardCardLabel.label_id)
            .where(BoardCardLabel.card_id.in_(ids))
            .order_by(BoardCardLabel.card_id, BoardLabel.position, BoardLabel.id)
        ).tuples():
            labels[card_id].append(label_id)
        progress = {
            card_id: (int(done), int(total))
            for card_id, done, total in db.execute(
                select(
                    BoardCardChecklistItem.card_id,
                    func.count(BoardCardChecklistItem.id).filter(
                        BoardCardChecklistItem.done.is_(True)
                    ),
                    func.count(BoardCardChecklistItem.id),
                )
                .where(BoardCardChecklistItem.card_id.in_(ids))
                .group_by(BoardCardChecklistItem.card_id)
            ).tuples()
        }
    records = card_records(db, viewer, [item for item in cards if item.kind == "record"])
    responses = []
    for item in cards:
        done, total = progress.get(item.id, (0, 0))
        responses.append(
            CardResponse(
                id=item.id,
                board_id=item.board_id,
                stage_id=item.stage_id,
                kind="record" if item.kind == "record" else "objective",
                title=item.title,
                rank=item.rank,
                assignee_id=item.assignee_id,
                start_on=item.start_on,
                due_on=item.due_on,
                label_ids=labels[item.id],
                checklist=ChecklistProgress(done=done, total=total),
                archived_at=item.archived_at,
                revision=item.revision,
                created_at=item.created_at,
                updated_at=item.updated_at,
                record=records.get(item.id),
            )
        )
    return responses


def checklist_items(db: Session, card_id: UUID) -> list[BoardCardChecklistItem]:
    return list(
        db.scalars(
            select(BoardCardChecklistItem)
            .where(BoardCardChecklistItem.card_id == card_id)
            .order_by(BoardCardChecklistItem.position, BoardCardChecklistItem.id)
        )
    )


def card_detail(db: Session, viewer: User, item: BoardCard) -> CardDetail:
    [summary] = card_responses(db, viewer, [item])
    return CardDetail(
        **summary.model_dump(),
        description=item.description,
        checklist_items=[
            ChecklistItemResponse.model_validate(row) for row in checklist_items(db, item.id)
        ],
    )
