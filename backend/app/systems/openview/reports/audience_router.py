"""Private, least-privilege target choices for Report audience editing."""

from enum import StrEnum
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, load_only
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_legacy_capability
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database import get_db
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability, has_capability

router = APIRouter(tags=["reports"])
Writer = Annotated[User, Depends(require_legacy_capability(Capability.RECORDS_WRITE))]
Database = Annotated[Session, Depends(get_db)]


class RoleChoice(BaseModel):
    id: UUID
    role: str


class UserChoice(BaseModel):
    id: UUID
    username: str


class RoleSort(StrEnum):
    ROLE = "role"


class UserSort(StrEnum):
    USERNAME = "username"


class RoleChoiceRequest(StandardListRequest[RoleSort]):
    id: UUID | None = None


class UserChoiceRequest(StandardListRequest[UserSort]):
    id: UUID | None = None


ROLE_LIST_SPEC = ListQuerySpec(
    sort_fields={RoleSort.ROLE: cast(ColumnElement[Any], Role.role)},
    default_sort=RoleSort.ROLE,
    tie_breaker=cast(ColumnElement[Any], Role.id),
    search_fields=(cast(ColumnElement[str], Role.role),),
    deleted_field=None,
)
USER_LIST_SPEC = ListQuerySpec(
    sort_fields={UserSort.USERNAME: cast(ColumnElement[Any], User.username)},
    default_sort=UserSort.USERNAME,
    tie_breaker=cast(ColumnElement[Any], User.id),
    search_fields=(cast(ColumnElement[str], User.username),),
    deleted_field=None,
)


def _eligible_role_ids(db: Session, selected_id: UUID | None = None) -> list[UUID]:
    """Use the exact fail-closed capability evaluator, including literal admin."""
    statement = (
        select(Role)
        .options(load_only(Role.id, Role.role, Role.permissions))
        .where(Role.is_deleted.is_(False), Role.deleted_at.is_(None))
        .execution_options(populate_existing=True)
    )
    if selected_id is not None:
        statement = statement.where(Role.id == selected_id)
    return [
        role.id for role in db.scalars(statement) if has_capability(role, Capability.RECORDS_READ)
    ]


@router.get("/audience-roles", response_model=StandardListResponse[RoleChoice])
def list_report_audience_roles(
    _editor: Writer,
    db: Database,
    params: Annotated[RoleChoiceRequest, Query()],
) -> StandardListResponse[RoleChoice]:
    eligible_ids = _eligible_role_ids(db, params.id)
    statement = select(Role).options(load_only(Role.id, Role.role)).where(
        Role.id.in_(eligible_ids), Role.is_deleted.is_(False), Role.deleted_at.is_(None)
    )
    result = execute_standard_list(db, statement, params, ROLE_LIST_SPEC)
    return StandardListResponse(
        items=[RoleChoice(id=role.id, role=role.role) for role in result.items],
        pagination=result.pagination,
    )


@router.get("/audience-users", response_model=StandardListResponse[UserChoice])
def list_report_audience_users(
    _editor: Writer,
    db: Database,
    params: Annotated[UserChoiceRequest, Query()],
) -> StandardListResponse[UserChoice]:
    eligible_ids = _eligible_role_ids(db)
    statement = (
        select(User)
        .options(load_only(User.id, User.username))
        .join(Role, User.role_id == Role.id)
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
            Role.id.in_(eligible_ids),
            Role.is_deleted.is_(False),
            Role.deleted_at.is_(None),
        )
    )
    if params.id is not None:
        statement = statement.where(User.id == params.id)
    result = execute_standard_list(db, statement, params, USER_LIST_SPEC)
    return StandardListResponse(
        items=[UserChoice(id=user.id, username=user.username) for user in result.items],
        pagination=result.pagination,
    )
