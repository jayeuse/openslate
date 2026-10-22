"""Bounded individual ORM purge; Storage keeps its committed, fenced deletion protocol."""

import hashlib
import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import require_fresh_exact_admin
from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.models import User
from app.systems.comms.access import conversation_reader_ids, error, require_conversation_access
from app.systems.comms.conversations.models import (
    CommsConversation,
    CommsMember,
)
from app.systems.comms.jobs import export_service
from app.systems.comms.jobs.models import (
    CommsExpiredSend,
    CommsExportEntry,
    CommsExportSource,
    CommsRetentionPolicy,
    CommsSchedule,
)
from app.systems.comms.messages.interaction_models import (
    CommsMention,
    CommsReaction,
    CommsThread,
    CommsThreadFollow,
)
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import (
    CommsConversationCounter,
    CommsMessage,
    CommsMessageRevision,
    CommsReadState,
)
from app.systems.comms.messages.mutations import lock_counter
from app.systems.comms.moderation.models import CommsReport
from app.systems.comms.previews.jobs import discard_preview_work
from app.systems.comms.realtime.events import user_event
from app.systems.comms.realtime.models import CommsRealtimeGrant, CommsTyping
from app.systems.comms.settings.models import (
    CommsCapabilityGrant,
    CommsMemberPreferences,
    CommsSettings,
)
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend
from app.systems.platform.files.purge import purge_confirmed
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork
from app.systems.sandbox.lifecycle.purge_support import PURGE_DISABLED_MESSAGE

BATCH_SIZE = 1000


@dataclass(frozen=True)
class Impact:
    conversation: CommsConversation
    message_count: int
    file_count: int
    max_seq: int
    digest: str
    name: str
    export_count: int


