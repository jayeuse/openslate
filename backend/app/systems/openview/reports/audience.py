"""Report audience target validation and fail-closed output authorization."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.policy.scope import module_reader_ids
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import User, UserStatus
from app.systems.openview.reports.models import Report, ReportRunEligibleUser
from app.systems.openview.reports.schemas import ReportAudience


def validate_audience(db: Session, audience: ReportAudience, module_id: UUID) -> None:
    """A user audience must be an active account that can read the report module."""
    if audience.kind != "user":
        return
    target = db.scalar(
        select(User.id)
        .where(
            User.id == audience.user_id,
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
            identity_eligible_clause(),
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if target is None or target not in module_reader_ids(db, module_id):
        raise HTTPException(
            409,
            detail={"code": "audience_invalid", "message": "The selected audience is unavailable"},
        )


def run_audience_clause(user: User) -> ColumnElement[bool]:
    """The recipe owner has no bypass for outputs excluded by their audience."""
    return or_(
        and_(
            Report.audience_kind == "private",
            Report.owner_id == user.id,
            Report.audience_user_id.is_(None),
        ),
        and_(Report.audience_kind == "everyone", Report.audience_user_id.is_(None)),
        and_(Report.audience_kind == "user", Report.audience_user_id == user.id),
    )


def capture_run_eligible_users(db: Session, report: Report, run_id: UUID) -> None:
    """Persist, in the caller's transaction, the audience members who can read the module."""

    readers = module_reader_ids(db, report.module_id)
    if report.audience_kind == "private":
        eligible = readers & {report.owner_id}
    elif report.audience_kind == "user" and report.audience_user_id is not None:
        eligible = readers & {report.audience_user_id}
    elif report.audience_kind == "everyone":
        eligible = readers
    else:
        return
    for user_id in sorted(eligible, key=str):
        db.add(ReportRunEligibleUser(run_id=run_id, user_id=user_id))


def audience_columns(audience: ReportAudience) -> tuple[str, UUID | None]:
    return audience.kind, audience.user_id


def report_audience(report: Report) -> ReportAudience:
    return ReportAudience(kind=report.audience_kind, user_id=report.audience_user_id)
