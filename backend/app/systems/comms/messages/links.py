"""Page-bounded attachments and captured-source record cards; no cached record content."""

from collections import defaultdict
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.comms.access import error, visible_conversation_clause
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.schemas import (
    Attachment,
    AvailableRecord,
    RecordField,
    UnavailableRecord,
)
from app.systems.comms.settings.models import CommsSettings
from app.systems.comms.settings.resolution import Scope, locked_keys, resolve_layers
from app.systems.platform.files.models import File
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.display import FieldDisplayResolver, record_title
from app.systems.sandbox.records.models import Record


def attachments(db: Session, messages: Sequence[CommsMessage]) -> dict[UUID, list[Attachment]]:
    result: dict[UUID, list[Attachment]] = defaultdict(list)
    for message_id, file in db.execute(
        select(CommsMessageAttachment.message_id, File)
        .join(
            File,
            File.id == CommsMessageAttachment.file_id,
        )
        .join(CommsMessage, CommsMessage.id == CommsMessageAttachment.message_id)
        .where(
            CommsMessageAttachment.org_id == bound_organization_column(),
            File.org_id == bound_organization_column(),
            CommsMessage.org_id == bound_organization_column(),
            CommsMessage.id.in_([row.id for row in messages]),
            CommsMessageAttachment.is_deleted.is_(False),
            File.is_deleted.is_(False),
            File.state == "ready",
            File.purpose == "comms_attachment",
            File.conversation_id == CommsMessage.conversation_id,
        )
        .order_by(CommsMessageAttachment.id)
    ):
        if file.actual_size and file.media_type:
            result[message_id].append(
                Attachment(
                    id=file.id,
                    filename=file.filename,
                    media_type=file.media_type,
                    size=file.actual_size,
                )
            )
    return result


def card_fields(db: Session, conversation_ids: set[UUID]) -> dict[UUID, list[str]]:
    conversations = db.scalars(
        select(CommsConversation).where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.id.in_(conversation_ids),
        )
    ).all()
    categories = {row.category_id for row in conversations if row.category_id}
    stored = {
        (row.scope, row.category_id or row.conversation_id): row.values
        for row in db.scalars(
            select(CommsSettings).where(
                CommsSettings.org_id == bound_organization_column(),
                CommsSettings.is_deleted.is_(False),
                or_(
                    CommsSettings.scope == "workspace",
                    CommsSettings.category_id.in_(categories),
                    CommsSettings.conversation_id.in_(conversation_ids),
                ),
            )
        )
    }
    locks = locked_keys(db, "setting")
    result = {}
    for row in conversations:
        chain: list[Scope] = [{"kind": "workspace"}]
        if row.kind == "channel":
            if row.category_id:
                chain.append({"kind": "category", "id": row.category_id})
            chain.append({"kind": "channel", "id": row.id})
        effective, _ = resolve_layers(
            [(scope, stored.get((scope["kind"], scope.get("id")), {})) for scope in chain], locks
        )
        result[row.id] = effective["record_card_fields"]
    return result


def reference_query(db: Session, user: User) -> Any:
    return (
        select(CommsMessageRecordLink)
        .join(
            CommsMessage,
            CommsMessage.id == CommsMessageRecordLink.message_id,
        )
        .join(CommsConversation, CommsConversation.id == CommsMessage.conversation_id)
        .where(
            CommsMessageRecordLink.org_id == bound_organization_column(),
            CommsMessage.org_id == bound_organization_column(),
            CommsMessageRecordLink.is_deleted.is_(False),
            CommsMessage.is_deleted.is_(False),
            CommsMessage.deleted_at.is_(None),
            visible_conversation_clause(db, user),
        )
    )


def project_records(
    db: Session, user: User, links: Sequence[CommsMessageRecordLink]
) -> dict[UUID, AvailableRecord | UnavailableRecord]:
    result: dict[UUID, AvailableRecord | UnavailableRecord] = {
        link.id: UnavailableRecord(id=link.id, state="unavailable") for link in links
    }
    if not links:
        return result
    live_parents = {
        identity: conversation
        for identity, conversation in db.execute(
            select(CommsMessage.id, CommsMessage.conversation_id)
            .join(
                CommsConversation,
                CommsConversation.id == CommsMessage.conversation_id,
            )
            .where(
                CommsMessage.org_id == bound_organization_column(),
                CommsMessage.id.in_([link.message_id for link in links]),
                CommsMessage.is_deleted.is_(False),
                CommsMessage.deleted_at.is_(None),
                visible_conversation_clause(db, user),
            )
        )
    }
    if set(live_parents) != {link.message_id for link in links}:
        raise error("comms_not_found", "Message not found")
    records = {
        (record.id, module.id): (record, module)
        for record, module in db.execute(
            select(Record, Module)
            .join(Module, Module.id == Record.module_id)
            .where(
                Record.org_id == bound_organization_column(),
                Module.org_id == bound_organization_column(),
                Record.id.in_([link.record_id for link in links]),
                Record.is_deleted.is_(False),
                Record.deleted_at.is_(None),
                Module.is_deleted.is_(False),
                Module.deleted_at.is_(None),
                module_filter(db, user, AccessLevel.READ, Record.module_id),
            )
        )
    }
    modules = {module.id for _, module in records.values()}
    # Preload source fields once, so current title reads hit the same bounded identity map.
    fields: dict[UUID, list[Field]] = defaultdict(list)
    for field in db.scalars(
        select(Field).where(
            Field.org_id == bound_organization_column(), Field.module_id.in_(modules)
        )
    ):
        fields[field.module_id].append(field)
    configured = card_fields(db, set(live_parents.values()))
    resolvers: dict[tuple[UUID, tuple[str, ...]], FieldDisplayResolver] = {}
    for link in links:
        source = records.get((link.record_id, link.module_id))
        if source is None:
            continue
        record, module = source
        selected = tuple(configured[live_parents[link.message_id]])
        key = module.id, selected
        if key not in resolvers:
            resolvers[key] = FieldDisplayResolver(
                db,
                module.id,
                [
                    field
                    for field in fields[module.id]
                    if not field.is_deleted and str(field.id) in selected
                ],
            )
        resolver = resolvers[key]
        result[link.id] = AvailableRecord(
            id=link.id,
            state="available",
            record_id=record.id,
            module_id=module.id,
            module_name=module.module_name,
            title=record_title(db, record, module),
            fields=[
                RecordField(
                    field_id=field.id, label=field.name, display_value=resolver.label(field, value)
                )
                for field in fields[module.id]
                if str(field.id) in selected
                and not field.is_deleted
                and (value := record.data.get(str(field.id))) is not None
            ],
        )
    return result


def message_records(
    db: Session, user_id: UUID, messages: Sequence[CommsMessage]
) -> dict[UUID, list[AvailableRecord | UnavailableRecord]]:
    result: dict[UUID, list[AvailableRecord | UnavailableRecord]] = defaultdict(list)
    user = db.get(User, user_id)
    if user is None:
        raise error("comms_not_found", "Person not found")
    links = db.scalars(
        reference_query(db, user)
        .where(
            CommsMessageRecordLink.message_id.in_([row.id for row in messages]),
        )
        .order_by(CommsMessageRecordLink.id)
    ).all()
    projected = project_records(db, user, links)
    for link in links:
        result[link.message_id].append(projected[link.id])
    return result
