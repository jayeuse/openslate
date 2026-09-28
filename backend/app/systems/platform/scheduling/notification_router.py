"""Recipient-scoped references to completed Report and Board work."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
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
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkKind
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


class NotificationResponse(BaseModel):
    id: UUID
    status: Literal["unread", "read"]
    scheduled_for: datetime
    created_at: datetime
    read_at: datetime | None


class ReportNotificationResponse(NotificationResponse):
    kind: Literal["report-run"]
    report_id: UUID
    run_id: UUID


class PostNotificationResponse(NotificationResponse):
    kind: Literal["post-publish"]
    board_id: UUID
    post_id: UUID
    publication_revision_id: UUID


class EventReminderNotificationResponse(NotificationResponse):
    kind: Literal["event-reminder"]
    board_id: UUID
    event_id: UUID
    occurrence_id: str
    occurrence_start_at: datetime


NotificationItem = Annotated[
    ReportNotificationResponse
    | PostNotificationResponse
    | EventReminderNotificationResponse,
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
    work: ScheduledWork,
    *,
    post_board_ids: dict[UUID, UUID] | None = None,
    reminder_events: dict[UUID, BoardEvent] | None = None,
) -> NotificationItem:
    common = dict(
        id=notification.id,
        status="read" if notification.read_at is not None else "unread",
        scheduled_for=work.scheduled_for,
        created_at=notification.created_at,
        read_at=notification.read_at,
    )
    if work.kind == WorkKind.REPORT_RUN:
        if work.report_id is None or work.run_id is None:
            raise _not_found()
        return ReportNotificationResponse(
            **common, kind="report-run", report_id=work.report_id, run_id=work.run_id
        )
    if work.kind == WorkKind.POST_PUBLISH:
        if work.post_id is None or work.publication_result_id is None:
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
        if event is None:
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

    result = execute_standard_list(
        db, current_user_notification_query(db, user.id), params, NOTIFICATION_LIST_SPEC
    )
    work_by_id = {
        work.id: work
        for work in db.scalars(
            select(ScheduledWork).where(
                ScheduledWork.id.in_([item.work_id for item in result.items])
            )
        )
    }
    page_entries = [(item, work_by_id[item.work_id]) for item in result.items]

    post_ids = {
        work.post_id
        for _, work in page_entries
        if work.kind == WorkKind.POST_PUBLISH and work.post_id is not None
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
            if work.kind == WorkKind.EVENT_REMINDER and work.reminder_id is not None
        },
    )
    items = [
        _response(
            db,
            item,
            work,
            post_board_ids=post_board_ids,
            reminder_events=reminder_events,
        )
        for item, work in page_entries
    ]
    return NotificationListResponse(items=items, pagination=result.pagination)


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
    work = db.get(ScheduledWork, notification.work_id)
    if work is None:
        raise _not_found()
    if notification.read_at is None:
        notification.read_at = utc_now()
        db.commit()
        db.refresh(notification)
    return _response(db, notification, work)
