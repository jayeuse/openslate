"""Server-side predicates and bounded projections for the existing People list."""

from datetime import datetime, timedelta
from enum import StrEnum
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import Select, and_, case, func, or_, select, tuple_
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing import (
    DeletedFilter,
    ListQuerySpec,
    StandardListRequest,
    execute_standard_list,
)
from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.access.users.schemas import (
    DirectoryRowResponse,
    UserListResponse,
    UserResponse,
    UserSummaryResponse,
)
from app.systems.manage.workspace.security_policy import (
    load_platform_policy,
    session_expiry_expression,
)
from app.systems.sandbox.departments.models import Department


class UserSortField(StrEnum):
    EMAIL = "email"
    USERNAME = "username"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"
    NAME = "name"
    EXPIRES_AT = "expires_at"


def _integer_days(value: Any) -> Any:
    if isinstance(value, bool) or (
        isinstance(value, str) and not (value.isascii() and value.isdecimal())
    ):
        raise ValueError("inactive_days must be an integer")
    return value


InactiveDays = Annotated[int, BeforeValidator(_integer_days), Field(ge=1, le=3650)]


class UserSummaryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inactive_days: InactiveDays = 30


class UserListRequest(StandardListRequest[UserSortField]):
    ids: list[UUID] | None = Field(default=None, max_length=100)
    role: UserRole | None = None
    group_id: UUID | Literal["none"] | None = None
    department_id: UUID | None = None
    status: Literal["pending", "active", "disabled", "expired", "ending"] | None = None
    mfa: Literal["without", "unknown"] | None = None
    history: Literal["no-recorded-sign-in", "inactive"] | None = None
    inactive_days: InactiveDays = 30


_NAME = func.lower(func.coalesce(func.nullif(func.trim(User.display_name), ""), User.username))
_SORT_FIELDS = {
    UserSortField.EMAIL: cast(ColumnElement[Any], User.email),
    UserSortField.USERNAME: cast(ColumnElement[Any], User.username),
    UserSortField.CREATED_AT: cast(ColumnElement[Any], User.created_at),
    UserSortField.UPDATED_AT: cast(ColumnElement[Any], User.updated_at),
    UserSortField.NAME: _NAME,
    UserSortField.EXPIRES_AT: cast(ColumnElement[Any], Membership.expires_at),
}


def _active_account(now: datetime) -> ColumnElement[bool]:
    return and_(
        User.status == "active", Membership.status == "active",
        identity_eligible_clause(now=now), established_user_clause()
    )


def _known_observation() -> ColumnElement[bool]:
    return and_(
        IdentityMfaObservation.user_id == User.id,
        IdentityMfaObservation.observed_provider_user_id == User.supabase_user_id,
        IdentityMfaObservation.observed_at.is_not(None),
    )


def _mfa_predicate(kind: str, now: datetime) -> ColumnElement[bool]:
    known = (
        select(1)
        .where(_known_observation(), IdentityMfaObservation.verified_totp.is_not(None))
        .exists()
    )
    evidence = (
        select(1)
        .where(_known_observation(), IdentityMfaObservation.verified_totp.is_(False))
        .exists()
        if kind == "without"
        else ~known
    )
    return and_(Membership.role == "admin", _active_account(now), evidence)


def _history_predicate(kind: str, now: datetime, inactive_days: int) -> ColumnElement[bool]:
    evidence = select(1).where(IdentityMfaObservation.user_id == User.id)
    condition = (
        ~evidence.where(IdentityMfaObservation.last_sign_in_at.is_not(None)).exists()
        if kind == "no-recorded-sign-in"
        else evidence.where(
            IdentityMfaObservation.last_active_at < now - timedelta(days=inactive_days)
        ).exists()
    )
    return and_(_active_account(now), condition)


def _filtered_users(params: UserListRequest, now: datetime, org_id: UUID) -> Select[tuple[User]]:
    statement = select(User).join(Membership, Membership.user_id == User.id).where(
        Membership.org_id == org_id
    )
    if params.ids is not None:
        statement = statement.where(User.id.in_(params.ids))
    if params.role is not None:
        statement = statement.where(Membership.role == params.role.value)
    if params.status is not None:
        if params.status == "expired":
            condition = Membership.expires_at <= now
        elif params.status == "ending":
            condition = and_(
                User.status.in_(("active", "pending")),
                Membership.expires_at > now,
                Membership.expires_at <= now + timedelta(days=14),
            )
        else:
            condition = and_(
                User.status == params.status,
                or_(Membership.expires_at.is_(None), Membership.expires_at > now)
            )
        statement = statement.where(User.is_deleted.is_(False), condition)
    membership = (
        select(1)
        .select_from(GroupMember)
        .join(Group, Group.id == GroupMember.group_id)
        .where(
            GroupMember.user_id == User.id,
            GroupMember.is_deleted.is_(False),
            Group.is_deleted.is_(False),
        )
    )
    if params.group_id is not None:
        condition = (
            ~membership.exists()
            if params.group_id == "none"
            else membership.where(Group.id == params.group_id).exists()
        )
        statement = statement.where(Membership.role != "admin", condition)
    if params.department_id is not None:
        granted = (
            membership.join(GroupAccess, GroupAccess.group_id == Group.id)
            .join(Department, Department.id == GroupAccess.department_id)
            .where(
                GroupAccess.department_id == params.department_id,
                GroupAccess.is_deleted.is_(False),
                Department.is_deleted.is_(False),
            )
            .exists()
        )
        statement = statement.where(Membership.role != "admin", granted)
    if params.mfa is not None:
        statement = statement.where(_mfa_predicate(params.mfa, now))
    if params.history is not None:
        statement = statement.where(_history_predicate(params.history, now, params.inactive_days))
    return statement


