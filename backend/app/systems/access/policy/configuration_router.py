"""Unregistered administrator routes for Access groups and defaults."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessGroup, AccessPolicyDefaults
from app.systems.access.policy.schemas import (
    AccessDefaultsResponse,
    AccessDefaultsUpdate,
    AccessGroupCreate,
    AccessGroupListRequest,
    AccessGroupResponse,
    AccessGroupSortField,
    AccessGroupUpdate,
)
from app.systems.access.policy.service import (
    create_group,
    default_link_ids,
    defaults_etag,
    delete_group,
    get_defaults,
    get_group,
    group_etag,
    group_member_ids,
    group_member_map,
    update_defaults,
    update_group,
)
from app.systems.access.users.models import User, UserRole

router = APIRouter(prefix="/access", tags=["access"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class AccessGroupListResponse(StandardListResponse[AccessGroupResponse]):
    pass


GROUP_LIST_SPEC = ListQuerySpec(
    sort_fields={
        AccessGroupSortField.NAME: cast(ColumnElement[Any], AccessGroup.name),
        AccessGroupSortField.CREATED_AT: cast(ColumnElement[Any], AccessGroup.created_at),
        AccessGroupSortField.UPDATED_AT: cast(ColumnElement[Any], AccessGroup.updated_at),
    },
    default_sort=AccessGroupSortField.NAME,
    tie_breaker=cast(ColumnElement[Any], AccessGroup.id),
    search_fields=(
        cast(ColumnElement[str], AccessGroup.name),
        cast(ColumnElement[str], AccessGroup.description),
    ),
    deleted_field=cast(ColumnElement[bool], AccessGroup.is_deleted),
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
    db: Session,
    row: AccessGroup,
    member_ids: list[UUID] | None = None,
) -> AccessGroupResponse:
    return AccessGroupResponse.model_validate(
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "revision": row.revision,
            "member_ids": group_member_ids(db, row.id) if member_ids is None else member_ids,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
            "deleted_at": row.deleted_at,
            "is_deleted": row.is_deleted,
            "performed_by": row.performed_by,
        }
    )


def _defaults_response(db: Session, row: AccessPolicyDefaults) -> AccessDefaultsResponse:
    group_ids, department_ids = default_link_ids(db, row.id)
    return AccessDefaultsResponse.model_validate(
        {
            field: getattr(row, field)
            for field in AccessDefaultsResponse.model_fields
            if field not in {"group_ids", "department_ids"}
        }
        | {"group_ids": group_ids, "department_ids": department_ids}
    )


@router.get("/groups", response_model=AccessGroupListResponse)
def list_groups(
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    params: Annotated[AccessGroupListRequest, Query()],
) -> AccessGroupListResponse:
    _exact_admin(db, admin)
    _private(response)
    try:
        result = execute_standard_list(db, select(AccessGroup), params, GROUP_LIST_SPEC)
        member_map = group_member_map(db, (row.id for row in result.items))
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from error
    return AccessGroupListResponse.model_validate(
        {
            "items": [_group_response(db, row, member_map.get(row.id, [])) for row in result.items],
            "pagination": result.pagination,
        }
    )


@router.get(
    "/groups/{group_id}",
    response_model=AccessGroupResponse,
    responses={200: {"headers": ETAG_HEADERS}},
)
def get_group_route(
    group_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessGroupResponse:
    _exact_admin(db, admin)
    row = get_group(db, group_id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    return _group_response(db, row)


@router.post(
    "/groups",
    response_model=AccessGroupResponse,
    status_code=status.HTTP_201_CREATED,
    responses={201: {"headers": {**ETAG_HEADERS, "Location": {"schema": {"type": "string"}}}}},
)
def create_group_route(
    payload: AccessGroupCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessGroupResponse:
    _exact_admin(db, admin)
    row = create_group(db, payload, admin.id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    response.headers["Location"] = f"/api/access/groups/{row.id}"
    return _group_response(db, row)


@router.patch(
    "/groups/{group_id}",
    response_model=AccessGroupResponse,
    responses={200: {"headers": ETAG_HEADERS}, **CONDITIONAL_RESPONSES},
)
def update_group_route(
    group_id: UUID,
    payload: AccessGroupUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> AccessGroupResponse:
    _exact_admin(db, admin)
    row = update_group(db, group_id, payload, if_match, admin.id)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    return _group_response(db, row)


@router.delete(
    "/groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        409: {"description": "Group still has members, default references, or access rules"},
        **CONDITIONAL_RESPONSES,
    },
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


@router.get(
    "/defaults",
    response_model=AccessDefaultsResponse,
    responses={200: {"headers": ETAG_HEADERS}},
)
def get_defaults_route(
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessDefaultsResponse:
    _exact_admin(db, admin)
    row = get_defaults(db)
    _private(response)
    response.headers["ETag"] = defaults_etag(row)
    return _defaults_response(db, row)


@router.patch(
    "/defaults",
    response_model=AccessDefaultsResponse,
    responses={200: {"headers": ETAG_HEADERS}, **CONDITIONAL_RESPONSES},
)
def update_defaults_route(
    payload: AccessDefaultsUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> AccessDefaultsResponse:
    _exact_admin(db, admin)
    row = update_defaults(db, payload, if_match, admin.id)
    _private(response)
    response.headers["ETag"] = defaults_etag(row)
    return _defaults_response(db, row)
