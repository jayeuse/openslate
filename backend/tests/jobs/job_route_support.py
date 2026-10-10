"""Owned persisted Jobs subjects using existing domain fixtures, never a live instance."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.manage.backups.models import BackupRun
from app.systems.manage.backups.service import installation_id
from app.systems.platform.scheduling.materializer import materialize_event_reminders
from app.systems.platform.scheduling.models import ScheduledWork
from tests.boards.support import grant, member, project_board
from tests.platform_scheduling.test_event_reminder_execution import _timed_event, _work
from tests.platform_scheduling.test_post_execution import _subject as post_subject
from tests.platform_scheduling.test_report_work import _subject as report_subject

NOW = datetime(2027, 3, 1, 9, tzinfo=UTC)


def failed_jobs(
    db: Session, *, shared_id: UUID | None = None
) -> dict[str, ScheduledWork | BackupRun]:
    """One terminal failed row of each accepted kind, with API-visible subject names."""
    actor, report, *_ = report_subject(db)
    report.name = "Literal_% report"
    report_work = ScheduledWork(
        id=shared_id or uuid7(),
        kind="report-run",
        report_id=report.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
    )
    db.add(report_work)
    _, _, _, post, post_work = post_subject(db)
    post.title = "Owned publication"
    post_work.scheduled_for = post_work.next_attempt_at = NOW
    board, author = project_board(db), member(db)
    grant(db, board, [author], AccessLevel.WRITE)
    event = _timed_event(db, board, author, reminders=["start"], weekly=False)
    materialize_event_reminders(db, now=NOW - timedelta(minutes=1))
    [reminder] = _work(db, event)
    for work in (report_work, post_work, reminder):
        work.state = "failed"
        work.attempt_count = 5
        work.failure_code = "attempts_exhausted"
        work.last_attempt_started_at = NOW
        work.finished_at = NOW + timedelta(seconds=1)
    backup = BackupRun(
        id=shared_id or uuid7(),
        installation_id=installation_id(db),
        name="Owned backup",
        provenance="manual",
        requester_id=actor.id,
        idempotency_hash=uuid7().hex + uuid7().hex,
        schedule="disabled",
        retention_days=30,
        requested_at=NOW,
        state="failed",
        claim_id=uuid7(),
        claimed_schedule="disabled",
        claimed_retention_days=30,
        started_at=NOW,
        finished_at=NOW + timedelta(seconds=1),
        failure_code="backup_failed",
    )
    db.add(backup)
    db.flush()
    return {
        "report-run": report_work,
        "post-publish": post_work,
        "event-reminder": reminder,
        "backup": backup,
    }