def impact(db: Session, actor: User, identity: UUID, *, lock: bool = False) -> Impact:
    if not get_settings().lifecycle_purge_enabled:
        raise error("purge_disabled", PURGE_DISABLED_MESSAGE, 403)
    require_fresh_exact_admin(db, actor.id)
    if lock:
        lock_counter(db, identity)
        db.scalar(
            select(CommsConversation)
            .where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.id == identity,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    conversation = require_conversation_access(db, actor, identity, "read")
    if conversation.archived_at is None:
        raise error("comms_conflict", "Archive the conversation before purging", 409)
    org = bound_organization_column()
    count, maximum = db.execute(
        select(
            func.count(),
            func.coalesce(func.max(CommsMessage.seq), 0),
        ).where(
            CommsMessage.org_id == org,
            CommsMessage.conversation_id == identity,
        )
    ).one()
    files = (
        db.scalar(
            select(func.count())
            .select_from(File)
            .where(
                File.org_id == org,
                File.conversation_id == identity,
            )
        )
        or 0
    )
    exports = (
        db.scalar(
            select(func.count())
            .select_from(CommsExportSource)
            .where(
                CommsExportSource.org_id == org,
                CommsExportSource.conversation_id == identity,
            )
        )
        or 0
    )
    name = conversation.name
    name = str(conversation.id) if conversation.kind == "direct" or not name else name
    state = {
        "namespace": "comms-purge-v1",
        "org": conversation.org_id,
        "actor": actor.id,
        "conversation": identity,
        "archived_at": conversation.archived_at,
        "updated_at": conversation.updated_at,
        "name": name,
        "message_count": count,
        "file_count": files,
        "export_count": exports,
        "max_seq": maximum,
    }
    digest = hashlib.sha256(json.dumps(state, sort_keys=True, default=str).encode()).hexdigest()
    return Impact(conversation, count, files, maximum, digest, name, exports)


def _delete_batches(db: Session, model: type[Any], where: ColumnElement[bool]) -> None:
    query = select(model).where(where).order_by(model.id).limit(BATCH_SIZE)
    if model is CommsMessage:
        # The UOW otherwise lazy-loads all three composite relationships per deletion.
        # Eagerly load the bounded batch; retain individual audited ORM deletes.
        query = query.options(
            selectinload(CommsMessage.conversation),
            selectinload(CommsMessage.parent),
            selectinload(CommsMessage.reply_to),
        )
    while rows := list(db.scalars(query)):
        for row in rows:
            db.delete(row)
        db.flush()


def _validate(db: Session, actor: User, identity: UUID, expected: str, name: str) -> Impact:
    current = impact(db, actor, identity, lock=True)
    if current.digest != expected or current.name != name:
        raise error("comms_conflict", "Conversation changed after preview", 409)
    return current


def delete_files(
    db: Session, actor: User, identity: UUID, expected: str, name: str, storage: StorageBackend
) -> None:
    """Each file claim commits only after the original purge scope is revalidated.

    Provider calls run without SQL locks. Existing deleting/purged states retain progress on
    failure; a failed request returns no successful purge result and leaves the parent.
    """
    org = bound_organization_column()
    export_ids = list(
        db.scalars(
            select(CommsExportSource.export_id)
            .where(
                CommsExportSource.org_id == org,
                CommsExportSource.conversation_id == identity,
            )
            .order_by(CommsExportSource.export_id)
        )
    )
    if export_ids:
        _validate(db, actor, identity, expected, name)
        export_service.retire(db, export_ids, now=utc_now())
        db.commit()  # Persist source-bound artifact revocation before external cleanup.
        for export_id in export_ids:
            if not export_service.cleanup_artifact(db, export_id, storage):
                raise error("comms_unavailable", "Export artifact cleanup is not confirmed", 503)
    while file_id := db.scalar(
        select(File.id)
        .where(
            File.org_id == org,
            File.conversation_id == identity,
            File.state != "purged",
        )
        .order_by(File.id)
        .limit(1)
    ):

        def validate_locked() -> None:
            _validate(db, actor, identity, expected, name)
            file = db.scalar(
                select(File)
                .where(File.org_id == org, File.id == file_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if (
                file is None
                or file.conversation_id != identity
                or file.purpose != "comms_attachment"
            ):
                raise error("comms_conflict", "File dependency changed", 409)
            if file.state == "uploading" or (
                file.operation_id is not None and file.state != "deleting"
            ):
                raise error(
                    "file_operation_active",
                    "Reconcile the file operation before purging",
                    409,
                )
            if (
                file.state == "deleting"
                and file.operation_expires_at is not None
                and file.operation_expires_at > utc_now()
            ):
                raise error("file_operation_active", "Deletion is still active", 409)
            _delete_batches(
                db,
                CommsMessageAttachment,
                (
                    (CommsMessageAttachment.org_id == org)
                    & (CommsMessageAttachment.file_id == file_id)
                    & CommsMessageAttachment.message_id.in_(
                        select(CommsMessage.id).where(
                            CommsMessage.org_id == org,
                            CommsMessage.conversation_id == identity,
                        )
                    )
                ),
            )
            file.is_deleted, file.deleted_at = True, file.deleted_at or utc_now()
            db.flush()

        purge_confirmed(db, actor.id, file_id, storage, validate_locked=validate_locked)


def delete_graph(db: Session, actor: User, identity: UUID, expected: str, name: str) -> Impact:
    current = _validate(db, actor, identity, expected, name)
    org = bound_organization_column()
    if (
        db.scalar(
            select(File.id)
            .where(
                File.org_id == org,
                File.conversation_id == identity,
                File.state != "purged",
            )
            .limit(1)
        )
        is not None
    ):
        raise error("file_operation_active", "File deletion is not confirmed", 409)
    recipients = conversation_reader_ids(db, current.conversation)
    while schedules := list(
        db.scalars(
            select(CommsSchedule)
            .where(
                CommsSchedule.org_id == org,
                CommsSchedule.conversation_id == identity,
            )
            .order_by(CommsSchedule.id)
            .limit(BATCH_SIZE)
            .with_for_update()
        )
    ):
        _delete_batches(
            db,
            ScheduledWork,
            (ScheduledWork.org_id == org)
            & ScheduledWork.comms_schedule_id.in_([row.id for row in schedules]),
        )
        for schedule in schedules:
            db.delete(schedule)
        db.flush()
    export_ids = list(
        db.scalars(
            select(CommsExportSource.export_id)
            .where(
                CommsExportSource.org_id == org,
                CommsExportSource.conversation_id == identity,
            )
            .order_by(CommsExportSource.export_id)
        )
    )
    for export_id in export_ids:
        export, _ = export_service.load(db, export_id, lock=True)
        if export.cleanup_pending or export.artifact_key is not None:
            raise error("comms_unavailable", "Export artifact cleanup is not confirmed", 503)
        for export_child in (CommsExportEntry, CommsExportSource):
            _delete_batches(
                db,
                export_child,
                (export_child.org_id == org) & (export_child.export_id == export_id),
            )
        _delete_batches(
            db,
            ScheduledWork,
            (ScheduledWork.org_id == org) & (ScheduledWork.comms_export_id == export_id),
        )
        db.delete(export)
        db.flush()
    messages = select(CommsMessage.id).where(
        CommsMessage.org_id == org,
        CommsMessage.conversation_id == identity,
    )
    discard_preview_work(db, messages)
    _delete_batches(
        db,
        InAppNotification,
        ((InAppNotification.org_id == org) & (InAppNotification.comms_conversation_id == identity)),
    )
    for model in (CommsReport, CommsThread):
        _delete_batches(db, model, (model.org_id == org) & (model.conversation_id == identity))
    for child in (
        CommsMessageAttachment,
        CommsMessageRecordLink,
        CommsMention,
        CommsReaction,
        CommsMessageRevision,
    ):
        _delete_batches(db, child, (child.org_id == org) & child.message_id.in_(messages))
    _delete_batches(
        db,
        CommsThreadFollow,
        ((CommsThreadFollow.org_id == org) & CommsThreadFollow.root_message_id.in_(messages)),
    )
    # Null self-references individually before deleting any source batch. No ordering
    # assumption or cascade can silently delete a different conversation's message.
    while rows := list(
        db.scalars(
            select(CommsMessage)
            .where(
                CommsMessage.org_id == org,
                CommsMessage.conversation_id == identity,
                or_(CommsMessage.parent_id.is_not(None), CommsMessage.reply_to_id.is_not(None)),
            )
            .order_by(CommsMessage.id)
            .limit(BATCH_SIZE)
        )
    ):
        for message in rows:
            message.parent_id = message.reply_to_id = None
            message.also_send_to_channel = False
        db.flush()
    _delete_batches(
        db, CommsMessage, (CommsMessage.org_id == org) & (CommsMessage.conversation_id == identity)
    )
    for owned in (
        File,
        CommsMember,
        CommsReadState,
        CommsMemberPreferences,
        CommsSettings,
        CommsCapabilityGrant,
        CommsTyping,
        CommsRealtimeGrant,
        CommsConversationCounter,
        CommsRetentionPolicy,
        CommsExpiredSend,
    ):
        _delete_batches(db, owned, (owned.org_id == org) & (owned.conversation_id == identity))
    db.delete(current.conversation)
    for recipient in recipients:
        user_event(db, recipient, "structure", {})
        user_event(db, recipient, "grants", {})
    return current
