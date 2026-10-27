"""Card activity read from the audit log (BR81); audit snapshots never leave the server.

The access rule mirrors Board activity (``activity_router``): the viewer must read
the Board (else 404), the card must be on that Board (else 404), and each audit row
becomes an allowlisted kind, action and fixed summary with the actor's username
only while that account is active. A rank-only update (a reorder or a renumber) and
a checklist reorder are not activity.
"""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.activity_router import _active_actor_labels
from app.systems.boards.kanban_models import BoardCardChecklistItem, BoardCardLabel
from app.systems.boards.kanban_schemas import (
    CardActivityKind,
    CardActivityListRequest,
    CardActivityListResponse,
    CardActivityResponse,
    CardActivitySort,
)
from app.systems.boards.kanban_service import card, read_board
from app.systems.manage.audit.models import AuditAction, AuditLog

router = APIRouter(prefix="/boards", tags=["board kanban"])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]

ACTIVITY_LIST_SPEC = ListQuerySpec(
    sort_fields={CardActivitySort.CREATED_AT: cast(ColumnElement[Any], AuditLog.created_at)},
    default_sort=CardActivitySort.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], AuditLog.id),
)
_KIND = {
    "board_cards": CardActivityKind.CARD,
    "board_card_labels": CardActivityKind.LABEL,
    "board_card_checklist_items": CardActivityKind.CHECKLIST,
}
_CARD_FIELDS = (
    "stage_id", "title", "description", "assignee_id", "start_on", "due_on", "archived_at",
)


def _of_card(model: type[BoardCardLabel] | type[BoardCardChecklistItem],
             card_id: UUID) -> ColumnElement[bool]:
    """Rows of the card now, or removed rows whose snapshot names the card."""

    text = str(card_id)
    return or_(
        exists(select(model.id).where(model.id == AuditLog.entity_id, model.card_id == card_id)),
        AuditLog.before["card_id"].astext == text,
        AuditLog.after["card_id"].astext == text,
    )


def _summary(row: AuditLog) -> str:
    kind, after = _KIND[row.entity_type], row.after or {}
    if kind is CardActivityKind.LABEL:
        return "Label added" if row.action == AuditAction.CREATE else "Label removed"
    if kind is CardActivityKind.CHECKLIST:
        if row.action == AuditAction.CREATE:
            return "Checklist item added"
        if row.action == AuditAction.DELETE:
            return "Checklist item removed"
        if "done" in after:
            return "Checklist item done" if after["done"] else "Checklist item reopened"
        return "Checklist item edited"
    if row.action == AuditAction.CREATE:
        return "Card added"
    if row.action == AuditAction.DELETE:
        return "Card removed"
    if "archived_at" in after:
        return "Card archived" if after["archived_at"] else "Card restored"
    if "stage_id" in after:
        return "Card moved"
    if "start_on" in after or "due_on" in after:
        return "Dates changed"
    if "assignee_id" in after:
        return "Assignee changed"
    return "Card edited"


@router.get("/{board_id}/cards/{card_id}/activity", response_model=CardActivityListResponse)
def list_card_activity(
    board_id: UUID,
    card_id: UUID,
    user: Reader,
    db: Database,
    response: Response,
    params: Annotated[CardActivityListRequest, Query()],
) -> CardActivityListResponse:
    board = read_board(db, user, board_id)
    item = card(db, board.id, card_id)
    response.headers["Cache-Control"] = "private, no-store"
    card_event = and_(
        AuditLog.entity_type == "board_cards",
        AuditLog.entity_id == item.id,
        or_(
            AuditLog.action != AuditAction.UPDATE,
            *(AuditLog.after.has_key(key) for key in _CARD_FIELDS),
        ),
    )
    label_event = and_(
        AuditLog.entity_type == "board_card_labels", _of_card(BoardCardLabel, item.id)
    )
    checklist_event = and_(
        AuditLog.entity_type == "board_card_checklist_items",
        _of_card(BoardCardChecklistItem, item.id),
        or_(
            AuditLog.action != AuditAction.UPDATE,
            AuditLog.after.has_key("text"),
            AuditLog.after.has_key("done"),
        ),
    )
    result = execute_standard_list(
        db,
        select(AuditLog).where(or_(card_event, label_event, checklist_event)),
        params,
        ACTIVITY_LIST_SPEC,
    )
    labels = _active_actor_labels(db, result.items)
    return CardActivityListResponse(
        items=[
            CardActivityResponse(
                id=row.id,
                created_at=row.created_at,
                kind=_KIND[row.entity_type],
                action=row.action,
                summary=_summary(row),
                actor_label=labels.get(row.performed_by) if row.performed_by else None,
            )
            for row in result.items
        ],
        pagination=result.pagination,
    )
