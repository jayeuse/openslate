"""Routes for Access groups, their members and their access.

Administrators manage every group. A manager of every department that a group
reaches may read that group and replace its members (see ``scope.manages_all``).
"""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import func, select, true
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user, require_admin, require_fresh_exact_admin
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.checks import forbidden
from app.systems.access.policy.delegation import replace_members
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.policy.schemas import (
    GroupAccessReplace,
    GroupAccessResponse,
    GroupCreate,
    GroupListRequest,
    GroupMembersReplace,
    GroupResponse,
    GroupSortField,
    GroupUpdate,
    MemberCandidateListRequest,
    MemberCandidateResponse,
    MemberCandidateSortField,
)
from app.systems.access.policy.scope import (
    effective_levels,
    group_reach,
    manageable_group_clause,
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
from app.systems.access.users.membership import (
    bound_organization,
    require_current_membership,
)
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module

router = APIRouter(prefix="/access", tags=["access"])
AdminUser = Annotated[User, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]


class GroupListResponse(StandardListResponse[GroupResponse]):
    pass


class MemberCandidateListResponse(StandardListResponse[MemberCandidateResponse]):
    pass


_MEMBER_COUNT = (
    select(func.count(GroupMember.id))
    .where(GroupMember.group_id == Group.id)
    .correlate(Group)
    .scalar_subquery()
)
_ACCESS_NAMES = (
    select(func.string_agg(func.concat(Department.department_name, " ", Module.module_name), " "))
    .select_from(GroupAccess)
    .join(Department, Department.id == GroupAccess.department_id)
    .outerjoin(Module, Module.id == GroupAccess.module_id)
    .where(GroupAccess.group_id == Group.id, GroupAccess.is_deleted.is_(False))
    .correlate(Group)
    .scalar_subquery()
)
GROUP_LIST_SPEC = ListQuerySpec(
    sort_fields={
        GroupSortField.NAME: cast(ColumnElement[Any], Group.name),
        GroupSortField.MEMBER_COUNT: _MEMBER_COUNT,
        GroupSortField.CREATED_AT: cast(ColumnElement[Any], Group.created_at),
        GroupSortField.UPDATED_AT: cast(ColumnElement[Any], Group.updated_at),
    },
    default_sort=GroupSortField.NAME,
    tie_breaker=cast(ColumnElement[Any], Group.id),
    search_fields=(
        cast(ColumnElement[str], Group.name),
        cast(ColumnElement[str], Group.description),
        cast(ColumnElement[str], _ACCESS_NAMES),
    ),
    deleted_field=cast(ColumnElement[bool], Group.is_deleted),
)
MEMBER_CANDIDATE_LIST_SPEC = ListQuerySpec(
    sort_fields={
        MemberCandidateSortField.USERNAME: cast(ColumnElement[Any], User.username),
        MemberCandidateSortField.EMAIL: cast(ColumnElement[Any], User.email),
        MemberCandidateSortField.DISPLAY_NAME: cast(ColumnElement[Any], User.display_name),
    },
    default_sort=MemberCandidateSortField.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(
        cast(ColumnElement[str], User.username),
        cast(ColumnElement[str], User.email),
        cast(ColumnElement[str], User.display_name),
    ),
    deleted_field=cast(ColumnElement[bool], User.is_deleted),
)
ETAG_HEADERS: dict[str, dict[str, Any]] = {"ETag": {"schema": {"type": "string"}}}
CONDITIONAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    412: {"description": "If-Match does not match the locked resource version"},
    428: {"description": "If-Match header is required"},
}


def _exact_admin(db: Session, admin: User) -> None:
    from app.systems.comms.realtime.grants import lock_projection

    lock_projection(db)
    require_fresh_exact_admin(db, admin.id)


def _database_unavailable(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Database unavailable",
    )


def _visible_groups(db: Session, user: User) -> ColumnElement[bool]:
    """Every group for an administrator; the groups a manager may change; else 403."""

    if require_current_membership(db, user).role == UserRole.ADMIN.value:
        _exact_admin(db, user)
        return true()
    try:
        access = effective_levels(db, user)
    except SQLAlchemyError as error:
        raise _database_unavailable(db) from error
    if not access.managed_department_ids():
        raise forbidden()
    return manageable_group_clause(access)


