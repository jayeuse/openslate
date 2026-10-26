"""Kanban cards: readers list and read them; writers (the post level) change them.

A record card is created only by someone who can read its Record. A viewer who
cannot read it sees the card locked (``card_summary``). Writers may move, archive
and restore a locked card; nobody changes anything else on it.
"""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import Text, exists, func, select
from sqlalchemy import cast as sql_cast
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.card_summary import is_locked
from app.systems.boards.kanban_models import BoardCard, BoardCardLabel
from app.systems.boards.kanban_schemas import (
    CardCreate,
    CardDetail,
    CardListRequest,
    CardListResponse,
    CardPatch,
    CardRestore,
    CardSort,
    ObjectiveCreate,
    RevisionWrite,
)
from app.systems.boards.kanban_service import (
    active_stage,
    card,
    card_detail,
    card_responses,
    check_labels,
    check_revision,
    commit,
    kanban_error,
    now,
    place,
    read_board,
    set_labels,
    valid_assignee,
    write_board,
)
from app.systems.boards.record_link_service import _available_record
from app.systems.platform.files.access import fresh_user
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/boards", tags=["board kanban"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]
_MOVE_FIELDS = frozenset({"stage_id", "position"})
_OBJECTIVE_FIELDS = frozenset({"title", "description"})


def _searchable(db: Session, viewer: User) -> ColumnElement[str]:
    """An objective's title, or the Record title only where the viewer reads it live."""

    title = (
        select(Record.data.op("->>")(sql_cast(Module.title_field_id, Text)))
        .join(Module, Module.id == Record.module_id)
        .where(
            Record.id == BoardCard.record_id,
            Record.is_deleted.is_(False), Record.deleted_at.is_(None),
            Module.is_deleted.is_(False), Module.deleted_at.is_(None),
            module_filter(db, viewer, AccessLevel.READ, Record.module_id),
        )
        .correlate(BoardCard)
        .scalar_subquery()
    )
    return cast(ColumnElement[str], func.coalesce(BoardCard.title, title))


def _spec(db: Session, viewer: User) -> ListQuerySpec[CardSort]:
    return ListQuerySpec(
        sort_fields={
            CardSort.RANK: cast(ColumnElement[Any], BoardCard.rank),
            CardSort.DUE_ON: cast(ColumnElement[Any], BoardCard.due_on),
            CardSort.START_ON: cast(ColumnElement[Any], BoardCard.start_on),
            CardSort.CREATED_AT: cast(ColumnElement[Any], BoardCard.created_at),
        },
        default_sort=CardSort.RANK,
        tie_breaker=cast(ColumnElement[Any], BoardCard.id),
        search_fields=(_searchable(db, viewer),),
    )


@router.get("/{board_id}/cards", response_model=CardListResponse)
def list_board_cards(
    board_id: UUID, actor: Reader, db: Database, params: Annotated[CardListRequest, Query()]
) -> CardListResponse:
    """Cards for the Kanban (one stage at a time) and the Gantt and calendar (by due)."""

    board = read_board(db, actor, board_id)
    statement = select(BoardCard).where(
        BoardCard.board_id == board.id,
        BoardCard.is_deleted.is_(False),
        BoardCard.archived_at.is_not(None) if params.archived else BoardCard.archived_at.is_(None),
    )
    if params.stage_id is not None:
        statement = statement.where(BoardCard.stage_id == params.stage_id)
    if params.assignee is not None:
        assignee = actor.id if params.assignee == "me" else params.assignee
        statement = statement.where(BoardCard.assignee_id == assignee)
    if params.label:
        statement = statement.where(
            exists(
                select(BoardCardLabel.id).where(
                    BoardCardLabel.card_id == BoardCard.id,
                    BoardCardLabel.label_id.in_(params.label),
                )
            )
        )
    if params.due_from is not None:
        statement = statement.where(BoardCard.due_on >= params.due_from)
    if params.due_to is not None:
        statement = statement.where(BoardCard.due_on <= params.due_to)
    result = execute_standard_list(db, statement, params, _spec(db, actor))
    return CardListResponse(
        items=card_responses(db, actor, result.items), pagination=result.pagination
    )


@router.post(
    "/{board_id}/cards", response_model=CardDetail, status_code=status.HTTP_201_CREATED
)
def create_board_card(
    board_id: UUID,
    payload: CardCreate,
    actor: Reader,
    db: Database,
    response: Response,
) -> CardDetail:
    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    target = active_stage(db, board.id, payload.stage_id)
    valid_assignee(db, board, payload.assignee_id)
    check_labels(db, board, payload.label_ids)
    item = BoardCard(
        id=uuid7(), org_id=board.org_id, board_id=board.id, kind=payload.kind,
        assignee_id=payload.assignee_id, start_on=payload.start_on, due_on=payload.due_on,
    )
    if isinstance(payload, ObjectiveCreate):
        item.title, item.description = payload.title, payload.description
    else:
        record = _available_record(db, fresh_user(db, actor.id), payload.record_id)
        duplicate = db.scalar(
            select(BoardCard.id).where(
                BoardCard.board_id == board.id, BoardCard.record_id == record.id,
                BoardCard.archived_at.is_(None), BoardCard.is_deleted.is_(False),
            )
        )
        if duplicate is not None:
            raise kanban_error("record_card_exists", "The Record already has a card here")
        item.record_id, item.module_id = record.id, record.module_id
    place(db, item, target.id, payload.position)
    db.add(item)
    db.flush()
    set_labels(db, board, item, payload.label_ids)
    commit(db, "card_conflict", "Unable to add the card; reload the Board")
    db.refresh(item)
    response.headers["Location"] = f"/api/boards/{board.id}/cards/{item.id}"
    return card_detail(db, actor, item)


