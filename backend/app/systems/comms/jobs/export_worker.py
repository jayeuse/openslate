"""Durable export claims on ScheduledWork; metadata is committed before immutable Storage I/O."""

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime, time, timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Engine, and_, or_, select
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column, scope_session
from app.core.database.session import AuditSession
from app.core.observability import failure_cause, log_event
from app.systems.access.users.models import User
from app.systems.comms.jobs import export_service as service
from app.systems.comms.jobs.encoding import MIME, ExportTooLarge, encode
from app.systems.comms.jobs.models import CommsExport, CommsExportEntry
from app.systems.comms.jobs.schemas import CommsExportRequest
from app.systems.comms.messages.models import CommsMessage
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.files.providers import ProviderUnavailable, StorageBackend, transfer_slot
from app.systems.platform.files.storage import get_storage
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState
from app.systems.platform.scheduling.service import LEASE_DURATION, MAX_ATTEMPTS, WorkClaim


class ExportClaimLost(RuntimeError):
    pass


def _session(engine: Engine, org: UUID, actor: UUID | None = None) -> AuditSession:
    db = AuditSession(engine)
    scope_session(db, org)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=actor,
        request_id=uuid7(),
        request_method="EXPORT",
        request_path="/internal/comms/exports",
    )
    return db


