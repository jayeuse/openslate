"""Daily per-organization bounded erasure, irreversible anchors and truthful cleanup proofs."""

import hashlib
import json
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Engine, exists, false, or_, select, true
from sqlalchemy.orm import aliased, selectinload
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.jobs import export_service, retention, retention_files
from app.systems.comms.jobs.models import (
    CommsExpiredSend,
    CommsExport,
    CommsExportEntry,
    CommsRetentionPolicy,
    CommsRetentionSweep,
    CommsSchedule,
)
from app.systems.comms.jobs.schedule_worker import Publish
from app.systems.comms.messages.interaction_models import (
    CommsMention,
    CommsReaction,
    CommsThread,
    CommsThreadFollow,
)
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision
from app.systems.comms.messages.mutations import advance_generation, lock_counter
from app.systems.comms.moderation.models import CommsReport
from app.systems.comms.moderation.purge import _delete_batches
from app.systems.comms.previews.jobs import discard_preview_work
from app.systems.comms.realtime.events import message_event, user_event
from app.systems.comms.realtime.publication import request_events, take_committed_events
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable, StorageBackend
from app.systems.platform.files.storage import get_storage
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork

MESSAGE_BATCH = 100


def _session(engine: Engine, org: UUID) -> AuditSession:
    db = AuditSession(engine)
    scope_session(db, org)
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="RETENTION",
        request_path="/internal/comms/retention",
        actor_label="Scheduled Comms retention",
    )
    return db


def _periods(
    policies: dict[UUID | None, CommsRetentionPolicy], room: CommsConversation
) -> tuple[int, int, UUID | None]:
    workspace = policies.get(None)
    local = policies.get(room.id) if room.kind == "channel" else None
    values = []
    for field in ("message_days", "file_days"):
        value = getattr(local, field) if local else None
        values.append(
            value if value is not None else (getattr(workspace, field) if workspace else 0)
        )
    return (
        values[0],
        values[1],
        local.author_id if local else workspace.author_id if workspace else None,
    )


def _erase(
    db: AuditSession,
    room: CommsConversation,
    message_cutoff: datetime | None,
    file_cutoff: datetime | None,
    now: datetime,
) -> tuple[int, bool]:
    lock_counter(db, room.id)
    db.scalar(
        select(CommsConversation)
        .where(
            CommsConversation.org_id == room.org_id,
            CommsConversation.id == room.id,
        )
        .with_for_update()
    )
    messages = list(
        db.scalars(
            select(CommsMessage)
            .where(
                CommsMessage.org_id == room.org_id,
                CommsMessage.conversation_id == room.id,
                CommsMessage.retention_erased_at.is_(None),
                CommsMessage.created_at < message_cutoff if message_cutoff is not None else false(),
            )
            .order_by(CommsMessage.seq)
            .limit(MESSAGE_BATCH)
            .with_for_update()
        )
    )
    ids = [message.id for message in messages]
    discard_preview_work(db, ids)
    attachments = select(CommsMessageAttachment.file_id).where(
        CommsMessageAttachment.org_id == room.org_id,
        CommsMessageAttachment.message_id.in_(ids),
    )
    attached = list(
        db.scalars(
            select(File)
            .where(
                File.org_id == room.org_id,
                File.conversation_id == room.id,
                File.purpose == "comms_attachment",
                File.retention_erased_at.is_(None),
                File.id.in_(attachments),
            )
            .order_by(File.id)
            .with_for_update()
        )
    )
    files = attached + list(
        db.scalars(
            select(File)
            .where(
                File.org_id == room.org_id,
                File.conversation_id == room.id,
                File.purpose == "comms_attachment",
                File.retention_erased_at.is_(None),
                File.id.not_in([row.id for row in attached]),
                File.created_at < file_cutoff if file_cutoff is not None else false(),
            )
            .order_by(File.id)
            .limit(max(0, 1000 - len(attached)))
            .with_for_update()
        )
    )
    for file in files:
        _delete_batches(
            db,
            CommsMessageAttachment,
            (CommsMessageAttachment.org_id == room.org_id)
            & (CommsMessageAttachment.file_id == file.id)
            & CommsMessageAttachment.message_id.in_(
                select(CommsMessage.id).where(
                    CommsMessage.org_id == room.org_id, CommsMessage.conversation_id == room.id
                )
            ),
        )
        retention_files.mark_file(db, file, now)
    for message in messages:
        if db.get(CommsExpiredSend, message.id) is None:
            db.add(
                CommsExpiredSend(
                    id=message.id,
                    org_id=room.org_id,
                    conversation_id=room.id,
                    author_id=message.author_id,
                    client_key=message.client_key,
                )
            )
        advance_generation(message)
        message.body = ""
        message.is_deleted, message.deleted_at = True, message.deleted_at or now
        message.retention_erased_at, message.deleted_by = now, None
        message.mentions_channel = message.mentions_here = False
        message.pinned_at = message.pinned_by = None
        message_event(db, room.id, message.seq, "deleted")
    for thread in db.scalars(
        select(CommsThread).where(
            CommsThread.org_id == room.org_id,
            CommsThread.root_message_id.in_(ids),
        )
    ):
        thread.name = ""
    # A completed schedule's request is also a copy of the expired message content.
    schedule_ids = set(
        db.scalars(
            select(CommsSchedule.id)
            .join(
                CommsMessage,
                (
                    (CommsMessage.org_id == CommsSchedule.org_id)
                    & (CommsMessage.author_id == CommsSchedule.author_id)
                    & (CommsMessage.client_key == CommsSchedule.client_key)
                ),
            )
            .where(CommsMessage.id.in_(ids), CommsMessage.org_id == room.org_id)
        )
    )
    schedule_ids.update(
        identity
        for identity in db.scalars(
            select(ScheduledWork.comms_schedule_id).where(
                ScheduledWork.org_id == room.org_id,
                ScheduledWork.comms_message_id.in_(ids),
            )
        )
        if identity is not None
    )
    _delete_batches(
        db,
        ScheduledWork,
        (ScheduledWork.org_id == room.org_id) & ScheduledWork.comms_schedule_id.in_(schedule_ids),
    )
    _delete_batches(db, CommsSchedule, CommsSchedule.id.in_(schedule_ids))
    for notice in db.scalars(
        select(InAppNotification).where(
            InAppNotification.org_id == room.org_id,
            InAppNotification.subject_type == "comms_message",
            InAppNotification.subject_id.in_(ids),
        )
    ):
        user_event(db, notice.recipient_id, "notification", {"id": str(notice.id)})
        db.delete(notice)
    db.flush()
    for child in (
        CommsMessageRevision,
        CommsMention,
        CommsReaction,
        CommsMessageAttachment,
        CommsMessageRecordLink,
        CommsReport,
    ):
        _delete_batches(db, child, (child.org_id == room.org_id) & child.message_id.in_(ids))
    return len(messages), len(messages) < MESSAGE_BATCH and len(files) < 1000


