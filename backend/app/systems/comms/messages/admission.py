"""Current posting and source-reference admission shared by messages, replies and file writes."""

from datetime import datetime
from math import ceil
from pathlib import PurePosixPath
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.comms.access import (
    LEVELS,
    _conversation_access_statement,
    conversation_reader_statement,
    error,
    require_conversation_access,
)
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.interaction_models import CommsThread
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.reads import get_message
from app.systems.comms.messages.schemas import EditRequest, SendRequest
from app.systems.comms.settings.resolution import Scope, resolve_settings
from app.systems.platform.files.models import File
from app.systems.platform.files.validation import MAX_BYTES, MIME
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def posting_context(
    db: Session, user: User, conversation_id: UUID
) -> tuple[CommsConversation, dict[str, Any], dict[str, Any]]:
    policy = _conversation_access_statement(
        select(CommsConversation.id).where(
            CommsConversation.id == conversation_id,
        ),
        [user.id],
    ).subquery()
    row = db.execute(
        select(CommsConversation, policy.c.level, policy.c.role)
        .join(
            policy,
            policy.c.conversation_id == CommsConversation.id,
        )
        .where(CommsConversation.org_id == bound_organization_column(), policy.c.level > 0)
        .execution_options(populate_existing=True)
    ).first()
    if row is None:
        raise error("comms_not_found", "Conversation not found")
    conversation, level, role = row
    check = {"conversation_level": LEVELS[level], "membership_role": role}
    scope: Scope = (
        {"kind": "channel", "id": conversation_id}
        if conversation.kind == "channel"
        else {"kind": "workspace"}
    )
    settings = resolve_settings(db, scope)["effective"]
    until = settings["restriction_until"]
    restricted = str(user.id) in settings["restricted_person_ids"] and (
        until is None or datetime.fromisoformat(until.replace("Z", "+00:00")) > utc_now()
    )
    if role == "guest" or conversation.archived_at or settings["locked"] or restricted:
        raise error("comms_post_denied", "Posting is not allowed", 403)
    if conversation.kind == "direct":
        require_conversation_access(db, user, conversation_id, "post")
    return conversation, check, settings


def mentions(
    db: Session,
    user: User,
    conversation_id: UUID,
    request: SendRequest | EditRequest,
    settings: dict[str, Any],
) -> None:
    if request.mentions_channel or request.mentions_here:
        if not capability_check(db, user, conversation_id)["capabilities"]["mentionChannel"][
            "allowed"
        ]:
            raise error("comms_capability_denied", "Capability required", 403)
    count = len(request.mention_user_ids) + request.mentions_channel + request.mentions_here
    if settings["mention_limit"] and count > settings["mention_limit"]:
        raise error("comms_invalid_input", "Mention limit exceeded", 422)
    ids = set(request.mention_user_ids)
    if ids:
        conversation = db.get(CommsConversation, conversation_id)
        # D44: any channel reader is mentionable; direct and group messages need a member row.
        members = (
            ids
            if conversation is not None and conversation.kind == "channel"
            else set(
                db.scalars(
                    select(CommsMember.user_id).where(
                        CommsMember.org_id == bound_organization_column(),
                        CommsMember.conversation_id == conversation_id,
                        CommsMember.user_id.in_(ids),
                        CommsMember.is_deleted.is_(False),
                        CommsMember.deleted_at.is_(None),
                    )
                )
            )
        )
        readable = set(
            db.scalars(
                conversation_reader_statement(
                    select(CommsConversation.id).where(
                        CommsConversation.id == conversation_id,
                    ),
                    ids,
                )
            )
        )
        if ids != members or ids != readable:
            raise error("comms_invalid_input", "Mention target unavailable", 422)


def file_shape(filename: str, size: int, settings: dict[str, Any]) -> None:
    extension = PurePosixPath(filename).suffix.lower()
    ceiling = min(MAX_BYTES, int((settings["max_file_size_mb"] or 10) * 1024 * 1024))
    if (
        extension not in MIME
        or size <= 0
        or size > ceiling
        or (settings["allowed_file_types"] and extension[1:] not in settings["allowed_file_types"])
    ):
        raise error("comms_invalid_input", "File type or size is not allowed", 422)


