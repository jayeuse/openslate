"""Recipient-scoped references to completed Report and Board work."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user
from app.common.listing import (
    ListQuerySpec,
    SortOrder,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.post_models import BoardPost
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.boards.reminder_service import occurrence_at
from app.systems.platform.scheduling.models import (
    InAppNotification,
    NotificationKind,
    ScheduledWork,
    WorkKind,
)
from app.systems.platform.scheduling.notification_sources import (
    record_module_ids,
    version_sequences,
)
from app.systems.platform.scheduling.service import current_user_notification_query


def _private_cache(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


router = APIRouter(
    prefix="/notifications", tags=["notifications"], dependencies=[Depends(_private_cache)]
)
Reader = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


class NotificationSort(StrEnum):
    CREATED_AT = "created_at"


class NotificationListRequest(StandardListRequest[NotificationSort]):
    sort_order: Literal[SortOrder.DESC] = SortOrder.DESC
    status: Literal["unread"] | None = None


class NotificationResponse(BaseModel):
    id: UUID
    status: Literal["unread", "read"]
    scheduled_for: datetime | None
    created_at: datetime
    read_at: datetime | None
    subject_type: str
    subject_id: UUID


class ReportNotificationResponse(NotificationResponse):
    scheduled_for: datetime
    kind: Literal["report-run"]
    subject_type: Literal["report_run"]
    report_id: UUID
    run_id: UUID


class FailedReportNotificationResponse(NotificationResponse):
    scheduled_for: datetime
    kind: Literal["report-run-failed"]
    subject_type: Literal["scheduled_work"]
    report_id: UUID


class PostNotificationResponse(NotificationResponse):
    scheduled_for: datetime
    kind: Literal["post-publish"]
    subject_type: Literal["board_post"]
    board_id: UUID
    post_id: UUID
    publication_revision_id: UUID


class EventReminderNotificationResponse(NotificationResponse):
    scheduled_for: datetime
    kind: Literal["event-reminder"]
    subject_type: Literal["board_event"]
    board_id: UUID
    event_id: UUID
    occurrence_id: str
    occurrence_start_at: datetime


class BackupFailureNotificationResponse(NotificationResponse):
    kind: Literal["backup-failed"]
    subject_type: Literal["backup_run"]
    scheduled_for: None


class RecordAssignmentNotificationResponse(NotificationResponse):
    kind: Literal["record-assigned"]
    subject_type: Literal["record"]
    scheduled_for: None
    module_id: UUID


class InvitationAcceptedNotificationResponse(NotificationResponse):
    kind: Literal["invitation-accepted"]
    subject_type: Literal["user"]
    scheduled_for: None


class SandboxPublishedNotificationResponse(NotificationResponse):
    kind: Literal["sandbox-published"]
    subject_type: Literal["sandbox_version"]
    scheduled_for: None
    version_sequence: int = Field(gt=0)


class AccessChangedNotificationResponse(NotificationResponse):
    kind: Literal["access-changed"]
    subject_type: Literal["user"]
    scheduled_for: None


NotificationItem = Annotated[
    ReportNotificationResponse
    | FailedReportNotificationResponse
    | PostNotificationResponse
    | EventReminderNotificationResponse
    | BackupFailureNotificationResponse
    | RecordAssignmentNotificationResponse
    | InvitationAcceptedNotificationResponse
    | SandboxPublishedNotificationResponse
    | AccessChangedNotificationResponse,
    Field(discriminator="kind"),
]


class NotificationListResponse(StandardListResponse[NotificationItem]):
    pass


NOTIFICATION_LIST_SPEC = ListQuerySpec(
    sort_fields={
        NotificationSort.CREATED_AT: cast(ColumnElement[Any], InAppNotification.created_at)
    },
    default_sort=NotificationSort.CREATED_AT,
    tie_breaker=cast(ColumnElement[Any], InAppNotification.id),
)


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Notification not found")


def _reminder_events(db: Session, reminder_ids: set[UUID]) -> dict[UUID, BoardEvent]:
    if not reminder_ids:
        return {}
    return {
        reminder_id: event
        for reminder_id, event in db.execute(
            select(BoardEventReminder.id, BoardEvent)
            .join(BoardEvent, BoardEvent.id == BoardEventReminder.event_id)
            .where(BoardEventReminder.id.in_(reminder_ids))
        ).tuples()
    }


def _response(
    db: Session,
    notification: InAppNotification,
    work: ScheduledWork | None,
    *,
    post_board_ids: dict[UUID, UUID] | None = None,
    reminder_events: dict[UUID, BoardEvent] | None = None,
    record_modules: dict[UUID, UUID] | None = None,
    sandbox_sequences: dict[UUID, int] | None = None,
) -> NotificationItem:
    common = dict(
        id=notification.id,
        status="read" if notification.read_at is not None else "unread",
        scheduled_for=work.scheduled_for if work is not None else None,
        created_at=notification.created_at,
        read_at=notification.read_at,
        subject_type=notification.subject_type,
        subject_id=notification.subject_id,
    )
    if notification.kind == NotificationKind.ACCESS_CHANGED:
        if (
            work is not None
            or notification.subject_type != "user"
            or notification.subject_id != notification.recipient_id
        ):
            raise _not_found()
        return AccessChangedNotificationResponse(**common, kind="access-changed")
    if notification.kind == NotificationKind.SANDBOX_PUBLISHED:
        sequences = (
            sandbox_sequences
            if sandbox_sequences is not None
            else version_sequences(db, {notification.subject_id})
        )
        sequence = sequences.get(notification.subject_id)
        if work is not None or notification.subject_type != "sandbox_version" or sequence is None:
            raise _not_found()
        return SandboxPublishedNotificationResponse(
            **common, kind="sandbox-published", version_sequence=sequence
        )
    if notification.kind == NotificationKind.INVITATION_ACCEPTED:
        if work is not None or notification.subject_type != "user":
            raise _not_found()
        return InvitationAcceptedNotificationResponse(**common, kind="invitation-accepted")
    if notification.kind == NotificationKind.RECORD_ASSIGNED:
        modules = (
            record_modules
            if record_modules is not None
            else record_module_ids(db, {notification.subject_id})
        )
        module_id = modules.get(notification.subject_id)
        if work is not None or notification.subject_type != "record" or module_id is None:
            raise _not_found()
        return RecordAssignmentNotificationResponse(
            **common, kind="record-assigned", module_id=module_id
        )
    if notification.kind == NotificationKind.BACKUP_FAILED:
        if work is not None or notification.subject_type != "backup_run":
            raise _not_found()
        return BackupFailureNotificationResponse(**common, kind="backup-failed")
    if work is None:
        raise _not_found()
    if notification.kind == NotificationKind.REPORT_RUN_FAILED:
        if (
            work.kind != WorkKind.REPORT_RUN
            or work.report_id is None
            or work.state != "failed"
            or notification.subject_type != "scheduled_work"
            or notification.subject_id != work.id
        ):
            raise _not_found()
        return FailedReportNotificationResponse(
            **common,
            kind="report-run-failed",
            report_id=work.report_id,
        )
    if work.kind == WorkKind.REPORT_RUN:
        if (
            work.report_id is None
            or work.run_id is None
            or notification.kind != NotificationKind.REPORT_RUN
            or notification.subject_type != "report_run"
            or notification.subject_id != work.run_id
        ):
            raise _not_found()
        return ReportNotificationResponse(
            **common, kind="report-run", report_id=work.report_id, run_id=work.run_id
        )
    if work.kind == WorkKind.POST_PUBLISH:
        if (
            work.post_id is None
            or work.publication_result_id is None
            or notification.kind != NotificationKind.POST_PUBLISH
            or notification.subject_type != "board_post"
            or notification.subject_id != work.post_id
        ):
            raise _not_found()
        if post_board_ids is None:
            post = db.get(BoardPost, work.post_id)
            if post is None:
                raise _not_found()
            board_id = post.board_id
        else:
            page_board_id = post_board_ids.get(work.post_id)
            if page_board_id is None:
                raise _not_found()
            board_id = page_board_id
        return PostNotificationResponse(
            **common,
            kind="post-publish",
            board_id=board_id,
            post_id=work.post_id,
            publication_revision_id=work.publication_result_id,
        )
    if (
        work.kind == WorkKind.EVENT_REMINDER
        and work.reminder_id is not None
        and work.occurrence_start_at is not None
    ):
        event = (
            reminder_events.get(work.reminder_id)
            if reminder_events is not None
            else _reminder_events(db, {work.reminder_id}).get(work.reminder_id)
        )
        if (
            event is None
            or notification.kind != NotificationKind.EVENT_REMINDER
            or notification.subject_type != "board_event"
            or notification.subject_id != event.id
        ):
            raise _not_found()
        occurrence = occurrence_at(event, work.occurrence_start_at)
        return EventReminderNotificationResponse(
            **common,
            kind="event-reminder",
            board_id=event.board_id,
            event_id=event.id,
            occurrence_id=(
                occurrence.id
                if occurrence is not None
                else f"{event.id}:{work.occurrence_start_at.date().isoformat()}"
            ),
            occurrence_start_at=work.occurrence_start_at,
        )
    raise _not_found()


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    user: Reader,
    db: Database,
    params: Annotated[NotificationListRequest, Query()],
) -> NotificationListResponse:
    """Count and page only references currently visible to the recipient."""

    statement = current_user_notification_query(db, user.id)
    if params.status == "unread":
        statement = statement.where(InAppNotification.read_at.is_(None))
    result = execute_standard_list(db, statement, params, NOTIFICATION_LIST_SPEC)
    work_by_id = {
        work.id: work
        for work in db.scalars(
            select(ScheduledWork).where(
                ScheduledWork.id.in_([item.work_id for item in result.items])
            )
        )
    }
    page_entries = []
    for item in result.items:
        if item.work_id is not None and item.work_id not in work_by_id:
            raise _not_found()
        page_entries.append(
            (item, work_by_id.get(item.work_id) if item.work_id is not None else None)
        )

    post_ids = {
        work.post_id
        for _, work in page_entries
        if work is not None and work.kind == WorkKind.POST_PUBLISH and work.post_id is not None
    }
    post_board_ids = (
        {
            post_id: board_id
            for post_id, board_id in db.execute(
                select(BoardPost.id, BoardPost.board_id).where(BoardPost.id.in_(post_ids))
            )
        }
        if post_ids
        else {}
    )
    reminder_events = _reminder_events(
        db,
        {
            work.reminder_id
            for _, work in page_entries
            if work is not None
            and work.kind == WorkKind.EVENT_REMINDER
            and work.reminder_id is not None
        },
    )
    record_modules = record_module_ids(
        db,
        {item.subject_id for item in result.items if item.kind == NotificationKind.RECORD_ASSIGNED},
    )
    sandbox_sequences = version_sequences(
        db,
        {
            item.subject_id
            for item in result.items
            if item.kind == NotificationKind.SANDBOX_PUBLISHED
        },
    )
    items = [
        _response(
            db,
            item,
            work,
            post_board_ids=post_board_ids,
            reminder_events=reminder_events,
            record_modules=record_modules,
            sandbox_sequences=sandbox_sequences,
        )
        for item, work in page_entries
    ]
    return NotificationListResponse(items=items, pagination=result.pagination)


class UnreadCountResponse(BaseModel):
    unread_count: int = Field(ge=0)


class ReadAllResponse(BaseModel):
    updated_count: int = Field(ge=0)


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_notification_count(user: Reader, db: Database) -> UnreadCountResponse:
    statement = current_user_notification_query(db, user.id, lock_user=False).where(
        InAppNotification.read_at.is_(None)
    )
    count = db.scalar(select(func.count()).select_from(statement.subquery()))
    return UnreadCountResponse(unread_count=count or 0)


@router.post("/read-all", response_model=ReadAllResponse)
def mark_all_notifications_read(user: Reader, db: Database) -> ReadAllResponse:
    notifications = list(
        db.scalars(
            current_user_notification_query(db, user.id)
            .where(InAppNotification.read_at.is_(None))
            .order_by(InAppNotification.id)
            .with_for_update(of=InAppNotification)
            .execution_options(populate_existing=True)
        )
    )
    if notifications:
        read_at = utc_now()
        for notification in notifications:
            notification.read_at = read_at
        db.commit()
    return ReadAllResponse(updated_count=len(notifications))


@router.post("/{notification_id}/read", response_model=NotificationItem)
def mark_notification_read(
    notification_id: UUID,
    user: Reader,
    db: Database,
) -> NotificationItem:
    """A repeated mark-read preserves the original timestamp and audit entry."""

    notification = db.scalar(
        current_user_notification_query(db, user.id)
        .where(InAppNotification.id == notification_id)
        .with_for_update(of=InAppNotification)
        .execution_options(populate_existing=True)
    )
    if notification is None:
        raise _not_found()
    work = db.get(ScheduledWork, notification.work_id) if notification.work_id is not None else None
    if notification.read_at is None:
        notification.read_at = utc_now()
        db.commit()
        db.refresh(notification)
    return _response(db, notification, work)
