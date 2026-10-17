"""Board-scoped activity summaries of metadata, groups and tiles."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.membership import bound_membership_join
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.boards.activity_schemas import (
    BoardActivityKind,
    BoardActivityListRequest,
    BoardActivityListResponse,
    BoardActivityResponse,
    BoardActivitySort,
)
from app.systems.boards.models import BoardGroup, BoardWidget
from app.systems.boards.router import _board_with_access
from app.systems.manage.audit.models import AuditAction, AuditLog

router = APIRouter(prefix="/boards", tags=["boards"])
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]

ACTIVITY_LIST_SPEC = ListQuerySpec(
    sort_fields={
        BoardActivitySort.CREATED_AT: cast(ColumnElement[Any], AuditLog.created_at),
    },
    default_sort=BoardActivitySort.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], AuditLog.id),
    deleted_field=None,
)

_KIND = {
    "boards": BoardActivityKind.BOARD,
    "board_groups": BoardActivityKind.GROUP,
    "board_widgets": BoardActivityKind.WIDGET,
}
_SUMMARY = {
    BoardActivityKind.BOARD: {
        AuditAction.CREATE: "Board created",
        AuditAction.UPDATE: "Board updated",
        AuditAction.DELETE: "Board deleted",
    },
    BoardActivityKind.GROUP: {
        AuditAction.CREATE: "Board groups changed",
        AuditAction.UPDATE: "Board groups changed",
        AuditAction.DELETE: "Board groups changed",
    },
    BoardActivityKind.WIDGET: {
        AuditAction.CREATE: "Board widget added",
        AuditAction.UPDATE: "Board widget updated",
        AuditAction.DELETE: "Board widget removed",
    },
}
_BOARD_METADATA_FIELDS = (
    "name", "description", "status", "scope", "department_id", "is_deleted", "deleted_at",
)


def _snapshot_board_matches(board_id: UUID) -> ColumnElement[bool]:
    """Recover the Board of physically removed group rows without returning snapshots."""
    board_text = str(board_id)
    return or_(
        AuditLog.before["board_id"].astext == board_text,
        AuditLog.after["board_id"].astext == board_text,
    )


def _active_actor_labels(db: Session, rows: list[AuditLog]) -> dict[UUID, str]:
    actor_ids = {row.performed_by for row in rows if row.performed_by is not None}
    if not actor_ids:
        return {}
    actors = db.execute(
        select(User.id, User.username)
        .join(Membership, bound_membership_join())
        .where(
            User.id.in_(actor_ids),
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
        )
    ).all()
    return {actor_id: username for actor_id, username in actors}


@router.get("/{board_id}/activity", response_model=BoardActivityListResponse)
def list_board_activity(
    board_id: UUID,
    user: Reader,
    db: Database,
    response: Response,
    params: Annotated[BoardActivityListRequest, Query()],
) -> BoardActivityListResponse:
    """Return only allowlisted Board events visible to this viewer at read time."""
    board = _board_with_access(db, user, board_id, AccessLevel.READ)
    response.headers["Cache-Control"] = "private, no-store"

    # Content edits also increment Board.revision. A revision-only Board audit
    # row carries no metadata change, so it is not activity.
    board_event = and_(
        AuditLog.entity_type == "boards",
        AuditLog.entity_id == board.id,
        or_(
            AuditLog.action != AuditAction.UPDATE,
            *(AuditLog.after.has_key(key) for key in _BOARD_METADATA_FIELDS),
        ),
    )
    group_event = and_(
        AuditLog.entity_type == "board_groups",
        or_(
            exists(
                select(BoardGroup.id).where(
                    BoardGroup.id == AuditLog.entity_id,
                    BoardGroup.board_id == board.id,
                )
            ),
            _snapshot_board_matches(board.id),
        ),
    )
    widget_event = and_(
        AuditLog.entity_type == "board_widgets",
        exists(
            select(BoardWidget.id).where(
                BoardWidget.id == AuditLog.entity_id,
                BoardWidget.board_id == board.id,
                BoardWidget.is_deleted.is_(False),
                BoardWidget.deleted_at.is_(None),
            )
        ),
    )
    result = execute_standard_list(
        db,
        select(AuditLog).where(or_(board_event, group_event, widget_event)),
        params,
        ACTIVITY_LIST_SPEC,
    )
    labels = _active_actor_labels(db, result.items)
    items = [
        BoardActivityResponse(
            id=row.id,
            created_at=row.created_at,
            kind=_KIND[row.entity_type],
            action=row.action,
            summary=_SUMMARY[_KIND[row.entity_type]][row.action],
            actor_label=labels.get(row.performed_by) if row.performed_by else None,
        )
        for row in result.items
    ]
    return BoardActivityListResponse(items=items, pagination=result.pagination)
