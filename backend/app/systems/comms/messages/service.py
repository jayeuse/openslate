"""Internal send transaction with post-counter authorization and committed-send budget."""

import hashlib
import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from uuid import UUID

from psycopg.errors import UniqueViolation
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.database.organization_scope import session_organization
from app.core.database.session import AuditSession
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.jobs.models import CommsExpiredSend
from app.systems.comms.messages.interaction_models import (
    CommsMention,
    CommsThread,
    CommsThreadFollow,
)
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.messages.mutations import message_capacity_error
from app.systems.comms.notifications import stage_notifications
from app.systems.comms.rate_limit import admit_message_send
from app.systems.comms.realtime.events import message_event
from app.systems.comms.settings.resolution import Scope, resolve_settings
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.listeners import PENDING_CHANGES_KEY, REALTIME_INVALIDATION_KEY
from app.systems.platform.files.models import File
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

MAX_SEQUENCE = 9007199254740991


class InvalidSend(ValueError):
    """The command or supplied transaction cannot be used for a send."""


class MessageReferenceUnavailable(InvalidSend):
    """A quoted or root message is absent from the bound conversation."""


class SendRateLimited(InvalidSend):
    def __init__(self, retry_after: int) -> None:
        super().__init__("Message send limit reached")
        self.retry_after = retry_after


class SendConflict(ValueError):
    """The lifetime client key already identifies a different original send."""


@dataclass(frozen=True)
class SendMessageCommand:
    client_key: UUID
    body: str
    parent_id: UUID | None = None
    reply_to_id: UUID | None = None
    also_send_to_channel: bool = False
    mention_user_ids: tuple[UUID, ...] = ()
    mentions_channel: bool = False
    mentions_here: bool = False
    attachment_ids: tuple[UUID, ...] = ()
    record_ids: tuple[UUID, ...] = ()


@dataclass(frozen=True)
class SendMessageResult:
    message: CommsMessage
    replayed: bool


def _canonical_command(command: SendMessageCommand) -> SendMessageCommand:
    return replace(
        command,
        mention_user_ids=tuple(sorted(set(command.mention_user_ids))),
        attachment_ids=tuple(sorted(set(command.attachment_ids))),
        record_ids=tuple(sorted(set(command.record_ids))),
    )


