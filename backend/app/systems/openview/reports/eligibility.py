"""Who may open a Report run: the module readers when the run was created."""

from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.access.policy.scope import module_reader_ids
from app.systems.openview.reports.models import Report, ReportRunEligibleUser


def capture_run_eligible_users(db: Session, report: Report, run_id: UUID) -> None:
    """Persist, in the caller's transaction, every user who can read the module now.

    A run read checks module read again, so a user who loses access later cannot
    open the run even though their row stays.
    """

    for user_id in sorted(module_reader_ids(db, report.module_id), key=str):
        db.add(ReportRunEligibleUser(org_id=report.org_id, run_id=run_id, user_id=user_id))