def linked_sources(
    db: Session, user: User, conversation_id: UUID, request: SendRequest, settings: dict[str, Any]
) -> None:
    if settings["require_record_link"] and not request.record_ids:
        raise error("comms_invalid_input", "A record link is required", 422)
    if not request.attachment_ids and not request.record_ids:
        return
    capabilities = capability_check(db, user, conversation_id)["capabilities"]
    if request.attachment_ids:
        if not capabilities["attachFiles"]["allowed"]:
            raise error("comms_capability_denied", "Capability required", 403)
        files = db.scalars(
            select(File)
            .where(File.org_id == bound_organization_column(), File.id.in_(request.attachment_ids))
            .execution_options(populate_existing=True)
        ).all()
        if len(files) != len(request.attachment_ids) or any(
            row.purpose != "comms_attachment"
            or row.conversation_id != conversation_id
            or row.creator_id != user.id
            or row.is_deleted
            or row.state != "ready"
            or not row.actual_size
            for row in files
        ):
            raise error("comms_invalid_input", "Attachment unavailable", 422)
        for row in files:
            file_shape(row.filename, row.actual_size or 0, settings)
    if request.record_ids:
        if not capabilities["linkRecords"]["allowed"]:
            raise error("comms_capability_denied", "Capability required", 403)
        records = db.execute(
            select(Record.id, Record.module_id)
            .join(Module, Module.id == Record.module_id)
            .where(
                Record.org_id == bound_organization_column(),
                Module.org_id == bound_organization_column(),
                Record.id.in_(request.record_ids),
                Record.is_deleted.is_(False),
                Record.deleted_at.is_(None),
                Module.is_deleted.is_(False),
                Module.deleted_at.is_(None),
                module_filter(db, user, AccessLevel.READ, Record.module_id),
            )
        ).all()
        if len(records) != len(request.record_ids) or any(
            settings["allowed_record_modules"]
            and str(module) not in settings["allowed_record_modules"]
            for _, module in records
        ):
            raise error("comms_invalid_input", "Record reference unavailable", 422)


def authorize_send(
    db: Session,
    user: User,
    conversation_id: UUID,
    request: SendRequest,
    *,
    parent_id: UUID | None = None,
) -> None:
    conversation, check, settings = posting_context(db, user, conversation_id)
    if parent_id is None:
        if (
            check["conversation_level"] == "read"
            or conversation.kind == "channel"
            and (
                settings["mode"] == "thread-first"
                or settings["mode"] == "announcements"
                and check["conversation_level"] != "manage"
            )
        ):
            raise error("comms_post_denied", "Posting is not allowed", 403)
    else:
        root = get_message(db, conversation_id, message_id=parent_id)
        if root.parent_id is not None:
            raise error("comms_not_found", "Thread root not found")
        if not capability_check(db, user, conversation_id)["capabilities"]["reply"]["allowed"]:
            raise error("comms_post_denied", "Posting is not allowed", 403)
        thread = db.scalar(
            select(CommsThread)
            .where(
                CommsThread.org_id == bound_organization_column(),
                CommsThread.root_message_id == parent_id,
            )
            .execution_options(populate_existing=True)
        )
        if thread is not None and (thread.locked or thread.archived or thread.is_deleted):
            raise error("comms_post_denied", "Posting is not allowed", 403)
    linked_sources(db, user, conversation_id, request, settings)
    mentions(db, user, conversation_id, request, settings)
    if request.reply_to_id is not None:
        quoted = get_message(db, conversation_id, message_id=request.reply_to_id)
        if quoted.is_deleted or quoted.deleted_at:
            raise error("comms_not_found", "Message not found")
    if settings["slow_mode_seconds"]:
        latest = db.scalar(
            select(func.max(CommsMessage.created_at)).where(
                CommsMessage.org_id == bound_organization_column(),
                CommsMessage.conversation_id == conversation_id,
                CommsMessage.author_id == user.id,
            )
        )
        if latest is not None:
            remaining = settings["slow_mode_seconds"] - (utc_now() - latest).total_seconds()
            if remaining > 0:
                refused = error("comms_slow_mode", "Wait before sending again", 429)
                refused.headers = {"Retry-After": str(ceil(remaining))}
                raise refused
