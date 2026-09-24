"""Board-scoped grant management API."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, load_only
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_capability
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability
from app.systems.boards.access import can_access_board, can_read_board_grants
from app.systems.boards.grant_schemas import (
    BoardContentAudienceChoice,
    BoardContentAudienceKind,
    BoardContentAudienceListRequest,
    BoardContentAudienceListResponse,
    BoardContentAudienceSort,
    BoardGrantCreate,
    BoardGrantListRequest,
    BoardGrantListResponse,
    BoardGrantMutationResponse,
    BoardGrantResponse,
    BoardGrantRoleChoice,
    BoardGrantRoleListRequest,
    BoardGrantRoleListResponse,
    BoardGrantRoleSort,
    BoardGrantSort,
)
from app.systems.boards.models import (
    Board,
    BoardGrant,
    BoardPermission,
    BoardPrincipalType,
    BoardStatus,
)
from app.systems.sandbox.departments.models import Department


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(prefix="/boards", tags=["boards"], dependencies=[Depends(_private_cache)])
Reader = Annotated[User, Depends(require_capability(Capability.RECORDS_READ))]
Writer = Annotated[User, Depends(require_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]

GRANT_LIST_SPEC = ListQuerySpec(
    sort_fields={
        BoardGrantSort.PRINCIPAL_TYPE: cast(ColumnElement[Any], BoardGrant.principal_type),
        BoardGrantSort.PERMISSION: cast(ColumnElement[Any], BoardGrant.permission),
        BoardGrantSort.EFFECT: cast(ColumnElement[Any], BoardGrant.effect),
        BoardGrantSort.CREATED_AT: cast(ColumnElement[Any], BoardGrant.created_at),
    },
    default_sort=BoardGrantSort.PRINCIPAL_TYPE,
    tie_breaker=cast(ColumnElement[Any], BoardGrant.id),
    deleted_field=None,
)
GRANT_ROLE_LIST_SPEC = ListQuerySpec(
    sort_fields={BoardGrantRoleSort.ROLE: cast(ColumnElement[Any], Role.role)},
    default_sort=BoardGrantRoleSort.ROLE,
    tie_breaker=cast(ColumnElement[Any], Role.id),
    search_fields=(cast(ColumnElement[str], Role.role),),
    deleted_field=None,
)
AUDIENCE_USER_SPEC = ListQuerySpec(
    sort_fields={BoardContentAudienceSort.LABEL: cast(ColumnElement[Any], User.username)},
    default_sort=BoardContentAudienceSort.LABEL,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], User.username),),
    deleted_field=None,
)
AUDIENCE_ROLE_SPEC = ListQuerySpec(
    sort_fields={BoardContentAudienceSort.LABEL: cast(ColumnElement[Any], Role.role)},
    default_sort=BoardContentAudienceSort.LABEL,
    tie_breaker=cast(ColumnElement[Any], Role.id),
    search_fields=(cast(ColumnElement[str], Role.role),),
    deleted_field=None,
)
AUDIENCE_DEPARTMENT_SPEC = ListQuerySpec(
    sort_fields={
        BoardContentAudienceSort.LABEL: cast(ColumnElement[Any], Department.department_name)
    },
    default_sort=BoardContentAudienceSort.LABEL,
    tie_breaker=cast(ColumnElement[Any], Department.id),
    search_fields=(cast(ColumnElement[str], Department.department_name),),
    deleted_field=None,
)


def _not_found(message: str = "Board not found") -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=message)


def _conflict(code: str, message: str, **extra: int) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": code, "message": message, **extra},
    )


def _stale_revision(current_revision: int) -> HTTPException:
    return _conflict(
        "stale_revision",
        "Board changed; reload before saving",
        current_revision=current_revision,
    )


def _active_grants(db: Session, board_id: UUID) -> list[BoardGrant]:
    return list(
        db.scalars(
            select(BoardGrant).where(
                BoardGrant.board_id == board_id,
                BoardGrant.is_deleted.is_(False),
                BoardGrant.deleted_at.is_(None),
            )
        ).all()
    )


def _grant_responses(db: Session, grants: list[BoardGrant]) -> list[BoardGrantResponse]:
    """Resolve only current principal display labels in two bounded page lookups."""

    user_ids = {grant.principal_user_id for grant in grants if grant.principal_user_id is not None}
    role_ids = {grant.principal_role_id for grant in grants if grant.principal_role_id is not None}
    user_labels: dict[UUID, str] = {}
    role_labels: dict[UUID, str] = {}
    if user_ids:
        user_labels = {
            user_id: username
            for user_id, username in db.execute(
                select(User.id, User.username)
                .join(Role, User.role_id == Role.id)
                .where(
                    User.id.in_(user_ids),
                    User.status == UserStatus.ACTIVE.value,
                    User.is_deleted.is_(False),
                    User.deleted_at.is_(None),
                    established_user_clause(),
                    Role.is_deleted.is_(False),
                    Role.deleted_at.is_(None),
                )
            ).all()
        }
    if role_ids:
        role_labels = {
            role_id: role_name
            for role_id, role_name in db.execute(
                select(Role.id, Role.role).where(
                    Role.id.in_(role_ids),
                    Role.is_deleted.is_(False),
                    Role.deleted_at.is_(None),
                )
            ).all()
        }

    responses = []
    for grant in grants:
        if grant.principal_type == BoardPrincipalType.EVERYONE.value:
            label, available = "Everyone", True
        elif grant.principal_type == BoardPrincipalType.USER.value:
            name = user_labels.get(grant.principal_user_id) if grant.principal_user_id else None
            label, available = (name, True) if name else ("Unavailable user", False)
        else:
            name = role_labels.get(grant.principal_role_id) if grant.principal_role_id else None
            label, available = (name, True) if name else ("Unavailable role", False)
        responses.append(
            BoardGrantResponse(
                id=grant.id,
                principal_type=grant.principal_type,
                principal_user_id=grant.principal_user_id,
                principal_role_id=grant.principal_role_id,
                principal_label=label,
                principal_available=available,
                permission=grant.permission,
                effect=grant.effect,
                created_at=grant.created_at,
                updated_at=grant.updated_at,
            )
        )
    return responses


def _accessible_board(
    db: Session,
    actor: User,
    board_id: UUID,
    *,
    mutation: bool,
    lock: bool = True,
) -> tuple[Board, list[BoardGrant]]:
    statement = select(Board).where(
        Board.id == board_id,
        Board.is_deleted.is_(False),
        Board.deleted_at.is_(None),
    )
    if mutation and lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    board = db.scalar(statement)
    if board is None:
        raise _not_found()

    grants = _active_grants(db, board.id)
    authorized = (
        can_access_board(board, actor, BoardPermission.MANAGE, grants)
        if mutation
        else can_read_board_grants(board, actor, grants)
    )
    if not authorized:
        raise _not_found()
    return board, grants


@router.get("/{board_id}/grant-roles", response_model=BoardGrantRoleListResponse)
def list_board_grant_roles(
    board_id: UUID,
    user: Writer,
    db: Database,
    params: Annotated[BoardGrantRoleListRequest, Query()],
) -> BoardGrantRoleListResponse:
    """Expose only active role choices to actors able to change this Board's grants."""

    board, _ = _accessible_board(db, user, board_id, mutation=True, lock=False)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "Restore the Board before changing grants")
    statement = (
        select(Role)
        .options(load_only(Role.id, Role.role))
        .where(
            Role.is_deleted.is_(False),
            Role.deleted_at.is_(None),
        )
    )
    result = execute_standard_list(db, statement, params, GRANT_ROLE_LIST_SPEC)
    return BoardGrantRoleListResponse(
        items=[BoardGrantRoleChoice(id=role.id, role=role.role) for role in result.items],
        pagination=result.pagination,
    )