def _claim(db: AuditSession, identity: UUID, now: datetime) -> WorkClaim | None:
    work = db.scalar(
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.kind == WorkKind.COMMS_EXPORT,
            ScheduledWork.comms_export_id == identity,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if work is None or not (
        work.state == WorkState.PENDING
        or (
            work.state == WorkState.RUNNING
            and work.lease_expires_at is not None
            and work.lease_expires_at <= now
        )
    ):
        return None
    if work.attempt_count >= MAX_ATTEMPTS:
        work.state, work.finished_at, work.failure_code = WorkState.FAILED, now, "unavailable"
        work.lease_token = work.lease_expires_at = None
        return None
    work.state, work.last_attempt_started_at = WorkState.RUNNING, now
    work.attempt_count += 1
    work.lease_token, work.lease_expires_at = uuid7(), now + LEASE_DURATION
    return WorkClaim(work.id, work.lease_token)


def _locked(
    db: AuditSession,
    identity: UUID,
    claim: WorkClaim,
) -> tuple[CommsExport, ScheduledWork, User]:
    job, _ = service.load(db, identity)
    actor = db.get(User, job.requested_by, populate_existing=True)
    if actor is None:
        raise HTTPException(404, "Requester unavailable")
    # Source/administrator locks precede the job/work locks, matching lifecycle writers.
    service.current_sources(db, actor, job, lock=True)
    job, work = service.load(db, identity, lock=True)
    if (
        work.id != claim.id
        or work.lease_token != claim.lease_token
        or work.state != WorkState.RUNNING
        or work.lease_expires_at is None
        or work.lease_expires_at <= utc_now()
        or job.cleanup_pending
        or work.scheduling_actor_id != job.requested_by
    ):
        raise ExportClaimLost()
    db.info[AUDIT_CONTEXT_KEY].performed_by = actor.id
    return job, work, actor


def _message_rows(db: AuditSession, job: CommsExport, actor: User) -> Iterator[dict[str, str]]:
    request = CommsExportRequest.model_validate(job.request)
    rooms = service.current_sources(db, actor, job)
    m = CommsMessage
    query = (
        select(
            m.id,
            m.conversation_id,
            m.seq,
            m.author_id,
            m.created_at,
            m.parent_id,
            m.body,
            User.display_name,
            User.username,
        )
        .join(User, User.id == m.author_id)
        .where(
            m.org_id == job.org_id,
            m.conversation_id.in_(request.conversation_ids),
            m.is_deleted.is_(False),
            m.deleted_at.is_(None),
            m.retention_erased_at.is_(None),
        )
    )
    if request.after is not None:
        query = query.where(m.created_at >= datetime.combine(request.after, time.min, UTC))
    if request.before is not None:
        query = query.where(m.created_at < datetime.combine(request.before, time.min, UTC))
    statement = query.order_by(m.conversation_id, m.seq, m.id).execution_options(yield_per=500)
    for partition in db.execute(statement).partitions(500):
        for row in partition:
            room = rooms[row.conversation_id]
            db.add(
                CommsExportEntry(
                    org_id=job.org_id,
                    export_id=job.id,
                    conversation_id=row.conversation_id,
                    message_id=row.id,
                )
            )
            yield {
                "conversation_id": str(room.id),
                "conversation": room.name if room.kind != "direct" else "Direct conversation",
                "message_id": str(row.id),
                "sequence": str(row.seq),
                "author_id": str(row.author_id),
                "author": row.display_name or row.username,
                "created_at": row.created_at.isoformat(),
                "parent_id": str(row.parent_id) if row.parent_id else "",
                "body": row.body,
            }
        db.flush()


def _failed(
    engine: Engine,
    org: UUID,
    identity: UUID,
    claim: WorkClaim,
    failure: Exception,
) -> None:
    with _session(engine, org) as db:
        try:
            job, work = service.load(db, identity, lock=True)
        except HTTPException:
            return
        if work.state != WorkState.RUNNING or work.lease_token != claim.lease_token:
            return
        db.info[AUDIT_CONTEXT_KEY].performed_by = job.requested_by
        job.cleanup_pending = job.artifact_key is not None
        job.cleanup_after = work.lease_expires_at if job.cleanup_pending else None
        work.state, work.finished_at = WorkState.FAILED, utc_now()
        work.failure_code = (
            "access_lost"
            if isinstance(failure, HTTPException) and failure.status_code in (401, 403, 404)
            else "export_limit_exceeded"
            if isinstance(failure, ExportTooLarge)
            else "unavailable"
        )
        work.lease_token = work.lease_expires_at = None
        db.commit()
    log_event(
        "operational_attention",
        reason_code="comms_export_failed",
        upstream="comms-jobs",
        org_id=org,
        cause=failure_cause(failure),
    )


def run_export_job(
    engine: Engine,
    org: UUID,
    identity: UUID,
    *,
    storage: StorageBackend | None = None,
    now: datetime | None = None,
) -> None:
    current, provider = now or utc_now(), storage or get_storage()
    with _session(engine, org) as db:
        claim = _claim(db, identity, current)
        db.commit()
    if claim is None:
        return
    try:
        with _session(engine, org) as db:
            job, work, actor = _locked(db, identity, claim)
            format = CommsExportRequest.model_validate(job.request).format
            content = None
            if job.artifact_key is None:
                assert work.lease_expires_at is not None
                # Reserve provider time inside the lease; never extend it to hide slow work.
                content = encode(
                    format,
                    _message_rows(db, job, actor),
                    deadline=work.lease_expires_at - timedelta(seconds=30),
                )
                service.current_sources(db, actor, job)
                job.artifact_key = f"org/{org}/{job.id.hex}"
                job.artifact_size = len(content)
                job.artifact_sha256 = hashlib.sha256(content).hexdigest()
                db.commit()
            key, size, digest = job.artifact_key, job.artifact_size, job.artifact_sha256
            assert key is not None and size is not None and digest is not None
            db.rollback()
        with transfer_slot():
            if content is not None:
                # Recovery verifies this immutable object, never regenerates a different snapshot.
                with _session(engine, org) as db:
                    _locked(db, identity, claim)
                    db.rollback()
                provider.upload(key, content, MIME[format])
            retained = provider.download(key)
        if (
            retained is None
            or len(retained) != size
            or hashlib.sha256(retained).hexdigest() != digest
        ):
            raise ProviderUnavailable("Export upload outcome is unconfirmed")
        with _session(engine, org) as db:
            job, work, _ = _locked(db, identity, claim)
            job.artifact_upload_confirmed = True
            work.state, work.finished_at, work.failure_code = WorkState.SUCCEEDED, utc_now(), None
            work.lease_token = work.lease_expires_at = None
            db.commit()
    except ExportClaimLost:
        return
    except Exception as failure:
        _failed(engine, org, identity, claim, failure)


def execute_due_exports(engine: Engine, org: UUID, *, now: datetime | None = None) -> None:
    current = now or utc_now()
    # Failed/retired artifacts need recovery even when the org keeps all messages forever.
    with _session(engine, org) as db:
        pending = list(
            db.scalars(
                select(CommsExport.id)
                .where(
                    CommsExport.org_id == org,
                    CommsExport.cleanup_pending.is_(True),
                    or_(CommsExport.cleanup_after.is_(None), CommsExport.cleanup_after <= current),
                )
                .order_by(CommsExport.cleanup_after, CommsExport.id)
                .limit(10)
            )
        )
    cleanup_failed = False
    for identity in pending:
        with _session(engine, org) as db:
            try:
                complete = service.cleanup_artifact(db, identity, get_storage(), now=current)
            except (HTTPException, ProviderUnavailable):
                db.rollback()
                complete = False
            if not complete:
                job, _ = service.load(db, identity, lock=True)
                job.cleanup_after = current + timedelta(seconds=60)
                db.commit()
                cleanup_failed = True
    with _session(engine, org) as db:
        identities = list(
            db.scalars(
                select(ScheduledWork.comms_export_id)
                .where(
                    ScheduledWork.org_id == org,
                    ScheduledWork.kind == WorkKind.COMMS_EXPORT,
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
        )
    for export_id in identities:
        if export_id is not None:
            run_export_job(engine, org, export_id, now=current)
    if cleanup_failed:
        raise ProviderUnavailable("Export artifact cleanup remains unconfirmed")
