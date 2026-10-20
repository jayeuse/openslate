"""Current export-purpose admission and immutable-artifact cleanup; no ordinary read grant."""

import hashlib
import json
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import or_, select, true
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.conversations.models import CommsCategory, CommsConversation
from app.systems.comms.jobs.encoding import MAX_BYTES
from app.systems.comms.jobs.models import CommsExport, CommsExportEntry, CommsExportSource
from app.systems.comms.jobs.protected import admin
from app.systems.comms.jobs.schemas import CommsExportRequest, CommsExportResponse
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.mutations import lock_counter
from app.systems.comms.settings.resolution import Scope, resolve_settings
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.providers import ProviderUnavailable, StorageBackend, transfer_slot
from app.systems.platform.scheduling.models import ScheduledWork, WorkKind, WorkState


def private_source(room: CommsConversation) -> bool:
    return room.kind != "channel" or room.scope == "members"


def selected_sources(
    db: Session,
    actor: User,
    ids: list[UUID],
    *,
    lock: bool = False,
) -> dict[UUID, CommsConversation]:
    # D31 is a separate export-only exact-admin purpose, not D43 ordinary readability.
    admin(db, actor)
    if lock:
        db.scalar(
            select(WorkspaceProfile.id)
            .where(
                WorkspaceProfile.id == bound_organization_column(),
            )
            .with_for_update(read=True)
        )
        for identity in sorted(ids):
            lock_counter(db, identity)
        list(
            db.scalars(
                select(CommsConversation)
                .where(
                    CommsConversation.org_id == bound_organization_column(),
                    CommsConversation.id.in_(ids),
                )
                .order_by(CommsConversation.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
    rooms = {
        room.id: room
        for room in db.scalars(
            select(CommsConversation)
            .where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.id.in_(ids),
                CommsConversation.is_deleted.is_(False),
                CommsConversation.deleted_at.is_(None),
            )
            .execution_options(populate_existing=True)
        )
    }
    if set(rooms) != set(ids):
        raise error("comms_not_found", "Export source not found")
    if lock:
        category_ids = {room.category_id for room in rooms.values() if room.category_id is not None}
        list(
            db.scalars(
                select(CommsCategory.id)
                .where(
                    CommsCategory.org_id == bound_organization_column(),
                    CommsCategory.id.in_(category_ids),
                )
                .order_by(CommsCategory.id)
                .with_for_update(read=True)
            )
        )
    for room in rooms.values():
        scope: Scope = (
            {"kind": "channel", "id": room.id} if room.kind == "channel" else {"kind": "workspace"}
        )
        if not resolve_settings(db, scope)["effective"]["allow_export"]:
            raise error("comms_capability_denied", "Export is not allowed for this source", 403)
    return rooms


def authorization_digest(
    org: UUID, identity: UUID, actor: UUID, request: dict[str, Any], private_ids: list[UUID]
) -> str:
    value = {
        "purpose": "comms-export-v1",
        "org": str(org),
        "export": str(identity),
        "actor": str(actor),
        "request": request,
        "private_sources": sorted(map(str, private_ids)),
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def load(
    db: Session,
    identity: UUID,
    *,
    lock: bool = False,
) -> tuple[CommsExport, ScheduledWork]:
    query = select(CommsExport).where(
        CommsExport.org_id == bound_organization_column(),
        CommsExport.id == identity,
        CommsExport.is_deleted.is_(False),
    )
    query = query.execution_options(populate_existing=True)
    job = db.scalar(query.with_for_update() if lock else query)
    if job is None:
        raise error("comms_not_found", "Export not found")
    query_work = (
        select(ScheduledWork)
        .where(
            ScheduledWork.org_id == bound_organization_column(),
            ScheduledWork.comms_export_id == identity,
            ScheduledWork.kind == WorkKind.COMMS_EXPORT,
        )
        .execution_options(populate_existing=True)
    )
    work = db.scalar(query_work.with_for_update() if lock else query_work)
    if work is None:
        raise error("comms_not_found", "Export not found")
    return job, work


def current_sources(
    db: Session,
    actor: User,
    job: CommsExport,
    *,
    lock: bool = False,
) -> dict[UUID, CommsConversation]:
    request = CommsExportRequest.model_validate(job.request)
    captures = list(
        db.scalars(
            select(CommsExportSource).where(
                CommsExportSource.org_id == bound_organization_column(),
                CommsExportSource.export_id == job.id,
            )
        )
    )
    private_ids = [row.conversation_id for row in captures if row.private_at_capture]
    if (
        set(row.conversation_id for row in captures) != set(request.conversation_ids)
        or authorization_digest(job.org_id, job.id, job.requested_by, job.request, private_ids)
        != job.authorization_digest
    ):
        raise error("comms_not_found", "Captured export authority is unavailable")
    rooms = selected_sources(db, actor, request.conversation_ids, lock=lock)
    if private_ids and (not job.private_verified or not request.reason):
        raise error("comms_capability_denied", "Captured private export proof is unavailable", 403)
    if any(private_source(room) and room.id not in private_ids for room in rooms.values()):
        raise error("comms_capability_denied", "The source now requires a new private export", 403)
    unavailable = db.scalar(
        select(CommsExportEntry.id)
        .join(
            CommsMessage,
            (
                (CommsMessage.org_id == CommsExportEntry.org_id)
                & (CommsMessage.id == CommsExportEntry.message_id)
                & (CommsMessage.conversation_id == CommsExportEntry.conversation_id)
            ),
        )
        .where(
            CommsExportEntry.org_id == bound_organization_column(),
            CommsExportEntry.export_id == job.id,
            or_(
                CommsMessage.is_deleted.is_(True),
                CommsMessage.deleted_at.is_not(None),
                CommsMessage.retention_erased_at.is_not(None),
            ),
        )
        .limit(1)
    )
    if unavailable is not None:
        raise error("comms_not_found", "Captured message content is unavailable")
    return rooms


def response(job: CommsExport, work: ScheduledWork) -> CommsExportResponse:
    return CommsExportResponse.model_validate(
        {
            "id": job.id,
            "org_id": job.org_id,
            "requested_by": job.requested_by,
            "created_at": job.created_at,
            "updated_at": max(job.updated_at, work.updated_at),
            "request": job.request,
            "status": "cancelled" if work.state == WorkState.CANCELED else work.state,
            "failure_code": None
            if work.failure_code is None
            else ("access_lost" if work.failure_code == "access_lost" else "unavailable"),
        }
    )


def retire(
    db: Session,
    identities: list[UUID],
    *,
    now: datetime,
    message_ids: list[UUID] | None = None,
) -> None:
    """Stage revocation and cleanup intent before releasing captured message references."""
    for identity in sorted(set(identities)):
        job, work = load(db, identity, lock=True)
        if work.state == WorkState.RUNNING and work.lease_expires_at is not None:
            job.cleanup_after = max(now, work.lease_expires_at)
        elif job.cleanup_after is None:
            job.cleanup_after = now
        job.cleanup_pending = job.artifact_key is not None
        work.state, work.failure_code, work.finished_at = WorkState.FAILED, "access_lost", now
        work.lease_token = work.lease_expires_at = None
        for row in db.scalars(
            select(CommsExportEntry)
            .where(
                CommsExportEntry.org_id == bound_organization_column(),
                CommsExportEntry.export_id == identity,
                CommsExportEntry.message_id.in_(message_ids) if message_ids is not None else true(),
            )
            .order_by(CommsExportEntry.id)
        ):
            db.delete(row)
    db.flush()


def cleanup_artifact(
    db: Session,
    identity: UUID,
    storage: StorageBackend,
    *,
    now: datetime | None = None,
) -> bool:
    """Own commits around I/O; an unknown upload is not confirmed absence."""
    current = now or utc_now()
    job, _ = load(db, identity, lock=True)
    if not job.cleanup_pending:
        db.commit()
        return True
    if job.cleanup_after is not None and job.cleanup_after > current:
        db.commit()
        return False
    key, size, digest, confirmed = (
        job.artifact_key,
        job.artifact_size,
        job.artifact_sha256,
        job.artifact_upload_confirmed,
    )
    db.commit()
    if key is None or size is None or digest is None or not 0 <= size <= MAX_BYTES:
        raise ProviderUnavailable("Artifact cleanup metadata is unavailable")
    with transfer_slot():
        content = storage.download(key)
        if content is None and not confirmed:
            return False  # A failed/abandoned upload may still have an unknown provider outcome.
        if content is not None:
            if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
                raise ProviderUnavailable("Artifact ownership could not be confirmed")
            storage.delete(key)
            if storage.download(key) is not None:
                raise ProviderUnavailable("Artifact deletion is unconfirmed")
    completed = db.scalar(select(CommsExport).where(
        CommsExport.org_id == bound_organization_column(), CommsExport.id == identity,
    ).with_for_update().execution_options(populate_existing=True))
    # A competing poll/purge may already have committed this confirmed deletion.
    if completed is None or (completed.artifact_key is None and not completed.cleanup_pending):
        db.commit()
        return True
    job = completed
    if job.artifact_key != key or job.artifact_sha256 != digest or not job.cleanup_pending:
        db.rollback()
        raise ProviderUnavailable("Artifact cleanup changed")
    job.artifact_key = job.artifact_size = job.artifact_sha256 = None
    job.artifact_upload_confirmed = job.cleanup_pending = False
    job.cleanup_after = None
    db.commit()
    return True