@router.get(
    "/{board_id}/content-audience-targets", response_model=BoardContentAudienceListResponse
)
def list_board_content_audience_targets(
    board_id: UUID,
    user: Writer,
    db: Database,
    params: Annotated[BoardContentAudienceListRequest, Query()],
) -> BoardContentAudienceListResponse:
    """Expose minimal active targeting choices to editors, without grant-management access."""

    board = db.scalar(
        select(Board).where(
            Board.id == board_id,
            Board.is_deleted.is_(False),
            Board.deleted_at.is_(None),
        )
    )
    if board is None or not can_access_board(
        board, user, BoardPermission.EDIT, _active_grants(db, board_id)
    ):
        raise _not_found()
    if board.status != BoardStatus.ACTIVE:
        raise _conflict("board_archived", "Restore the Board before editing content")

    if params.kind is BoardContentAudienceKind.USER:
        user_result = execute_standard_list(
            db,
            select(User)
            .join(Role, Role.id == User.role_id)
            .options(load_only(User.id, User.username))
            .where(
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                established_user_clause(),
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            ),
            params,
            AUDIENCE_USER_SPEC,
        )
        return BoardContentAudienceListResponse(
            items=[
                BoardContentAudienceChoice(id=item.id, label=item.username)
                for item in user_result.items
            ],
            pagination=user_result.pagination,
        )
    if params.kind is BoardContentAudienceKind.ROLE:
        role_result = execute_standard_list(
            db,
            select(Role).options(load_only(Role.id, Role.role)).where(
                Role.is_deleted.is_(False), Role.deleted_at.is_(None)
            ),
            params,
            AUDIENCE_ROLE_SPEC,
        )
        return BoardContentAudienceListResponse(
            items=[
                BoardContentAudienceChoice(id=item.id, label=item.role)
                for item in role_result.items
            ],
            pagination=role_result.pagination,
        )
    department_result = execute_standard_list(
        db,
        select(Department)
        .options(load_only(Department.id, Department.department_name))
        .where(Department.is_deleted.is_(False), Department.deleted_at.is_(None)),
        params,
        AUDIENCE_DEPARTMENT_SPEC,
    )
    return BoardContentAudienceListResponse(
        items=[
            BoardContentAudienceChoice(id=item.id, label=item.department_name)
            for item in department_result.items
        ],
        pagination=department_result.pagination,
    )


