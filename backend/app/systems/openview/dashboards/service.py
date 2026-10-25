"""One active home Dashboard per department (BE3).

The partial unique index ``uq_dashboards_department_home`` is the arbiter; these helpers
keep a department that has active Dashboards pointed at one of them. They only mutate:
the calling route commits. Changing which Dashboard is home does not change any
Dashboard's revision, since no one edits the promoted Dashboard.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.openview.dashboards.models import Dashboard


def claim_home_if_missing(db: Session, dashboard: Dashboard) -> None:
    """Make an active Dashboard its department's home when the department has none.

    No autoflush: the flag joins the caller's pending insert or update, so the audit log
    records one change, not a second update for the flag.
    """
    with db.no_autoflush:
        current = db.scalar(
            select(Dashboard.id).where(
                Dashboard.department_id == dashboard.department_id,
                Dashboard.is_home.is_(True),
                Dashboard.is_deleted.is_(False),
                Dashboard.id != dashboard.id,
            )
        )
    if current is None:
        dashboard.is_home = True


def hand_over_home(db: Session, archived: Dashboard) -> None:
    """After archiving the home, make the next active Dashboard by position the home."""
    if not archived.is_home:
        return
    archived.is_home = False
    # The archived row leaves the index first, so the promotion never meets a second home.
    db.flush()
    successor = db.scalar(
        select(Dashboard)
        .where(
            Dashboard.department_id == archived.department_id,
            Dashboard.is_deleted.is_(False),
            Dashboard.id != archived.id,
        )
        .order_by(Dashboard.position, Dashboard.id)
        .limit(1)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if successor is not None:
        successor.is_home = True
