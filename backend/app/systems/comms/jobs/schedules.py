"""Author-owned source rows; the platform work row owns claim and terminal state."""

import hashlib
import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from sqlalchemy import func, select, true
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import error, fresh_membership
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.jobs.models import CommsExpiredSend, CommsSchedule
from app.systems.comms.jobs.schemas import CommsScheduleRequest, CommsScheduleResponse
from app.systems.comms.messages.admission import authorize_send
from app.systems.comms.messages.interaction_schemas import TimeList, TimeSort
from app.systems.comms.messages.schemas import ReplyRequest, SendRequest
from app.systems.comms.moderation.service import match
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState

PENDING_CAP = 100
DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
router = APIRouter(
    prefix="/comms/scheduled-messages",
    tags=["comms"],
    dependencies=[Depends(get_current_membership)],
)


def send_request(payload: CommsScheduleRequest) -> SendRequest | ReplyRequest:
    fields = payload.model_dump(exclude={"conversation_id", "send_at", "parent_id"})
    if payload.parent_id is not None:
        return ReplyRequest.model_validate(fields)
    fields.pop("also_send_to_channel")
    return SendRequest.model_validate(fields)


def require_capacity(db: Session, actor: User, *, excluding: UUID | None = None) -> None:
    """One per-org/author lock and one PENDING-only count, shared by create and edit."""
    db.scalar(
        select(Membership)
        .where(
            Membership.org_id == bound_organization_column(),
            Membership.user_id == actor.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if fresh_membership(db, actor) is None:
        raise error("comms_not_found", "Account is unavailable")
    count = (
        db.scalar(
            select(func.count())
            .select_from(CommsSchedule)
            .join(
                ScheduledWork,
                ScheduledWork.comms_schedule_id == CommsSchedule.id,
            )
            .where(
                CommsSchedule.org_id == bound_organization_column(),
                CommsSchedule.author_id == actor.id,
                ScheduledWork.org_id == bound_organization_column(),
                ScheduledWork.kind == WorkKind.COMMS_SCHEDULED_MESSAGE,
                ScheduledWork.state == WorkState.PENDING,
                CommsSchedule.id != excluding if excluding else true(),
            )
        )
        or 0
    )
    if count >= PENDING_CAP:
        raise error(
            "comms_capacity_reached",
            "At most 100 pending schedules per author and organization",
            409,
        )


def admit(db: Session, actor: User, payload: CommsScheduleRequest) -> None:
    if payload.send_at <= utc_now():
        raise error("comms_invalid_input", "send_at must be in the future", 422)
    authorize_send(
        db, actor, payload.conversation_id, send_request(payload), parent_id=payload.parent_id
    )
    if (
        db.scalar(
            select(CommsExpiredSend.id).where(
                CommsExpiredSend.org_id == bound_organization_column(),
                CommsExpiredSend.author_id == actor.id,
                CommsExpiredSend.client_key == payload.client_key,
            )
        )
        is not None
    ):
        raise error("comms_idempotency_mismatch", "Client key identifies an expired message", 409)


def load(
    db: Session, actor: User, identity: UUID, *, lock: bool = False
) -> tuple[CommsSchedule, ScheduledWork]:
    source_query = (
        select(CommsSchedule)
        .where(
            CommsSchedule.org_id == bound_organization_column(),
            CommsSchedule.id == identity,
            CommsSchedule.author_id == actor.id,
            CommsSchedule.is_deleted.is_(False),
        )
        .execution_options(populate_existing=True)
    )
    row = db.scalar(source_query.with_for_update() if lock else source_query)
    if row is None:
        raise error("comms_not_found", "Schedule not found")
    query = (
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.comms_schedule_id == row.id,
            ScheduledWork.kind == WorkKind.COMMS_SCHEDULED_MESSAGE,
        )
        .execution_options(populate_existing=True)
    )
    work = db.scalar(query.with_for_update() if lock else query)
    if work is None:
        raise error("comms_not_found", "Schedule not found")
    return row, work


def response(row: CommsSchedule, work: ScheduledWork) -> CommsScheduleResponse:
    return CommsScheduleResponse.model_validate(
        {
            "id": row.id,
            "org_id": row.org_id,
            "author_id": row.author_id,
            "request": row.request,
            "status": "cancelled" if work.state == WorkState.CANCELED else work.state,
            "message_id": work.comms_message_id,
            "failure_code": work.failure_code,
            "created_at": row.created_at,
            "updated_at": max(row.updated_at, work.updated_at),
        }
    )


def version(row: CommsSchedule, work: ScheduledWork) -> str:
    fields = {
        "namespace": "comms-schedule-v1",
        "revision": row.revision,
        "value": response(row, work).model_dump(mode="json"),
    }
    return '"' + hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest() + '"'


def pending(work: ScheduledWork) -> None:
    if work.state != WorkState.PENDING:
        raise error(
            "comms_schedule_claimed" if work.state == WorkState.RUNNING else "comms_conflict",
            "Schedule is no longer pending",
            409,
        )


@router.get("", response_model=StandardListResponse[CommsScheduleResponse])
def list_schedules(
    db: DB, actor: Actor, http: Response, params: Annotated[TimeList, Query()]
) -> Any:
    query = (
        select(CommsSchedule)
        .join(ScheduledWork, ScheduledWork.comms_schedule_id == CommsSchedule.id)
        .where(
            CommsSchedule.org_id == bound_organization_column(),
            CommsSchedule.author_id == actor.id,
            CommsSchedule.is_deleted.is_(False),
            ScheduledWork.kind == WorkKind.COMMS_SCHEDULED_MESSAGE,
        )
    )
    page = execute_standard_list(
        db,
        query,
        StandardListRequest[TimeSort](**params.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: CommsSchedule.created_at.expression,
                TimeSort.UPDATED: CommsSchedule.updated_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=CommsSchedule.id.expression,
        ),
    )
    works = {
        work.comms_schedule_id: work
        for work in db.scalars(
            select(ScheduledWork).where(
                ScheduledWork.comms_schedule_id.in_([row.id for row in page.items]),
                ScheduledWork.org_id == bound_organization_column(),
            )
        )
    }
    private(http)
    return StandardListResponse(
        items=[response(row, works[row.id]) for row in page.items], pagination=page.pagination
    )


@router.get("/{schedule_id}", response_model=CommsScheduleResponse)
def get_schedule(schedule_id: UUID, db: DB, actor: Actor, http: Response) -> CommsScheduleResponse:
    row, work = load(db, actor, schedule_id)
    private(http)
    http.headers["ETag"] = version(row, work)
    return response(row, work)


@router.post("", response_model=CommsScheduleResponse, status_code=201)
def create(
    payload: CommsScheduleRequest, db: DB, actor: Actor, http: Response
) -> CommsScheduleResponse:
    with transaction(db):
        require_capacity(db, actor)
        admit(db, actor, payload)
        row = CommsSchedule(
            org_id=bound_organization(db),
            author_id=actor.id,
            conversation_id=payload.conversation_id,
            client_key=payload.client_key,
            request=payload.model_dump(mode="json"),
        )
        db.add(row)
        db.flush()
        work = ScheduledWork(
            org_id=row.org_id,
            kind=WorkKind.COMMS_SCHEDULED_MESSAGE,
            comms_schedule_id=row.id,
            scheduling_actor_id=actor.id,
            source_revision=row.revision,
            scheduled_for=payload.send_at,
            next_attempt_at=payload.send_at,
        )
        db.add(work)
        db.flush()
        private(http)
        http.headers["Location"] = f"/api/comms/scheduled-messages/{row.id}"
        http.headers["ETag"] = version(row, work)
        value = response(row, work)
    return value


@router.put("/{schedule_id}", response_model=CommsScheduleResponse)
def edit(
    schedule_id: UUID,
    payload: CommsScheduleRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> CommsScheduleResponse:
    with transaction(db):
        require_capacity(db, actor, excluding=schedule_id)
        row, work = load(db, actor, schedule_id, lock=True)
        pending(work)
        match(if_match, version(row, work))
        admit(db, actor, payload)
        if row.revision >= 2147483647:
            raise error("comms_conflict", "Schedule version exhausted", 409)
        row.request = payload.model_dump(mode="json")
        row.conversation_id, row.client_key = payload.conversation_id, payload.client_key
        row.revision += 1
        work.source_revision = row.revision
        work.scheduled_for = work.next_attempt_at = payload.send_at
        db.flush()
        private(http)
        http.headers["ETag"] = version(row, work)
        value = response(row, work)
    return value


@router.post("/{schedule_id}/cancellation", response_model=CommsScheduleResponse)
def cancel(
    schedule_id: UUID, db: DB, actor: Actor, http: Response, if_match: Match = None
) -> CommsScheduleResponse:
    with transaction(db):
        row, work = load(db, actor, schedule_id, lock=True)
        pending(work)
        match(if_match, version(row, work))
        work.state, work.finished_at = WorkState.CANCELED, utc_now()
        db.flush()
        private(http)
        value = response(row, work)
    return value


@router.post("/{schedule_id}/send", response_model=CommsScheduleResponse)
def send_now(
    schedule_id: UUID,
    db: DB,
    actor: Actor,
    request: Request,
    http: Response,
    if_match: Match = None,
) -> CommsScheduleResponse:
    from app.systems.comms.jobs.schedule_worker import claim_schedule, execute_schedule_claim

    org, engine, actor_id = bound_organization(db), db.get_bind().engine, actor.id
    with transaction(db):
        row, work = load(db, actor, schedule_id, lock=True)
        pending(work)
        match(if_match, version(row, work))
        claim = claim_schedule(db, schedule_id, now=utc_now(), manual=True)
    # No request Session or caller cancellation object enters the committed job.
    execute_schedule_claim(engine, org, claim, publish=request.app.state.comms_publisher.submit)
    db.expire_all()
    reloaded = db.get(User, actor_id)
    assert reloaded is not None
    private(http)
    return response(*load(db, reloaded, schedule_id))