def _validate_grantee(db: Session, payload: BoardGrantCreate) -> None:
    if payload.principal_type is BoardPrincipalType.USER:
        user = db.scalar(
            select(User)
            .where(
                User.id == payload.principal_user_id,
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                established_user_clause(),
            )
            .with_for_update()
        )
        if user is None:
            raise _conflict("grantee_unavailable", "The selected grantee is unavailable")
        role_id = db.scalar(
            select(Role.id)
            .where(
                Role.id == user.role_id,
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            )
            .with_for_update()
        )
        if role_id is None:
            raise _conflict("grantee_unavailable", "The selected grantee is unavailable")
    elif payload.principal_type is BoardPrincipalType.ROLE:
        role_id = db.scalar(
            select(Role.id)
            .where(
                Role.id == payload.principal_role_id,
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            )
            .with_for_update()
        )
        if role_id is None:
            raise _conflict("grantee_unavailable", "The selected grantee is unavailable")


def _duplicate_decision(grants: list[BoardGrant], payload: BoardGrantCreate) -> bool:
    return any(
        grant.principal_type == payload.principal_type.value
        and grant.principal_user_id == payload.principal_user_id
        and grant.principal_role_id == payload.principal_role_id
        and grant.permission == payload.permission.value
        and grant.effect == payload.effect.value
        for grant in grants
    )


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise _conflict("grant_invalid", "Unable to save Board grant") from error


@router.get("/{board_id}/grants", response_model=BoardGrantListResponse)
def list_board_grants(
    board_id: UUID,
    user: Reader,
    db: Database,
    params: Annotated[BoardGrantListRequest, Query()],
) -> BoardGrantListResponse:
    board, _ = _accessible_board(db, user, board_id, mutation=False)
    statement = select(BoardGrant).where(
        BoardGrant.board_id == board.id,
        BoardGrant.is_deleted.is_(False),
        BoardGrant.deleted_at.is_(None),
    )
    result = execute_standard_list(db, statement, params, GRANT_LIST_SPEC)
    return BoardGrantListResponse(
        items=_grant_responses(db, result.items),
        pagination=result.pagination,
        board_revision=board.revision,
    )


@router.post(
    "/{board_id}/grants",
    response_model=BoardGrantMutationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_board_grant(
    board_id: UUID,
    payload: BoardGrantCreate,
    user: Writer,
    db: Database,
    response: Response,
) -> BoardGrantMutationResponse:
    board, grants = _accessible_board(db, user, board_id, mutation=True)
    if board.revision != payload.revision:
        raise _stale_revision(board.revision)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "Restore the Board before changing grants")
    _validate_grantee(db, payload)
    if _duplicate_decision(grants, payload):
        raise _conflict("grant_exists", "This Board grant already exists")

    grant = BoardGrant(
        board_id=board.id,
        principal_type=payload.principal_type.value,
        principal_user_id=payload.principal_user_id,
        principal_role_id=payload.principal_role_id,
        permission=payload.permission.value,
        effect=payload.effect.value,
    )
    db.add(grant)
    board.revision += 1
    _commit(db)
    db.refresh(grant)
    response.headers["Location"] = f"/api/boards/{board.id}/grants/{grant.id}"
    return BoardGrantMutationResponse(
        grant=_grant_responses(db, [grant])[0],
        board_revision=board.revision,
    )


@router.delete(
    "/{board_id}/grants/{grant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def revoke_board_grant(
    board_id: UUID,
    grant_id: UUID,
    revision: Annotated[int, Query(ge=1)],
    user: Writer,
    db: Database,
    response: Response,
) -> Response:
    board, _ = _accessible_board(db, user, board_id, mutation=True)
    if board.revision != revision:
        raise _stale_revision(board.revision)
    if board.status == BoardStatus.ARCHIVED:
        raise _conflict("board_archived", "Restore the Board before changing grants")

    grant = db.scalar(
        select(BoardGrant)
        .where(
            BoardGrant.id == grant_id,
            BoardGrant.board_id == board.id,
            BoardGrant.is_deleted.is_(False),
            BoardGrant.deleted_at.is_(None),
        )
        .with_for_update()
    )
    if grant is None:
        raise _not_found("Board grant not found")
    grant.is_deleted = True
    grant.deleted_at = utc_now()
    board.revision += 1
    _commit(db)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
