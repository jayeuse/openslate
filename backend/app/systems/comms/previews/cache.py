"""Read only current, source-bound cached metadata; reads never start network work."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.previews.metadata import validated
from app.systems.comms.previews.urls import first_url
from app.systems.comms.settings.resolution import Scope, resolve_settings


def cached_previews(db: Session, messages: list[CommsMessage]) -> dict[UUID, list[dict[str, str]]]:
    eligible = [
        row
        for row in messages
        if row.link_previews
        and row.link_preview_generation == row.mutation_generation
        and not row.is_deleted
        and row.deleted_at is None
        and row.retention_erased_at is None
    ]
    if not eligible:
        return {}
    rooms = db.scalars(
        select(CommsConversation)
        .where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.id.in_({row.conversation_id for row in eligible}),
            CommsConversation.is_deleted.is_(False),
            CommsConversation.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    ).all()
    enabled = set()
    for room in rooms:
        scope: Scope = (
            {"kind": "channel", "id": room.id} if room.kind == "channel" else {"kind": "workspace"}
        )
        if resolve_settings(db, scope)["effective"]["link_previews"]:
            enabled.add(room.id)
    result = {}
    for message in eligible:
        if message.conversation_id in enabled and len(message.link_previews) == 1:
            value = validated(message.link_previews[0], first_url(message.body) or "")
            if value is not None:
                result[message.id] = [value]
    return result
