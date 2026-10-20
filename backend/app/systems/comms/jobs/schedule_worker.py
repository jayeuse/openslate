"""Committed platform claims outlive callers; send/result share the canonical transaction."""

from collections.abc import Callable
from copy import deepcopy
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Engine, and_, or_, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column, scope_session
from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.comms.jobs.models import CommsSchedule
from app.systems.comms.jobs.schedules import send_request
from app.systems.comms.jobs.schemas import CommsScheduleRequest
from app.systems.comms.messages.admission import authorize_send
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.service import (
    InvalidSend,
    SendConflict,
    SendMessageCommand,
    SendRateLimited,
    send_message,
)
from app.systems.comms.realtime.events import user_event
from app.systems.comms.realtime.publication import request_events, take_committed_events
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
from app.systems.platform.scheduling.service import LEASE_DURATION, MAX_ATTEMPTS, WorkClaim

Publish = Callable[[list[dict[str, Any]]], None]


class StaleClaim(RuntimeError):
    pass


def _session(engine: Engine, org: UUID, author: UUID | None = None) -> AuditSession:
    db = AuditSession(engine)
    scope_session(db, org)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=author,
        request_id=uuid7(),
        request_method="SCHEDULE",
        request_path="/internal/comms/schedules",
    )
    return db


def claim_schedule(
    db: Session, identity: UUID, *, now: datetime, manual: bool = False
) -> WorkClaim:
    work = db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.kind == WorkKind.COMMS_SCHEDULED_MESSAGE,
            ScheduledWork.comms_schedule_id == identity,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if work is None or not (
        work.state == WorkState.PENDING
        and (manual or work.next_attempt_at <= now)
        or work.state == WorkState.RUNNING
        and work.lease_expires_at is not None
        and work.lease_expires_at <= now
    ):
        raise StaleClaim("Schedule is not claimable")
    if work.attempt_count >= MAX_ATTEMPTS:
        work.state, work.failure_code, work.finished_at = WorkState.FAILED, "unavailable", now
        work.lease_token = work.lease_expires_at = None
        raise StaleClaim("Schedule recovery exhausted")
    work.state = WorkState.RUNNING
    work.attempt_count += 1
    work.last_attempt_started_at = now
    work.lease_token, work.lease_expires_at = uuid7(), now + LEASE_DURATION
    return WorkClaim(work.id, work.lease_token)


