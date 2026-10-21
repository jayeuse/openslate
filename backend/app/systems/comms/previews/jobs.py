"""Existing durable work owns optional previews; no network or copied URLs in request/work rows."""

from collections.abc import Callable, Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Engine, Select, and_, or_, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column, scope_session
from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.comms.access import require_conversation_access
from app.systems.comms.conversations import service as conversations
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.mutations import lock_counter
from app.systems.comms.previews.metadata import validated
from app.systems.comms.previews.process import fetch_bounded
from app.systems.comms.previews.urls import first_url
from app.systems.comms.realtime.events import message_event
from app.systems.comms.realtime.grants import lock_projection
from app.systems.comms.realtime.publication import request_events, take_committed_events
from app.systems.comms.settings import service as settings
from app.systems.comms.settings.resolution import Scope, resolve_settings
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
from app.systems.platform.scheduling.service import LEASE_DURATION, MAX_ATTEMPTS, WorkClaim

Fetcher = Callable[[str], dict[str, str] | None]
Publish = Callable[[list[dict[str, Any]]], None]


class StalePreview(RuntimeError):
    pass


@dataclass(frozen=True, repr=False)
class Source:
    message_id: UUID
    generation: int
    author_id: UUID
    url: str
    settings_tag: str
    conversation_tag: str


def _scope(room: CommsConversation) -> Scope:
    return {"kind": "channel", "id": room.id} if room.kind == "channel" else {"kind": "workspace"}


def stage_preview(db: Session, message: CommsMessage) -> None:
    """Caller owns the canonical message lock/commit; enqueue never performs DNS or HTTP."""
    for row in db.scalars(
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == message.org_id,
            ScheduledWork.kind == WorkKind.COMMS_LINK_PREVIEW,
            ScheduledWork.comms_preview_message_id == message.id,
            ScheduledWork.comms_preview_generation != message.mutation_generation,
            ScheduledWork.state.in_([WorkState.PENDING, WorkState.RUNNING]),
        )
        .with_for_update()
    ):
        row.state, row.finished_at, row.failure_code = (
            WorkState.CANCELED,
            utc_now(),
            "source_unavailable",
        )
        row.lease_token = row.lease_expires_at = None
    db.flush()
    if (
        message.is_deleted
        or message.deleted_at is not None
        or message.retention_erased_at is not None
    ):
        return
    if first_url(message.body) is None:
        return
    room = db.scalar(
        select(CommsConversation).where(
            CommsConversation.org_id == message.org_id,
            CommsConversation.id == message.conversation_id,
        )
    )
    if (
        room is None
        or room.archived_at is not None
        or not resolve_settings(db, _scope(room))["effective"]["link_previews"]
    ):
        return
    if (
        db.scalar(
            select(ScheduledWork.id).where(
                ScheduledWork.org_id == message.org_id,
                ScheduledWork.kind == WorkKind.COMMS_LINK_PREVIEW,
                ScheduledWork.comms_preview_message_id == message.id,
                ScheduledWork.comms_preview_generation == message.mutation_generation,
            )
        )
        is not None
    ):
        return
    db.add(
        ScheduledWork(
            org_id=message.org_id,
            kind=WorkKind.COMMS_LINK_PREVIEW,
            comms_preview_message_id=message.id,
            comms_preview_generation=message.mutation_generation,
            scheduling_actor_id=message.author_id,
            scheduled_for=utc_now(),
            next_attempt_at=utc_now(),
        )
    )


def discard_preview_work(db: Session, identities: Collection[UUID] | Select[tuple[UUID]]) -> None:
    from app.systems.comms.moderation.purge import _delete_batches

    _delete_batches(
        db,
        ScheduledWork,
        (ScheduledWork.org_id == bound_organization_column())
        & (ScheduledWork.kind == WorkKind.COMMS_LINK_PREVIEW)
        & ScheduledWork.comms_preview_message_id.in_(identities),
    )


def _session(engine: Engine, org: UUID) -> AuditSession:
    db = AuditSession(engine)
    scope_session(db, org)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(), request_method="PREVIEW", request_path="/internal/comms/link-previews"
    )
    return db


def claim_preview(db: Session, identity: UUID, *, now: datetime) -> WorkClaim | None:
    row = db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.id == identity,
            ScheduledWork.kind == WorkKind.COMMS_LINK_PREVIEW,
        )
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )
    if row is None or not (
        row.state == WorkState.PENDING
        and row.next_attempt_at <= now
        or row.state == WorkState.RUNNING
        and row.lease_expires_at is not None
        and row.lease_expires_at <= now
    ):
        return None
    if row.attempt_count >= MAX_ATTEMPTS:
        row.state, row.finished_at, row.failure_code = WorkState.FAILED, now, "preview_unavailable"
        row.lease_token = row.lease_expires_at = None
        return None
    row.state, row.last_attempt_started_at = WorkState.RUNNING, now
    row.attempt_count += 1
    row.lease_token, row.lease_expires_at = uuid7(), now + LEASE_DURATION
    return WorkClaim(row.id, row.lease_token)


