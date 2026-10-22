"""Four concrete job sources, one query shape and their caller-committed retries."""

import hashlib
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, get_args
from uuid import UUID

from sqlalchemy import DateTime, Row, Select, String, case, cast, literal, null, select, union_all
from sqlalchemy.orm import Bundle, Session

from app.common.dependencies import require_platform_operator
from app.core.base_model import utc_now
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.post_models import BoardPost
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.comms.jobs.models import CommsExport, CommsSchedule
from app.systems.comms.messages.models import CommsMessage
from app.systems.manage.backups import service as backups
from app.systems.manage.backups.models import BackupRun
from app.systems.manage.backups.schemas import RunState
from app.systems.manage.jobs.schemas import JobResponse
from app.systems.openview.reports.models import Report
from app.systems.platform.scheduling.models import ScheduledWork, WorkState

FAILURE_LABELS = {
    "attempts_exhausted": "The job failed after five attempts.",
    "run_failed": "The report run failed. An automatic retry is pending.",
    "publication_failed": "Publication failed. An automatic retry is pending.",
    "delivery_failed": "Reminder delivery failed. An automatic retry is pending.",
    "source_unavailable": "The source is no longer available.",
    "schedule_changed": "The schedule changed.",
    "publication_key_conflict": "The publication conflicts with an existing result.",
    "reminder_expired": "The reminder delivery window passed.",
    "backup_failed": "The backup failed.",
    "backup_interrupted": "The backup was interrupted.",
    "verification_failed": "Backup verification failed.",
    "restart_failed": "The server did not restart after the backup.",
    "readiness_failed": "The server was not ready after the backup.",
    "result_unconfirmed": "The backup result could not be confirmed.",
    "retention_failed": "Backup retention cleanup failed.",
    "preview_unavailable": "Optional link preview was unavailable.",
}


def failure_label(code: str | None) -> str | None:
    return FAILURE_LABELS.get(code, "Job failed.") if code is not None else None


class JobStateError(RuntimeError):
    """A safe route-local missing/state conflict, without database detail."""


Retry = Callable[[Session, str, UUID, UUID, str | None], tuple[UUID, bool]]


@dataclass(frozen=True, slots=True)
class JobKind:
    label: str
    query: Callable[[str], Select[Any]]
    subject: Callable[[Row[Any]], tuple[str, str | None]]
    retry: Retry | None
    states: frozenset[str]


def _subject(row: Row[Any]) -> tuple[str, str | None]:
    return str(row.subject_label), row.subject_link


def _work_columns(label: str, name: Any, link: Any) -> tuple[Any, ...]:
    return (
        ScheduledWork.kind.label("kind"),
        ScheduledWork.id.label("id"),
        name.label("subject_label"),
        link.label("subject_link"),
        ScheduledWork.state.label("state"),
        ScheduledWork.scheduled_for.label("scheduled_for"),
        ScheduledWork.last_attempt_started_at.label("last_attempt_at"),
        case(
            (ScheduledWork.state.in_(("pending", "running")), ScheduledWork.next_attempt_at),
            else_=None,
        ).label("next_attempt_at"),
        ScheduledWork.attempt_count.label("attempts"),
        ScheduledWork.failure_code.label("failure_code"),
        (
            (ScheduledWork.state == "failed")
            & ScheduledWork.failure_code.is_distinct_from("source_unavailable")
        ).label("can_retry"),
        ScheduledWork.scheduled_for.label("effective_at"),
        literal(label).label("kind_label"),
    )


def _reports(_instance: str) -> Select[Any]:
    return (
        select(
            *_work_columns(
                "Report run",
                Report.name,
                case(
                    (
                        Report.is_deleted.is_(False),
                        literal("/openview?section=reports&report=") + cast(Report.id, String),
                    ),
                    else_=None,
                ),
            )
        )
        .join(Report, Report.id == ScheduledWork.report_id)
        .where(ScheduledWork.kind == "report-run")
    )


def _posts(_instance: str) -> Select[Any]:
    return (
        select(
            *_work_columns(
                "Post publication",
                BoardPost.title,
                case(
                    (
                        BoardPost.is_deleted.is_(False),
                        literal("/boards?board=")
                        + cast(BoardPost.board_id, String)
                        + "&section=posts",
                    ),
                    else_=None,
                ),
            )
        )
        .join(BoardPost, BoardPost.id == ScheduledWork.post_id)
        .where(ScheduledWork.kind == "post-publish")
    )


def _reminders(_instance: str) -> Select[Any]:
    return (
        select(
            *_work_columns(
                "Event reminder",
                BoardEvent.title,
                case(
                    (
                        BoardEvent.is_deleted.is_(False),
                        literal("/boards?board=")
                        + cast(BoardEvent.board_id, String)
                        + "&section=calendar",
                    ),
                    else_=None,
                ),
            )
        )
        .join(BoardEventReminder, BoardEventReminder.id == ScheduledWork.reminder_id)
        .join(
            BoardEvent,
            BoardEvent.id == BoardEventReminder.event_id,
        )
        .where(ScheduledWork.kind == "event-reminder")
    )