def _locked_source(
    db: Session, claim: WorkClaim, identity: UUID
) -> tuple[CommsSchedule, ScheduledWork]:
    row = db.scalar(
        select(CommsSchedule)
        .where(
            CommsSchedule.org_id == bound_organization_column(),
            CommsSchedule.id == identity,
            CommsSchedule.is_deleted.is_(False),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    work = db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.id == claim.id,
            ScheduledWork.kind == WorkKind.COMMS_SCHEDULED_MESSAGE,
            ScheduledWork.comms_schedule_id == identity,
            ScheduledWork.state == WorkState.RUNNING,
            ScheduledWork.lease_token == claim.lease_token,
            ScheduledWork.lease_expires_at > utc_now(),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if (
        row is None
        or work is None
        or work.source_revision != row.revision
        or work.scheduling_actor_id != row.author_id
    ):
        raise StaleClaim("Claim or source is unavailable")
    return row, work


def _failure(error: Exception) -> str:
    if isinstance(error, HTTPException):
        if error.status_code in (401, 404):
            return "access_lost"
        if error.status_code in (403, 429):
            return "post_denied"
        if error.status_code in (409, 422):
            return "invalid_content"
    if isinstance(error, SendRateLimited):
        return "post_denied"
    if isinstance(error, InvalidSend | SendConflict):
        return "invalid_content"
    return "unavailable"


def execute_schedule_claim(
    engine: Engine, org: UUID, claim: WorkClaim, *, publish: Publish
) -> UUID | None:
    # A manual Send Now request must not make publication depend on its response/cancellation.
    context_token = request_events.set(None)
    identity = author_id = None
    try:
        with _session(engine, org) as db:
            initial = db.execute(
                select(CommsSchedule, ScheduledWork)
                .join(
                    ScheduledWork,
                    ScheduledWork.comms_schedule_id == CommsSchedule.id,
                )
                .where(
                    ScheduledWork.id == claim.id,
                    ScheduledWork.lease_token == claim.lease_token,
                    ScheduledWork.state == WorkState.RUNNING,
                    ScheduledWork.org_id == org,
                    CommsSchedule.org_id == org,
                )
            ).first()
            if initial is None:
                return None
            source, _work = initial
            identity, author_id = source.id, source.author_id
            original_request = deepcopy(source.request)
            db.info[AUDIT_CONTEXT_KEY].performed_by = author_id
            payload = CommsScheduleRequest.model_validate(source.request)
            author = db.get(User, author_id, populate_existing=True)
            if author is None:
                raise HTTPException(404, "Author unavailable")

            def authorize(_replay: bool) -> None:
                current, _ = _locked_source(db, claim, identity)
                if current.request != original_request:
                    raise StaleClaim("Claimed request changed")
                authorize_send(
                    db,
                    author,
                    payload.conversation_id,
                    send_request(payload),
                    parent_id=payload.parent_id,
                )

            def finalize(message: CommsMessage) -> None:
                _row, work = _locked_source(db, claim, identity)
                work.state, work.finished_at = WorkState.SUCCEEDED, utc_now()
                work.comms_message_id, work.failure_code = message.id, None
                work.lease_token = work.lease_expires_at = None
                user_event(db, author_id, "structure", {})

            command = SendMessageCommand(
                **payload.model_dump(exclude={"conversation_id", "send_at"})
            )
            result = send_message(
                db,
                org_id=org,
                author_id=author_id,
                conversation_id=payload.conversation_id,
                command=command,
                authorize=authorize,
                finalize=finalize,
            )
            events = take_committed_events(db)
            message_id = result.message.id
        publish(events)
        return message_id
    except StaleClaim:
        return None
    except Exception as error:
        if identity is None or author_id is None:
            raise
        with _session(engine, org, author_id) as db:
            try:
                _row, work = _locked_source(db, claim, identity)
            except StaleClaim:
                return None
            work.state, work.failure_code, work.finished_at = (
                WorkState.FAILED,
                _failure(error),
                utc_now(),
            )
            work.lease_token = work.lease_expires_at = None
            user_event(db, author_id, "structure", {})
            db.commit()
            events = take_committed_events(db)
        publish(events)
        return None
    finally:
        request_events.reset(context_token)


def execute_due_schedules(
    engine: Engine, org: UUID, *, publish: Publish, now: datetime | None = None
) -> None:
    current = now or utc_now()
    with _session(engine, org) as db:
        rows = list(
            db.scalars(
                select(ScheduledWork)
                .where(
                    ScheduledWork.org_id == org,
                    ScheduledWork.kind == WorkKind.COMMS_SCHEDULED_MESSAGE,
                    or_(
                        and_(
                            ScheduledWork.state == WorkState.PENDING,
                            ScheduledWork.next_attempt_at <= current,
                        ),
                        and_(
                            ScheduledWork.state == WorkState.RUNNING,
                            ScheduledWork.lease_expires_at <= current,
                        ),
                    ),
                )
                .order_by(ScheduledWork.next_attempt_at, ScheduledWork.id)
                .limit(5)
                .with_for_update(skip_locked=True)
            )
        )
        claims = []
        for row in rows:
            try:
                assert row.comms_schedule_id is not None
                claims.append(claim_schedule(db, row.comms_schedule_id, now=current))
            except StaleClaim:
                continue
        db.commit()
    for claim in claims:
        execute_schedule_claim(engine, org, claim, publish=publish)
