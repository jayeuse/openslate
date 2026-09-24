"""Report audience target validation and fail-closed output authorization."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.openview.reports.models import Report, ReportRunEligibleUser
from app.systems.openview.reports.schemas import ReportAudience


def validate_audience(db: Session, audience: ReportAudience) -> None:
    """Lock live targets through the recipe write; absent targets fail closed."""
    if audience.kind == "role":
        target_role = db.scalar(
            select(Role).where(
                Role.id == audience.role_id,
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            ).execution_options(populate_existing=True).with_for_update()
        )
    elif audience.kind == "user":
        target = db.execute(
            select(User, Role)
            .join(Role, User.role_id == Role.id)
            .where(
                User.id == audience.user_id,
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                established_user_clause(),
                identity_eligible_clause(),
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
            )
            .execution_options(populate_existing=True)
            .with_for_update(of=(User, Role))
        ).one_or_none()
        target_role = target[1] if target is not None else None
    else:
        return
    if target_role is None or not has_capability(target_role, Capability.RECORDS_READ):
        raise HTTPException(
            409,
            detail={"code": "audience_invalid", "message": "The selected audience is unavailable"},
        )


def run_audience_clause(user: User) -> ColumnElement[bool]:
    """The recipe owner has no bypass for outputs excluded by their audience."""
    no_target = and_(Report.audience_role_id.is_(None), Report.audience_user_id.is_(None))
    return or_(
        and_(Report.audience_kind == "private", Report.owner_id == user.id, no_target),
        and_(Report.audience_kind == "everyone", no_target),
        and_(
            Report.audience_kind == "role",
            Report.audience_role_id == user.role_id,
            Report.audience_user_id.is_(None),
        ),
        and_(
            Report.audience_kind == "user",
            Report.audience_user_id == user.id,
            Report.audience_role_id.is_(None),
        ),
    )


def capture_run_eligible_users(db: Session, report: Report, run_id: UUID) -> None:
    """Persist the eligible readers at finalization in the caller's transaction."""

    statement = (
        select(User.id, Role)
        .join(Role, User.role_id == Role.id)
        .where(
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
            identity_eligible_clause(),
            Role.is_deleted.is_(False),
            Role.deleted_at.is_(None),
        )
    )
    if report.audience_kind == "private":
        statement = statement.where(User.id == report.owner_id)
    elif report.audience_kind == "role" and report.audience_role_id is not None:
        statement = statement.where(User.role_id == report.audience_role_id)
    elif report.audience_kind == "user" and report.audience_user_id is not None:
        statement = statement.where(User.id == report.audience_user_id)
    elif report.audience_kind != "everyone":
        return
    for user_id, role in db.execute(statement):
        if has_capability(role, Capability.RECORDS_READ):
            db.add(ReportRunEligibleUser(run_id=run_id, user_id=user_id))


def audience_columns(audience: ReportAudience) -> tuple[str, UUID | None, UUID | None]:
    return audience.kind, audience.role_id, audience.user_id


def report_audience(report: Report) -> ReportAudience:
    return ReportAudience(
        kind=report.audience_kind,
        role_id=report.audience_role_id,
        user_id=report.audience_user_id,
    )