def _retire_captures(db: AuditSession, org: UUID, now: datetime) -> bool:
    pairs = db.execute(
        select(CommsExportEntry.export_id, CommsExportEntry.message_id)
        .join(
            CommsMessage,
            CommsMessage.id == CommsExportEntry.message_id,
        )
        .where(
            CommsExportEntry.org_id == org,
            CommsMessage.org_id == org,
            CommsMessage.retention_erased_at.is_not(None),
        )
        .limit(1000)
    ).all()
    for identity in sorted({row.export_id for row in pairs}):
        export_service.retire(
            db,
            [identity],
            now=now,
            message_ids=[row.message_id for row in pairs if row.export_id == identity],
        )
    return bool(pairs)


def _gc(db: AuditSession, org: UUID) -> int:
    other = aliased(CommsMessage)
    targets = list(
        db.scalars(
            select(CommsMessage)
            .where(
                CommsMessage.org_id == org,
                CommsMessage.retention_erased_at.is_not(None),
                ~exists(
                    select(other.id).where(
                        other.org_id == org,
                        or_(
                            other.parent_id == CommsMessage.id, other.reply_to_id == CommsMessage.id
                        ),
                    )
                ),
                ~exists(
                    select(CommsExportEntry.id).where(
                        CommsExportEntry.org_id == org,
                        CommsExportEntry.message_id == CommsMessage.id,
                    )
                ),
            )
            .order_by(CommsMessage.id)
            .limit(MESSAGE_BATCH)
        )
    )
    removed = 0
    for target in targets:
        lock_counter(db, target.conversation_id)
        message = db.scalar(
            select(CommsMessage)
            .where(CommsMessage.org_id == org, CommsMessage.id == target.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if (
            message is None
            or db.scalar(
                select(other.id)
                .where(
                    other.org_id == org,
                    or_(other.parent_id == message.id, other.reply_to_id == message.id),
                )
                .limit(1)
            )
            is not None
        ):
            continue
        for child in (CommsThreadFollow, CommsThread):
            _delete_batches(
                db, child, (child.org_id == org) & (child.root_message_id == message.id)
            )
        # Only identity/linkage is left; eager relationships retain the S22 no-N+1 deletion path.
        current = db.scalar(
            select(CommsMessage)
            .where(CommsMessage.org_id == org, CommsMessage.id == message.id)
            .options(
                selectinload(CommsMessage.conversation),
                selectinload(CommsMessage.parent),
                selectinload(CommsMessage.reply_to),
            )
        )
        assert current is not None
        message_event(db, current.conversation_id, current.seq, "deleted")
        db.delete(current)
        db.flush()
        removed += 1
    return removed


def run_retention_batch(
    engine: Engine,
    org: UUID,
    *,
    publish: Publish,
    now: datetime | None = None,
    storage: StorageBackend | None = None,
) -> dict[str, object]:
    current, provider = now or utc_now(), storage or get_storage()
    token = request_events.set(None)
    try:
        with _session(engine, org) as db:
            retention.lock_policy(db)
            policies = retention.rows(db)
            actor = next((row.author_id for row in policies.values()), None)
            if actor is None:
                return {"complete": True}
            db.info[AUDIT_CONTEXT_KEY].performed_by = actor
            digest = hashlib.sha256(
                json.dumps(
                    sorted(
                        (str(key), row.revision, row.message_days, row.file_days)
                        for key, row in policies.items()
                    )
                ).encode()
            ).hexdigest()
            proof = db.scalar(
                select(CommsRetentionSweep)
                .where(
                    CommsRetentionSweep.org_id == org,
                    CommsRetentionSweep.day == current.date(),
                    CommsRetentionSweep.policy_digest == digest,
                )
                .with_for_update()
            )
            if proof is None:
                proof = CommsRetentionSweep(org_id=org, day=current.date(), policy_digest=digest)
                db.add(proof)
                db.flush()
            if proof.finished_at is not None:
                return {"complete": True}
            proof_id = proof.id
            file_cursor, export_cursor = proof.file_cursor_id, proof.export_cursor_id
            for _ in range(10):
                if proof.erasure_done:
                    break
                room = db.scalar(
                    select(CommsConversation)
                    .where(
                        CommsConversation.org_id == org,
                        CommsConversation.is_deleted.is_(False),
                        CommsConversation.id > proof.cursor_id if proof.cursor_id else true(),
                    )
                    .order_by(CommsConversation.id)
                    .limit(1)
                )
                if room is None:
                    proof.erasure_done = True
                    break
                days, file_days, approver = _periods(policies, room)
                if approver is not None:
                    db.info[AUDIT_CONTEXT_KEY].performed_by = approver
                erased, done = _erase(
                    db,
                    room,
                    retention.cutoff(current, days),
                    retention.cutoff(current, file_days),
                    current,
                )
                proof.message_count += erased
                if not done:
                    break
                proof.cursor_id = room.id
            captures = _retire_captures(db, org, current)
            removed = _gc(db, org)
            proof.anchor_count += removed
            ready_for_cleanup = proof.erasure_done
            db.commit()
            events = take_committed_events(db)
        publish(events)
        if not ready_for_cleanup or captures or removed:
            return {"complete": False}
        pending = failed = False
        deleted_files = 0
        with _session(engine, org) as db:
            db.info[AUDIT_CONTEXT_KEY].performed_by = actor
            file_ids = list(
                db.scalars(
                    select(File.id)
                    .where(
                        File.org_id == org,
                        File.purpose == "comms_attachment",
                        File.retention_erased_at.is_not(None),
                        File.id > file_cursor if file_cursor else true(),
                    )
                    .order_by(File.id)
                    .limit(10)
                )
            )
            for identity in file_ids:
                try:
                    if not retention_files.cleanup_file(db, identity, actor, provider):
                        pending = True
                        continue
                    file = db.get(File, identity, populate_existing=True)
                    if file is not None and file.state == "purged":
                        db.delete(file)
                        db.commit()
                        deleted_files += 1
                except (ProviderUnavailable, HTTPException):
                    db.rollback()
                    pending = failed = True
            export_ids = list(
                db.scalars(
                    select(CommsExport.id)
                    .where(
                        CommsExport.org_id == org,
                        CommsExport.cleanup_pending.is_(True),
                        CommsExport.id > export_cursor if export_cursor else true(),
                    )
                    .order_by(CommsExport.id)
                    .limit(10)
                )
            )
            for identity in export_ids:
                try:
                    pending = (
                        not export_service.cleanup_artifact(
                            db,
                            identity,
                            provider,
                            now=current,
                        )
                        or pending
                    )
                except (ProviderUnavailable, HTTPException):
                    db.rollback()
                    pending = failed = True
            retention.lock_policy(db)
            proof = db.get(CommsRetentionSweep, proof_id, populate_existing=True)
            assert proof is not None
            proof.file_count += deleted_files
            proof.file_cursor_id = file_ids[-1] if file_ids else None
            proof.export_cursor_id = export_ids[-1] if export_ids else None
            more_files = (
                db.scalar(
                    select(File.id)
                    .where(File.org_id == org, File.retention_erased_at.is_not(None))
                    .limit(1)
                )
                is not None
            )
            more_exports = (
                db.scalar(
                    select(CommsExport.id)
                    .where(CommsExport.org_id == org, CommsExport.cleanup_pending.is_(True))
                    .limit(1)
                )
                is not None
            )
            complete = not (pending or more_files or more_exports)
            proof.failure_code = "storage_unavailable" if failed else None
            if complete:
                proof.finished_at = current
            db.commit()
        return {"complete": complete, "failed": failed}
    finally:
        request_events.reset(token)