def _work(db: Session, claim: WorkClaim, *, lock: bool = False) -> ScheduledWork:
    query = (
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.id == claim.id,
            ScheduledWork.kind == WorkKind.COMMS_LINK_PREVIEW,
            ScheduledWork.state == WorkState.RUNNING,
            ScheduledWork.lease_token == claim.lease_token,
            ScheduledWork.lease_expires_at > utc_now(),
        )
        .execution_options(populate_existing=True)
    )
    row = db.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise StalePreview()
    return row


def _source(db: AuditSession, claim: WorkClaim) -> tuple[Source, CommsMessage, ScheduledWork]:
    work = _work(db, claim)
    message = db.scalar(
        select(CommsMessage).where(
            CommsMessage.org_id == bound_organization_column(),
            CommsMessage.id == work.comms_preview_message_id,
        )
    )
    if message is None:
        raise StalePreview()
    identity, conversation = message.id, message.conversation_id
    lock_projection(db)
    lock_counter(db, conversation)
    author = db.get(User, message.author_id, populate_existing=True)
    if author is None:
        raise StalePreview()
    room = require_conversation_access(db, author, conversation, "read")
    scope = _scope(room)
    settings.lock_scope(db, author, scope, write=False)
    message = db.scalar(
        select(CommsMessage)
        .where(
            CommsMessage.org_id == bound_organization_column(),
            CommsMessage.id == identity,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    work = _work(db, claim, lock=True)
    org_live = db.scalar(
        select(WorkspaceProfile.id).where(
            WorkspaceProfile.id == bound_organization_column(),
            WorkspaceProfile.is_deleted.is_(False),
            WorkspaceProfile.deleted_at.is_(None),
        )
    )
    if (
        message is None
        or org_live is None
        or room.is_deleted
        or room.archived_at is not None
        or message.is_deleted
        or message.deleted_at is not None
        or message.retention_erased_at is not None
        or message.mutation_generation != work.comms_preview_generation
        or work.scheduling_actor_id != message.author_id
        or not resolve_settings(db, scope)["effective"]["link_previews"]
    ):
        raise StalePreview()
    url = first_url(message.body)
    if url is None:
        raise StalePreview()
    db.info[AUDIT_CONTEXT_KEY].performed_by = message.author_id
    return (
        Source(
            message.id,
            message.mutation_generation,
            message.author_id,
            url,
            settings.version(db, scope),
            conversations.version(db, room),
        ),
        message,
        work,
    )


def _terminal(engine: Engine, org: UUID, claim: WorkClaim, *, stale: bool) -> None:
    with _session(engine, org) as db:
        try:
            work = _work(db, claim, lock=True)
        except StalePreview:
            return
        work.state = WorkState.CANCELED if stale else WorkState.FAILED
        work.failure_code = "source_unavailable" if stale else "preview_unavailable"
        work.finished_at = utc_now()
        work.lease_token = work.lease_expires_at = None
        db.commit()


def execute_preview_claim(
    engine: Engine,
    org: UUID,
    claim: WorkClaim | None,
    *,
    publish: Publish,
    fetch: Fetcher | None = None,
) -> None:
    if claim is None:
        return
    context = request_events.set(None)
    try:
        with _session(engine, org) as db:
            captured, _message, _row = _source(db, claim)
            db.rollback()  # No SQL lock/session or request credential crosses external I/O.
        data = (fetch or fetch_bounded)(captured.url)
        metadata = validated(data, captured.url)
        if metadata is None:
            _terminal(engine, org, claim, stale=False)
            return
        with _session(engine, org) as db:
            current, message, work = _source(db, claim)
            if current != captured:
                raise StalePreview()
            message.link_previews = [metadata]
            message.link_preview_generation = current.generation
            work.state, work.finished_at, work.failure_code = WorkState.SUCCEEDED, utc_now(), None
            work.lease_token = work.lease_expires_at = None
            message_event(db, message.conversation_id, message.seq, "edited")
            db.commit()
            events = take_committed_events(db)
        publish(events)
    except (StalePreview, HTTPException):
        _terminal(engine, org, claim, stale=True)
    except Exception:
        _terminal(
            engine, org, claim, stale=False
        )  # Never log an upstream exception or private URL.
    finally:
        request_events.reset(context)


def run_preview_job(
    engine: Engine,
    org: UUID,
    identity: UUID,
    *,
    publish: Publish,
    fetch: Fetcher | None = None,
    now: datetime | None = None,
) -> None:
    with _session(engine, org) as db:
        claim = claim_preview(db, identity, now=now or utc_now())
        db.commit()
    execute_preview_claim(engine, org, claim, publish=publish, fetch=fetch)


def execute_due_previews(
    engine: Engine, org: UUID, *, publish: Publish, now: datetime | None = None
) -> None:
    current = now or utc_now()
    with _session(engine, org) as db:
        identity = db.scalar(
            select(ScheduledWork.id)
            .where(
                ScheduledWork.org_id == org,
                ScheduledWork.kind == WorkKind.COMMS_LINK_PREVIEW,
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
            .limit(1)
        )
    if identity is not None:
        run_preview_job(engine, org, identity, publish=publish, now=current)