def directory_list(
    db: Session, params: UserListRequest, now: datetime, *, org_id: UUID
) -> UserListResponse:
    # An explicit ID lookup resolves archived selections as well as live people.
    if params.ids is not None and params.deleted is DeletedFilter.EXCLUDE:
        params = params.model_copy(update={"deleted": DeletedFilter.INCLUDE})
    tie_breaker: ColumnElement[Any] = cast(ColumnElement[Any], User.id)
    if params.sort_by == UserSortField.NAME:
        tie_breaker = tuple_(User.username, User.id)
    elif params.sort_by == UserSortField.EXPIRES_AT:
        tie_breaker = tuple_(_NAME, User.username, User.id)
    spec = ListQuerySpec(
        sort_fields=_SORT_FIELDS,
        default_sort=UserSortField.USERNAME,
        tie_breaker=tie_breaker,
        search_fields=(
            cast(ColumnElement[str], _NAME),
            cast(ColumnElement[str], User.email),
            cast(ColumnElement[str], User.username),
            cast(ColumnElement[str], User.job_title),
        ),
        deleted_field=cast(ColumnElement[bool], User.is_deleted),
    )
    result = execute_standard_list(db, _filtered_users(params, now, org_id), params, spec)
    policy = load_platform_policy(db)
    memberships = {
        member.user_id: member for member in db.scalars(
            select(Membership).where(Membership.org_id == org_id,
                                     Membership.user_id.in_([item.id for item in result.items]))
        )
    }
    count = (
        select(func.count())
        .where(
            IdentitySession.user_id == User.id,
            IdentitySession.provider_user_id == User.supabase_user_id,
            IdentitySession.provider_session_id.is_not(None),
            IdentitySession.revoked_at.is_(None),
            session_expiry_expression(policy) > now,
        )
        .correlate(User)
        .scalar_subquery()
    )
    metadata = {
        row["user_id"]: row
        for row in db.execute(
            select(
                User.id.label("user_id"),
                case((_active_account(now), count), else_=0).label("active_session_count"),
                case(
                    (_known_observation(), IdentityMfaObservation.verified_totp), else_=None
                ).label("mfa_verified_totp"),
                case((_known_observation(), IdentityMfaObservation.observed_at), else_=None).label(
                    "mfa_observed_at"
                ),
                IdentityMfaObservation.last_sign_in_at,
                IdentityMfaObservation.last_active_at,
            )
            .join(Membership, Membership.user_id == User.id)
            .outerjoin(IdentityMfaObservation, IdentityMfaObservation.user_id == User.id)
            .where(User.id.in_([item.id for item in result.items]), Membership.org_id == org_id)
        ).mappings()
    }
    return UserListResponse(
        items=[
            DirectoryRowResponse.model_validate(
                {
                    **{key: getattr(item if key in User.__table__.columns
                                    else memberships[item.id], key)
                       for key in UserResponse.model_fields},
                    "active_session_count": metadata[item.id]["active_session_count"],
                    "mfa_verified_totp": metadata[item.id]["mfa_verified_totp"],
                    "mfa_observed_at": metadata[item.id]["mfa_observed_at"],
                    "last_sign_in_at": metadata[item.id]["last_sign_in_at"],
                    "last_active_at": metadata[item.id]["last_active_at"],
                }
            )
            for item in result.items
        ],
        pagination=result.pagination,
    )


def directory_summary(
    db: Session, now: datetime, inactive_days: int = 30, *, org_id: UUID
) -> UserSummaryResponse:
    counts = db.execute(
        select(
            func.count().filter(_mfa_predicate("without", now)),
            func.count().filter(_mfa_predicate("unknown", now)),
            func.count().filter(_history_predicate("no-recorded-sign-in", now, inactive_days)),
            func.count().filter(_history_predicate("inactive", now, inactive_days)),
        ).select_from(User).join(Membership, Membership.user_id == User.id)
        .where(Membership.org_id == org_id)
    ).one()
    return UserSummaryResponse(
        admins_without_mfa=counts[0],
        admins_mfa_unknown=counts[1],
        no_recorded_sign_in=counts[2],
        inactive_people=counts[3],
        as_of=now,
        inactive_days=inactive_days,
    )