def _fingerprint(command: SendMessageCommand, conversation_id: UUID) -> str:
    payload = asdict(command)
    del payload["client_key"]
    payload["conversation_id"] = conversation_id
    return hashlib.sha256(
        json.dumps(
            payload,
            default=str,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _find_original(
    db: AuditSession,
    org_id: UUID,
    author_id: UUID,
    client_key: UUID,
) -> CommsMessage | None:
    # Lifetime identity includes tombstones and ignores mutable current content.
    return db.scalar(
        select(CommsMessage)
        .where(
            CommsMessage.org_id == org_id,
            CommsMessage.author_id == author_id,
            CommsMessage.client_key == client_key,
        )
        .execution_options(populate_existing=True)
    )


def _replay(message: CommsMessage, fingerprint: str) -> SendMessageResult:
    if message.retention_erased_at is not None:
        raise SendConflict("Client key identifies an expired message")
    if message.send_fingerprint != fingerprint:
        raise SendConflict("Client key already identifies a different send")
    return SendMessageResult(message, replayed=True)


def _is_client_key_collision(error: IntegrityError) -> bool:
    original = error.orig
    return (
        isinstance(original, UniqueViolation)
        and original.sqlstate == "23505"
        and original.diag.schema_name == "public"
        and original.diag.table_name == "comms_messages"
        and original.diag.constraint_name == "uq_comms_messages_client_key"
    )


def _admit_transaction(db: AuditSession, org_id: UUID, author_id: UUID) -> None:
    context = db.info.get(AUDIT_CONTEXT_KEY)
    if (
        not isinstance(db, AuditSession)
        or not db.is_active
        or db.in_nested_transaction()
        or db.new
        or db.dirty
        or db.deleted
        or db.info.get(PENDING_CHANGES_KEY)
        or REALTIME_INVALIDATION_KEY in db.info
    ):
        raise InvalidSend("Send requires a transaction without caller writes")
    if (
        session_organization(db) != org_id
        or not isinstance(context, AuditContext)
        or context.performed_by != author_id
    ):
        raise InvalidSend("Send context does not match the bound organization and actor")
    # Reads/autobegin are allowed. A drained flush or rolled-back savepoint can
    # hide caller writes from Session tracking, but not from the top-level XID.
    with db.no_autoflush:
        if db.scalar(select(func.pg_current_xact_id_if_assigned().is_not(None))):
            raise InvalidSend("Send requires a transaction without prior writes or locks")


def _validate_payload(command: SendMessageCommand) -> None:
    reason = message_capacity_error(
        command.body, len(command.attachment_ids), len(command.record_ids),
    )
    if reason is not None:
        raise InvalidSend(reason)
    if command.also_send_to_channel and command.parent_id is None:
        raise InvalidSend("Only a thread reply can also be sent to the channel")


def _lock_context(
    db: AuditSession,
    org_id: UUID,
    conversation_id: UUID,
    command: SendMessageCommand,
) -> tuple[CommsMessage | None, CommsThread | None]:
    conversation = db.scalar(
        select(CommsConversation)
        .where(
            CommsConversation.org_id == org_id,
            CommsConversation.id == conversation_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if conversation is None or conversation.is_deleted:
        raise InvalidSend("Conversation unavailable")
    ids = sorted({identity for identity in (command.parent_id, command.reply_to_id) if identity})
    references = db.scalars(
        select(CommsMessage)
        .where(
            CommsMessage.org_id == org_id,
            CommsMessage.conversation_id == conversation_id,
            CommsMessage.id.in_(ids),
        )
        .order_by(CommsMessage.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    if len(references) != len(ids) or any(
        (row.is_deleted or row.deleted_at is not None) and row.id == command.reply_to_id
        for row in references
    ):
        raise MessageReferenceUnavailable("Message reference unavailable")
    root = next((row for row in references if row.id == command.parent_id), None)
    thread = None
    if root is not None:
        if root.parent_id is not None or root.reply_count >= MAX_SEQUENCE:
            raise InvalidSend("Invalid thread root or exhausted reply count")
        thread = db.scalar(
            select(CommsThread)
            .where(
                CommsThread.org_id == org_id,
                CommsThread.conversation_id == conversation_id,
                CommsThread.root_message_id == root.id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if thread is not None and thread.is_deleted:
            raise InvalidSend("Thread unavailable")
    return root, thread


def _link_targets(
    db: AuditSession,
    org_id: UUID,
    command: SendMessageCommand,
) -> list[Record]:
    # Structural identity only: no S16 visibility/capability or S18 purpose policy.
    if command.mention_user_ids:
        members = set(
            db.scalars(
                select(Membership.user_id)
                .join(
                    User,
                    User.id == Membership.user_id,
                )
                .where(
                    Membership.org_id == org_id,
                    Membership.is_deleted.is_(False),
                    User.is_deleted.is_(False),
                    Membership.user_id.in_(command.mention_user_ids),
                )
            )
        )
        if members != set(command.mention_user_ids):
            raise InvalidSend("Mention reference unavailable")
    if command.attachment_ids:
        files = db.scalars(
            select(File)
            .where(
                File.org_id == org_id,
                File.id.in_(command.attachment_ids),
            )
            .order_by(File.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).all()
        if len(files) != len(command.attachment_ids) or any(
            file.is_deleted or file.state != "ready" for file in files
        ):
            raise InvalidSend("Attachment reference unavailable")
        owned = db.scalar(
            select(CommsMessageAttachment.id)
            .where(
                CommsMessageAttachment.org_id == org_id,
                CommsMessageAttachment.file_id.in_(command.attachment_ids),
            )
            .limit(1)
        )
        if owned is not None:
            raise InvalidSend("Attachment already belongs to a message")
    records = list(
        db.scalars(
            select(Record)
            .where(
                Record.org_id == org_id,
                Record.id.in_(command.record_ids),
            )
            .order_by(Record.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    if len(records) != len(command.record_ids) or any(record.is_deleted for record in records):
        raise InvalidSend("Record reference unavailable")
    module_ids = {record.module_id for record in records}
    if (
        module_ids
        and set(
            db.scalars(
                select(Module.id).where(
                    Module.org_id == org_id,
                    Module.id.in_(module_ids),
                    Module.is_deleted.is_(False),
                )
            )
        )
        != module_ids
    ):
        raise InvalidSend("Record module unavailable")
    return records


def _stage_children(
    db: AuditSession,
    message: CommsMessage,
    command: SendMessageCommand,
    root: CommsMessage | None,
    thread: CommsThread | None,
    records: list[Record],
) -> None:
    if root is not None:
        root.reply_count += 1
        root.last_reply_at = message.created_at
        if thread is None:
            db.add(
                CommsThread(
                    org_id=message.org_id,
                    conversation_id=message.conversation_id,
                    root_message_id=root.id,
                )
            )
        conversation = db.get(CommsConversation, message.conversation_id)
        assert conversation is not None
        scope: Scope = (
            {"kind": "channel", "id": conversation.id}
            if conversation.kind == "channel"
            else {"kind": "workspace"}
        )
        if resolve_settings(db, scope)["effective"]["default_thread_subscription"]:
            followed = db.scalar(
                select(CommsThreadFollow.id).where(
                    CommsThreadFollow.org_id == message.org_id,
                    CommsThreadFollow.root_message_id == root.id,
                    CommsThreadFollow.user_id == message.author_id,
                )
            )
            if followed is None:
                db.add(
                    CommsThreadFollow(
                        org_id=message.org_id, root_message_id=root.id, user_id=message.author_id
                    )
                )
    for user_id in command.mention_user_ids:
        db.add(CommsMention(org_id=message.org_id, message_id=message.id, user_id=user_id))
    for file_id in command.attachment_ids:
        db.add(
            CommsMessageAttachment(
                org_id=message.org_id,
                message_id=message.id,
                file_id=file_id,
            )
        )
    for record in records:
        db.add(
            CommsMessageRecordLink(
                org_id=message.org_id,
                message_id=message.id,
                record_id=record.id,
                module_id=record.module_id,
            )
        )


def send_message(
    db: AuditSession,
    *,
    org_id: UUID,
    author_id: UUID,
    conversation_id: UUID,
    command: SendMessageCommand,
    authorize: Callable[[bool], None] | None = None,
    finalize: Callable[[CommsMessage], None] | None = None,
) -> SendMessageResult:
    """Own one commit/full rollback, never caller work or a nested transaction.

    Production callers supply fresh policy reads via authorize; None is reserved
    for existing preauthorized structural callers. False authorizes a new send;
    True authorizes current replay reads, after any full rollback.
    A trusted scheduled-work finalizer may stage its result in this same commit; it never commits.
    """
    fingerprint = None
    try:
        _admit_transaction(db, org_id, author_id)
        command = _canonical_command(command)
        fingerprint = _fingerprint(command, conversation_id)
        existing = _find_original(db, org_id, author_id, command.client_key)
        retry_after = admit_message_send(db, org_id, author_id) if existing is None else None
        counter = db.scalar(
            select(CommsConversationCounter)
            .where(
                CommsConversationCounter.org_id == org_id,
                CommsConversationCounter.conversation_id == conversation_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        existing = _find_original(db, org_id, author_id, command.client_key)
        if existing is not None:
            # Recheck after both author/counter waits, before refusing a full budget.
            db.rollback()
            if authorize is not None:
                authorize(True)
            existing = _find_original(db, org_id, author_id, command.client_key)
            if existing is None:
                raise InvalidSend("Replay no longer available")
            replay = _replay(existing, fingerprint)
            if finalize is not None:
                finalize(replay.message)
                db.commit()
            return replay
        if counter is None or counter.is_deleted:
            raise InvalidSend("Conversation unavailable")
        root, thread = _lock_context(db, org_id, conversation_id, command)
        records = _link_targets(db, org_id, command)
        if authorize is not None:
            # File/record/conversation waits must not retain earlier grants or settings.
            authorize(False)
        if (
            db.scalar(
                select(CommsExpiredSend.id).where(
                    CommsExpiredSend.org_id == org_id,
                    CommsExpiredSend.author_id == author_id,
                    CommsExpiredSend.client_key == command.client_key,
                )
            )
            is not None
        ):
            raise SendConflict("Client key identifies an expired message")
        if retry_after is not None:
            raise SendRateLimited(retry_after)
        _validate_payload(command)
        if counter.last_seq >= MAX_SEQUENCE:
            raise InvalidSend("Conversation sequence exhausted")
        counter.last_seq += 1
        message = CommsMessage(
            org_id=org_id,
            conversation_id=conversation_id,
            author_id=author_id,
            seq=counter.last_seq,
            client_key=command.client_key,
            body=command.body,
            send_fingerprint=fingerprint,
            parent_id=command.parent_id,
            reply_to_id=command.reply_to_id,
            also_send_to_channel=command.also_send_to_channel,
            mentions_channel=command.mentions_channel,
            mentions_here=command.mentions_here,
        )
        db.add(message)
        # Establish the parent and its timestamp before any dependent insert.
        db.flush()
        _stage_children(db, message, command, root, thread, records)
        stage_notifications(db, message, command.mention_user_ids)
        message_event(db, conversation_id, message.seq, "created")
        if root is not None:
            message_event(db, conversation_id, root.seq, "thread")
        from app.systems.comms.previews.jobs import stage_preview

        stage_preview(db, message)
        if finalize is not None:
            finalize(message)
        db.commit()
        db.refresh(message)
        return SendMessageResult(message, replayed=False)
    except IntegrityError as error:
        db.rollback()
        if fingerprint is None or not _is_client_key_collision(error):
            raise
        # Different conversations lock different counters. Resolve only the exact
        # lifetime-key collision after FULL rollback; never retry the insert.
        try:
            if authorize is not None:
                authorize(True)
            winner = _find_original(db, org_id, author_id, command.client_key)
            if winner is None:
                raise error
            replay = _replay(winner, fingerprint)
            if finalize is not None:
                finalize(replay.message)
                db.commit()
            return replay
        except BaseException:
            db.rollback()
            raise
    except BaseException:
        db.rollback()
        raise