def _visible_group(db: Session, user: User, group_id: UUID) -> Group:
    """One group; 404 for a manager who may not change it, as for a missing group."""

    if require_current_membership(db, user).role == UserRole.ADMIN.value:
        _exact_admin(db, user)
        return get_group(db, group_id)
    try:
        access = effective_levels(db, user)
    except SQLAlchemyError as error:
        raise _database_unavailable(db) from error
    if not access.managed_department_ids():
        raise forbidden()
    row = get_group(db, group_id)
    try:
        allowed = access.manages_all(group_reach(db, row.id))
    except SQLAlchemyError as error:
        raise _database_unavailable(db) from error
    if not allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return row


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _group_response(
    row: Group,
    member_ids: list[UUID],
    access: list[GroupAccessResponse],
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
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    params: Annotated[GroupListRequest, Query()],
) -> GroupListResponse:
    visible = _visible_groups(db, user)
    _private(response)
    try:
        statement = select(Group).where(visible)
        if params.member_id is not None:
            statement = statement.where(
                select(GroupMember.id)
                .where(GroupMember.group_id == Group.id, GroupMember.user_id == params.member_id)
                .exists()
            )
        if params.without_access:
            statement = statement.where(
                ~select(GroupAccess.id)
                .where(GroupAccess.group_id == Group.id, GroupAccess.is_deleted.is_(False))
                .exists()
            )
        if params.without_members:
            statement = statement.where(_MEMBER_COUNT == 0)
        result = execute_standard_list(db, statement, params, GROUP_LIST_SPEC)
        ids = [row.id for row in result.items]
        member_map = group_member_map(db, ids)
        access_map = group_access_map(db, ids)
    except SQLAlchemyError as error:
        raise _database_unavailable(db) from error
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
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> GroupResponse:
    row = _visible_group(db, user, group_id)
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
    "/groups/{group_id}/members",
    response_model=GroupResponse,
    responses={
        200: {"headers": ETAG_HEADERS},
        403: {"description": "Not an administrator or a manager of every department it reaches"},
        409: {"description": "A new member is an administrator, or not an active or pending user"},
        **CONDITIONAL_RESPONSES,
    },
)
def replace_group_members_route(
    group_id: UUID,
    payload: GroupMembersReplace,
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> GroupResponse:
    """Replace every member of the group."""

    row = replace_members(db, group_id, payload.member_ids, if_match, user)
    _private(response)
    response.headers["ETag"] = group_etag(row)
    return _single_group_response(db, row)


@router.get("/member-candidates", response_model=MemberCandidateListResponse)
def list_member_candidates(
    user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    params: Annotated[MemberCandidateListRequest, Query()],
) -> MemberCandidateListResponse:
    """Non-administrator accounts that a group member can be chosen from."""

    visible = _visible_groups(db, user)
    _private(response)
    try:
        if (
            require_current_membership(db, user).role != UserRole.ADMIN.value
            and db.scalar(select(Group.id).where(Group.is_deleted.is_(False), visible).limit(1))
            is None
        ):
            raise forbidden()
        statement = (
            select(User)
            .join(Membership, Membership.user_id == User.id)
            .where(
                Membership.role != UserRole.ADMIN.value,
                Membership.org_id == bound_organization(db),
            )
        )
        if params.ids is not None:
            statement = statement.where(User.id.in_(params.ids))
        result = execute_standard_list(
            db,
            statement,
            params,
            MEMBER_CANDIDATE_LIST_SPEC,
        )
        memberships = {
            member.user_id: member
            for member in db.scalars(
                select(Membership).where(
                    Membership.org_id == bound_organization(db),
                    Membership.user_id.in_([item.id for item in result.items]),
                )
            )
        }
    except SQLAlchemyError as error:
        raise _database_unavailable(db) from error
    return MemberCandidateListResponse.model_validate(
        {
            "items": [
                {
                    **{
                        key: getattr(item, key)
                        for key in ("id", "display_name", "username", "email", "status")
                    },
                    "role": memberships[item.id].role,
                    "expires_at": memberships[item.id].expires_at,
                }
                for item in result.items
            ],
            "pagination": result.pagination,
        },
        from_attributes=True,
    )


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
