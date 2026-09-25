"""Exact-administrator CRUD routes for persisted Access policy rules."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from sqlalchemy import Select, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.policy.models import AccessRule
from app.systems.access.policy.rules_service import (
    create_rule,
    delete_rule,
    get_policy_version,
    get_rule,
    policy_revision_etag,
    update_rule,
)
from app.systems.access.policy.schemas import (
    AccessRuleCreate,
    AccessRuleListRequest,
    AccessRuleResponse,
    AccessRuleSortField,
    AccessRuleUpdate,
)
from app.systems.access.users.models import User, UserRole

router = APIRouter(prefix="/access/rules", tags=["access"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class AccessRuleListResponse(StandardListResponse[AccessRuleResponse]):
    pass


RULE_LIST_SPEC = ListQuerySpec(
    sort_fields={
        AccessRuleSortField.CREATED_AT: cast(ColumnElement[Any], AccessRule.created_at),
        AccessRuleSortField.UPDATED_AT: cast(ColumnElement[Any], AccessRule.updated_at),
        AccessRuleSortField.PERMISSION_ID: cast(ColumnElement[Any], AccessRule.permission_id),
    },
    default_sort=AccessRuleSortField.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], AccessRule.id),
    deleted_field=cast(ColumnElement[bool], AccessRule.is_deleted),
)
ETAG_HEADERS: dict[str, dict[str, Any]] = {"ETag": {"schema": {"type": "string"}}}
CONDITIONAL_RESPONSES: dict[int | str, dict[str, str]] = {
    412: {"description": "If-Match does not match the current policy revision"},
    428: {"description": "If-Match header is required"},
}
READ_FAILURE_RESPONSES: dict[int | str, dict[str, str]] = {
    404: {"description": "Rule not found"},
    503: {"description": "Database unavailable"},
}
WRITE_FAILURE_RESPONSES: dict[int | str, dict[str, str]] = {
    409: {"description": "Rule conflicts with an existing rule"},
    503: {"description": "Database unavailable"},
}


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def _exact_admin(db: Session, admin: User) -> None:
    require_fresh_exact_admin(db, admin.id)


def _filtered_statement(params: AccessRuleListRequest) -> Select[tuple[AccessRule]]:
    statement = select(AccessRule)
    filters: tuple[tuple[ColumnElement[Any], object | None], ...] = (
        (cast(ColumnElement[Any], AccessRule.subject_kind), params.subject_kind),
        (cast(ColumnElement[Any], AccessRule.subject_id), params.subject_id),
        (cast(ColumnElement[Any], AccessRule.scope_kind), params.scope_kind),
        (cast(ColumnElement[Any], AccessRule.scope_id), params.scope_id),
        (cast(ColumnElement[Any], AccessRule.permission_id), params.permission_id),
        (cast(ColumnElement[Any], AccessRule.decision), params.decision),
        (cast(ColumnElement[Any], AccessRule.locked), params.locked),
    )
    return statement.where(*(field == value for field, value in filters if value is not None))


@router.get(
    "",
    response_model=AccessRuleListResponse,
    responses={200: {"headers": ETAG_HEADERS}, **READ_FAILURE_RESPONSES},
    operation_id="list_access_rules",
)
def list_rules(
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    params: Annotated[AccessRuleListRequest, Query()],
) -> AccessRuleListResponse:
    _exact_admin(db, admin)
    version = get_policy_version(db, lock=True, shared=True)
    try:
        result = execute_standard_list(db, _filtered_statement(params), params, RULE_LIST_SPEC)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from error
    _private(response)
    response.headers["ETag"] = policy_revision_etag(version.revision)
    return AccessRuleListResponse.model_validate(
        {"items": result.items, "pagination": result.pagination},
        from_attributes=True,
    )


@router.get(
    "/{rule_id}",
    response_model=AccessRuleResponse,
    responses={200: {"headers": ETAG_HEADERS}, **READ_FAILURE_RESPONSES},
    operation_id="get_access_rule",
)
def get_rule_route(
    rule_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessRule:
    _exact_admin(db, admin)
    version = get_policy_version(db, lock=True, shared=True)
    row = get_rule(db, rule_id)
    _private(response)
    response.headers["ETag"] = policy_revision_etag(version.revision)
    return row


@router.post(
    "",
    response_model=AccessRuleResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        201: {"headers": {**ETAG_HEADERS, "Location": {"schema": {"type": "string"}}}},
        **WRITE_FAILURE_RESPONSES,
    },
    operation_id="create_access_rule",
)
def create_rule_route(
    payload: AccessRuleCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessRule:
    _exact_admin(db, admin)
    row = create_rule(db, payload, admin.id)
    _private(response)
    response.headers["ETag"] = policy_revision_etag(row.policy_version)
    response.headers["Location"] = f"/api/access/rules/{row.id}"
    return row


@router.patch(
    "/{rule_id}",
    response_model=AccessRuleResponse,
    responses={
        200: {"headers": ETAG_HEADERS},
        **READ_FAILURE_RESPONSES,
        **WRITE_FAILURE_RESPONSES,
        **CONDITIONAL_RESPONSES,
    },
    operation_id="update_access_rule",
)
def update_rule_route(
    rule_id: UUID,
    payload: AccessRuleUpdate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> AccessRule:
    _exact_admin(db, admin)
    row, revision = update_rule(db, rule_id, payload, if_match, admin.id)
    _private(response)
    response.headers["ETag"] = policy_revision_etag(revision)
    return row


@router.delete(
    "/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        204: {"headers": ETAG_HEADERS},
        **READ_FAILURE_RESPONSES,
        **WRITE_FAILURE_RESPONSES,
        **CONDITIONAL_RESPONSES,
    },
    operation_id="delete_access_rule",
)
def delete_rule_route(
    rule_id: UUID,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    if_match: Annotated[str | None, Header()] = None,
) -> Response:
    _exact_admin(db, admin)
    revision = delete_rule(db, rule_id, if_match, admin.id)
    return Response(
        status_code=status.HTTP_204_NO_CONTENT,
        headers={
            "Cache-Control": "private, no-store",
            "ETag": policy_revision_etag(revision),
        },
    )
