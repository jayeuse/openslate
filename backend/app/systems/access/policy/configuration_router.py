"""Administrator routes for Access groups, their members and their access."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import Group
from app.systems.access.policy.schemas import (
    GroupAccessEntry,
    GroupAccessReplace,
    GroupCreate,
    GroupListRequest,
    GroupResponse,
    GroupSortField,
    GroupUpdate,
)
from app.systems.access.policy.service import (
    create_group,
    delete_group,
    get_group,
    group_access_map,
    group_etag,
    group_member_map,
    replace_group_access,
    update_group,
)
from app.systems.access.users.models import User

router = APIRouter(prefix="/access", tags=["access"])
AdminUser = Annotated[User, Depends(require_admin)]


class GroupListResponse(StandardListResponse[GroupResponse]):
    pass


GROUP_LIST_SPEC = ListQuerySpec(
    sort_fields={
        GroupSortField.NAME: cast(ColumnElement[Any], Group.name),
        GroupSortField.CREATED_AT: cast(ColumnElement[Any], Group.created_at),
        GroupSortField.UPDATED_AT: cast(ColumnElement[Any], Group.updated_at),
    },
    default_sort=GroupSortField.NAME,
    tie_breaker=cast(ColumnElement[Any], Group.id),
    search_fields=(
        cast(ColumnElement[str], Group.name),
        cast(ColumnElement[str], Group.description),
    ),
    deleted_field=cast(ColumnElement[bool], Group.is_deleted),
)
ETAG_HEADERS: dict[str, dict[str, Any]] = {"ETag": {"schema": {"type": "string"}}}
CONDITIONAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    412: {"description": "If-Match does not match the locked resource version"},
    428: {"description": "If-Match header is required"},
}


def _exact_admin(db: Session, admin: User) -> None:
    require_fresh_exact_admin(db, admin.id)


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _group_response(
    row: Group,
    member_ids: list[UUID],
    access: list[GroupAccessEntry],
) -> GroupResponse:
    return GroupResponse.model_validate(
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "revision": row.revision,
            "member_ids": member_ids,
            "access": access,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
            "deleted_at": row.deleted_at,
            "is_deleted": row.is_deleted,
            "performed_by": row.performed_by,
        }
    )


def _single_group_response(db: Session, row: Group) -> GroupResponse:
    return _group_response(
        row,
        group_member_map(db, (row.id,)).get(row.id, []),
        group_access_map(db, (row.id,)).get(row.id, []),
    )


@router.get("/groups", response_model=GroupListResponse)
def list_groups(
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    params: Annotated[GroupListRequest, Query()],
) -> GroupListResponse:
    _exact_admin(db, admin)
    _private(response)
    try:
        result = execute_standard_list(db, select(Group), params, GROUP_LIST_SPEC)
        ids = [row.id for row in result.items]
        member_map = group_member_map(db, ids)
        access_map = group_access_map(db, ids)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from error
    return GroupListResponse.model_validate(
        {
            "items": [
                _group_response(row, member_map.get(row.id, []), access_map.get(row.id, []))
                for row in result.items
            ],
            "pagination": result.pagination,
        }
    )


@router.get(
    "/groups/{group_id}",
    response_model=GroupResponse,
    responses={200: {"headers": ETAG_HEADERS}},
)
def get_group_route(
    group_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> GroupResponse:
    _exact_admin(db, admin)
    row = get_group(db, group_id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    return _single_group_response(db, row)


@router.post(
    "/groups",
    response_model=GroupResponse,
    status_code=status.HTTP_201_CREATED,
    responses={201: {"headers": {**ETAG_HEADERS, "Location": {"schema": {"type": "string"}}}}},
)
def create_group_route(
    payload: GroupCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> GroupResponse:
    _exact_admin(db, admin)
    row = create_group(db, payload, admin.id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    response.headers["Location"] = f"/api/access/groups/{row.id}"
    return _single_group_response(db, row)


@router.patch(
    "/groups/{group_id}",
    response_model=GroupResponse,
    responses={200: {"headers": ETAG_HEADERS}, **CONDITIONAL_RESPONSES},
)
def update_group_route(
    group_id: UUID,
    payload: GroupUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> GroupResponse:
    _exact_admin(db, admin)
    row = update_group(db, group_id, payload, if_match, admin.id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    return _single_group_response(db, row)


@router.put(
    "/groups/{group_id}/access",
    response_model=GroupResponse,
    responses={
        200: {"headers": ETAG_HEADERS},
        409: {"description": "A department is missing or a module is outside its department"},
        **CONDITIONAL_RESPONSES,
    },
)
def replace_group_access_route(
    group_id: UUID,
    payload: GroupAccessReplace,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> GroupResponse:
    """Replace every department and module level of the group."""

    _exact_admin(db, admin)
    row = replace_group_access(db, group_id, payload.access, if_match, admin.id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    return _single_group_response(db, row)


@router.delete(
    "/groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={409: {"description": "Group still has members"}, **CONDITIONAL_RESPONSES},
)
def delete_group_route(
    group_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    if_match: Annotated[str | None, Header()] = None,
) -> Response:
    _exact_admin(db, admin)
    delete_group(db, group_id, if_match, admin.id)
    return Response(
        status_code=status.HTTP_204_NO_CONTENT,
        headers={"Cache-Control": "private, no-store"},
    )