@router.get("/{board_id}/cards/{card_id}", response_model=CardDetail)
def read_board_card(board_id: UUID, card_id: UUID, actor: Reader, db: Database) -> CardDetail:
    board = read_board(db, actor, board_id)
    return card_detail(db, actor, card(db, board.id, card_id))


@router.patch("/{board_id}/cards/{card_id}", response_model=CardDetail)
def update_board_card(
    board_id: UUID, card_id: UUID, payload: CardPatch, actor: Reader, db: Database
) -> CardDetail:
    """Change fields, move (stage and position) and set dates in one revisioned save."""

    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    item = card(db, board.id, card_id, lock=True)
    check_revision(item, payload.revision, "stale_card_revision")
    if item.archived_at is not None:
        raise kanban_error("card_archived", "Restore the card before changing it")
    changes = payload.model_fields_set - {"revision"}
    if item.kind == "record" and changes & _OBJECTIVE_FIELDS:
        raise kanban_error("record_card_fields", "A record card has no title or description")
    if changes - _MOVE_FIELDS and is_locked(db, actor, item):
        raise kanban_error("record_locked", "You can only move or archive this card", 403)
    if "assignee_id" in changes:
        valid_assignee(db, board, payload.assignee_id)
    check_labels(db, board, payload.label_ids)
    start_on = payload.start_on if "start_on" in changes else item.start_on
    due_on = payload.due_on if "due_on" in changes else item.due_on
    if start_on is not None and due_on is not None and start_on > due_on:
        raise kanban_error("card_dates_invalid", "The start must not be after the due date", 422)
    destination = payload.stage_id or item.stage_id
    if changes & _MOVE_FIELDS and destination != item.stage_id:
        active_stage(db, board.id, destination)
    # Every check has passed: change the card.
    if "assignee_id" in changes:
        item.assignee_id = payload.assignee_id
    for key in ("title", "description"):
        if key in changes:
            setattr(item, key, getattr(payload, key))
    item.start_on, item.due_on = start_on, due_on
    changed = bool(changes - {"label_ids"})
    if payload.label_ids is not None:
        changed = set_labels(db, board, item, payload.label_ids) or changed
    if changes & _MOVE_FIELDS:
        place(db, item, destination, payload.position)
    if changed:
        item.revision += 1
    commit(db, "card_conflict", "Unable to save the card; reload the Board")
    db.refresh(item)
    return card_detail(db, actor, item)


@router.post("/{board_id}/cards/{card_id}/archive", response_model=CardDetail)
def archive_board_card(
    board_id: UUID, card_id: UUID, payload: RevisionWrite, actor: Reader, db: Database
) -> CardDetail:
    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    item = card(db, board.id, card_id, lock=True)
    check_revision(item, payload.revision, "stale_card_revision")
    if item.archived_at is not None:
        raise kanban_error("card_archived", "The card is already archived")
    item.archived_at = now()
    item.revision += 1
    commit(db, "card_conflict", "Unable to archive the card; reload the Board")
    db.refresh(item)
    return card_detail(db, actor, item)


@router.post("/{board_id}/cards/{card_id}/restore", response_model=CardDetail)
def restore_board_card(
    board_id: UUID, card_id: UUID, payload: CardRestore, actor: Reader, db: Database
) -> CardDetail:
    """Restore to the end of its stage, or of ``stage_id`` when its stage is archived."""

    board = write_board(db, actor, board_id, AccessLevel.WRITE)
    item = card(db, board.id, card_id, lock=True)
    check_revision(item, payload.revision, "stale_card_revision")
    if item.archived_at is None:
        raise kanban_error("card_not_archived", "Archive the card before restoring it")
    destination = active_stage(db, board.id, payload.stage_id or item.stage_id)
    if item.record_id is not None and db.scalar(
        select(BoardCard.id).where(
            BoardCard.board_id == board.id, BoardCard.record_id == item.record_id,
            BoardCard.archived_at.is_(None), BoardCard.is_deleted.is_(False),
        )
    ):
        raise kanban_error("record_card_exists", "The Record already has a card here")
    # Rank first: the card rejoins the unique active ranks only with its new rank.
    place(db, item, destination.id, None)
    item.archived_at = None
    item.revision += 1
    commit(db, "card_conflict", "Unable to restore the card; reload the Board")
    db.refresh(item)
    return card_detail(db, actor, item)