def _backups(instance: str) -> Select[Any]:
    effective = case(
        (BackupRun.scheduled_for.is_not(None), BackupRun.scheduled_for),
        else_=BackupRun.requested_at,
    )
    return select(
        literal("backup").label("kind"),
        BackupRun.id.label("id"),
        BackupRun.name.label("subject_label"),
        literal("/manage?view=backup").label("subject_link"),
        BackupRun.state.label("state"),
        BackupRun.scheduled_for.label("scheduled_for"),
        BackupRun.started_at.label("last_attempt_at"),
        case(
            (BackupRun.state == "queued", effective), else_=cast(null(), DateTime(timezone=True))
        ).label("next_attempt_at"),
        case((BackupRun.started_at.is_not(None), 1), else_=0).label("attempts"),
        BackupRun.failure_code.label("failure_code"),
        ((BackupRun.state == "failed") & (BackupRun.installation_id == instance)).label(
            "can_retry"
        ),
        effective.label("effective_at"),
        literal("Backup").label("kind_label"),
    )


def _retry_work(
    db: Session, kind: str, job_id: UUID, actor: UUID, key: str | None
) -> tuple[UUID, bool]:
    work = db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.kind == kind,
            ScheduledWork.id == job_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if work is None:
        raise JobStateError("job_not_found")
    if work.state != "failed" or work.failure_code == "source_unavailable":
        raise JobStateError("job_not_retryable")
    work.state = WorkState.PENDING
    work.attempt_count = 0
    work.next_attempt_at = utc_now()
    work.lease_token = work.lease_expires_at = None
    work.finished_at = None
    work.failure_code = None
    return work.id, False


def _retry_backup(
    db: Session, kind: str, job_id: UUID, actor: UUID, key: str | None
) -> tuple[UUID, bool]:
    require_platform_operator(db, actor)
    if key is None:
        raise JobStateError("job_retry_key_required")
    instance = backups.installation_id(db)
    backups.lock_policy(db, instance)
    original = db.scalar(
        select(BackupRun)
        .where(BackupRun.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if original is None:
        raise JobStateError("job_not_found")
    if original.state != "failed" or original.installation_id != instance:
        raise JobStateError("job_not_retryable")
    # Public backup keys cannot contain '/', so ordinary requests cannot occupy this identity.
    scoped_key = f"job.retry/backup/{job_id}/{key}"
    digest = hashlib.sha256(scoped_key.encode("ascii")).hexdigest()
    existing = db.scalar(
        select(BackupRun).where(
            BackupRun.installation_id == instance,
            BackupRun.requester_id == actor,
            BackupRun.idempotency_hash == digest,
        )
    )
    run = backups.queue_manual(db, instance, actor, original.name, scoped_key)
    return run.id, existing is not None


_WORK_STATES = frozenset(str(state) for state in WorkState)


def _comms_schedules(_instance: str) -> Select[Any]:
    return (
        select(
            *_work_columns(
                "Scheduled Comms message", literal("Scheduled message"), cast(null(), String)
            )
        )
        .join(
            CommsSchedule,
            CommsSchedule.id == ScheduledWork.comms_schedule_id,
        )
        .where(ScheduledWork.kind == "comms-scheduled-message")
    )


def _comms_exports(_instance: str) -> Select[Any]:
    return (
        select(*_work_columns("Comms export", literal("Comms export"), cast(null(), String)))
        .join(
            CommsExport,
            CommsExport.id == ScheduledWork.comms_export_id,
        )
        .where(ScheduledWork.kind == "comms-export")
    )


def _comms_previews(_instance: str) -> Select[Any]:
    return (
        select(*_work_columns("Link preview", literal("Link preview"), cast(null(), String)))
        .join(
            CommsMessage,
            (CommsMessage.org_id == ScheduledWork.org_id)
            & (CommsMessage.id == ScheduledWork.comms_preview_message_id),
        )
        .where(ScheduledWork.kind == "comms-link-preview")
    )


REGISTRY = {
    "report-run": JobKind("Report run", _reports, _subject, _retry_work, _WORK_STATES),
    "post-publish": JobKind("Post publication", _posts, _subject, _retry_work, _WORK_STATES),
    "event-reminder": JobKind("Event reminder", _reminders, _subject, _retry_work, _WORK_STATES),
    "backup": JobKind("Backup", _backups, _subject, _retry_backup, frozenset(get_args(RunState))),
    "comms-scheduled-message": JobKind(
        "Scheduled Comms message", _comms_schedules, _subject, None, _WORK_STATES
    ),
    "comms-export": JobKind("Comms export", _comms_exports, _subject, None, _WORK_STATES),
    "comms-link-preview": JobKind("Link preview", _comms_previews, _subject, None, _WORK_STATES),
}


def jobs_query(instance: str) -> tuple[Select[tuple[Row[Any]]], Any]:
    source = union_all(*(entry.query(instance) for entry in REGISTRY.values())).subquery("jobs")
    bundle: Bundle[Row[Any]] = Bundle("job", *source.c, single_entity=True)
    return select(bundle), source.c


def response(row: Row[Any]) -> JobResponse:
    entry = REGISTRY[str(row.kind)]
    values = {
        name: getattr(row, name)
        for name in JobResponse.model_fields
        if name not in {"failure_label", "subject_label", "subject_link"}
    }
    values["subject_label"], values["subject_link"] = entry.subject(row)
    values["failure_label"] = failure_label(row.failure_code)
    values["can_retry"] = bool(row.can_retry) and entry.retry is not None
    return JobResponse.model_validate(values)
