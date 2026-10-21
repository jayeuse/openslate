"""Shared message serialization lock and durable source version; no commit ownership."""

from hashlib import sha256
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.comms.access import error
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.messages.schemas import LiveMessage, Tombstone


def message_capacity_error(body: object, attachment_count: int, record_count: int) -> str | None:
    """Actual send/restore bounds only: no active-message quota or entitlement stub."""
    if not isinstance(body, str) or len(body) > 4000:
        return "Body must be text of at most 4000 Unicode characters"
    if not body.strip() and not attachment_count and not record_count:
        return "A body, attachment or record link is required"
    if attachment_count > 10:
        return "At most ten distinct attachments are allowed"
    return None


def lock_counter(db: Session, conversation_id: UUID) -> CommsConversationCounter:
    row = db.scalar(select(CommsConversationCounter).where(
        CommsConversationCounter.org_id == bound_organization_column(),
        CommsConversationCounter.conversation_id == conversation_id,
        CommsConversationCounter.is_deleted.is_(False),
    ).with_for_update().execution_options(populate_existing=True))
    if row is None:
        raise error("comms_not_found", "Conversation not found")
    return row


def message_version(message: LiveMessage | Tombstone) -> str:
    return '"' + sha256(message.model_dump_json().encode()).hexdigest() + '"'


def advance_generation(message: CommsMessage) -> None:
    if message.mutation_generation >= 9007199254740991:
        raise error("comms_conflict", "Message version exhausted", 409)
    message.mutation_generation += 1
    message.link_previews = []
    message.link_preview_generation = None
