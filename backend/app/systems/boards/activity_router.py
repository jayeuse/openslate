"""Board-scoped activity summaries; mounted only with the complete Board surface."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_legacy_capability
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.boards.activity_schemas import (
    BoardActivityKind,
    BoardActivityListRequest,
    BoardActivityListResponse,
    BoardActivityResponse,
    BoardActivitySort,
)
from app.systems.boards.models import BoardGrant, BoardPermission, BoardRecordPlacement, BoardWidget
from app.systems.boards.router import _board_with_access
from app.systems.boards.widget_router import _visible_clause
from app.systems.manage.audit.models import AuditAction, AuditLog

router = APIRouter(prefix="/boards", tags=["boards"])
Reader = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_READ))]
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
    "board_grants": BoardActivityKind.GRANT,
    "board_widgets": BoardActivityKind.WIDGET,
    "board_record_placements": BoardActivityKind.PLACEMENT,
}
_SUMMARY = {
    BoardActivityKind.BOARD: {
        AuditAction.CREATE: "Board created",
        AuditAction.UPDATE: "Board updated",
        AuditAction.DELETE: "Board deleted",
    },
    BoardActivityKind.GRANT: {
        AuditAction.CREATE: "Board access changed",
        AuditAction.UPDATE: "Board access changed",
        AuditAction.DELETE: "Board access changed",
    },
    BoardActivityKind.WIDGET: {
        AuditAction.CREATE: "Board widget added",
        AuditAction.UPDATE: "Board widget updated",
        AuditAction.DELETE: "Board widget removed",
    },
    BoardActivityKind.PLACEMENT: {
        AuditAction.CREATE: "Board shortcut added",
        AuditAction.UPDATE: "Board shortcut updated",
        AuditAction.DELETE: "Board shortcut removed",
    },
}
_BOARD_METADATA_FIELDS = (
    "name", "description", "status", "default_section", "department_id",
    "is_deleted", "deleted_at",
)


def _snapshot_board_matches(board_id: UUID) -> ColumnElement[bool]:
    """Recover scope of physically removed grants/placements without returning snapshots."""
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
        .join(Role, Role.id == User.role_id)
        .where(
            User.id.in_(actor_ids),
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            Role.is_deleted.is_(False),
            Role.deleted_at.is_(None),
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
    board = _board_with_access(db, user, board_id, BoardPermission.VIEW)
    response.headers["Cache-Control"] = "private, no-store"

    # Widget edits also increment Board.revision. A revision-only Board audit
    # row would reveal hidden-widget timing and counts, so it is not activity.
    board_event = and_(
        AuditLog.entity_type == "boards",
        AuditLog.entity_id == board.id,
        or_(
            AuditLog.action != AuditAction.UPDATE,
            *(AuditLog.after.has_key(key) for key in _BOARD_METADATA_FIELDS),
        ),
    )
    grant_event = and_(
        AuditLog.entity_type == "board_grants",
        or_(
            exists(
                select(BoardGrant.id).where(
                    BoardGrant.id == AuditLog.entity_id,
                    BoardGrant.board_id == board.id,
                )
            ),
            _snapshot_board_matches(board.id),
        ),
    )
    placement_event = and_(
        AuditLog.entity_type == "board_record_placements",
        or_(
            exists(
                select(BoardRecordPlacement.id).where(
                    BoardRecordPlacement.id == AuditLog.entity_id,
                    BoardRecordPlacement.board_id == board.id,
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
                _visible_clause(user),
            )
        ),
    )
    result = execute_standard_list(
        db,
        select(AuditLog).where(or_(board_event, grant_event, widget_event, placement_event)),
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
