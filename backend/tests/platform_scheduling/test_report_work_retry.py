"""A retried Report occurrence keeps one notice per reader with its latest outcome."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.systems.manage.jobs.registry import _retry_work
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.platform.scheduling.service import (
    claim_due_work,
    complete_report_work,
    fail_report_work,
    queue_report_occurrence,
)
from tests.platform_scheduling.test_report_work import _run, _subject

pytestmark = pytest.mark.integration


def _exhaust(db, work: ScheduledWork, now: datetime) -> datetime:
    for attempt in range(1, 6):
        [claim] = claim_due_work(db, now=now)
        assert fail_report_work(db, claim, now=now)
        now += timedelta(seconds=2**attempt)
    assert work.state == WorkState.FAILED
    return now


def _notices(db, work: ScheduledWork) -> list[InAppNotification]:
    db.flush()
    return list(db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id)))


def test_retried_occurrence_success_replaces_the_failure_notice(integration_owner_db):
    db = integration_owner_db
    owner, report, _grant, _module, _department = _subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    now = _exhaust(db, work, now)
    [failed] = _notices(db, work)
    failed.read_at = now
    _retry_work(db, work.kind, work.id, owner.id, None)
    [claim] = claim_due_work(db, now=work.next_attempt_at + timedelta(seconds=1))
    run = _run(db, report, work)
    assert complete_report_work(db, claim, run.id, now=now)
    [notice] = _notices(db, work)
    assert notice.id == failed.id and notice.recipient_id == owner.id
    assert (notice.kind, notice.subject_type, notice.subject_id) == (
        "report-run",
        "report_run",
        run.id,
    )
    assert notice.read_at is None


def test_retried_occurrence_that_fails_again_keeps_one_unread_failure_notice(
    integration_owner_db,
):
    db = integration_owner_db
    owner, report, _grant, _module, _department = _subject(db)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    work = queue_report_occurrence(db, report.id, scheduled_for=now)
    now = _exhaust(db, work, now)
    [failed] = _notices(db, work)
    failed.read_at = now
    _retry_work(db, work.kind, work.id, owner.id, None)
    _exhaust(db, work, work.next_attempt_at + timedelta(seconds=1))
    [notice] = _notices(db, work)
    assert notice.id == failed.id and notice.kind == "report-run-failed"
    assert notice.read_at is None
