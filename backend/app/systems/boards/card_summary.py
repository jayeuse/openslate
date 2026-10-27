"""Record card summaries, computed for one viewer at read time and never cached.

A viewer who cannot read the Record's module, or whose Record or module is in the
trash, gets a locked card: no module name, no Record name, no field values and no
Record or module ID.

The server has no notion of a Record "status" and no stored "first fields" (OpenView
chooses card fields per saved view in the browser). So the summary uses:

- the title: :func:`record_title` (the module's title field, else ``Record <id>``);
- the status: the first live ``select`` field by position, other than the title field;
- the fields: the first two live fields by position, other than the title and status
  fields, whose values read as one line of plain text (no long text, boolean or
  relationship); a field without a value is left out.
"""

from collections import defaultdict
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.kanban_models import BoardCard
from app.systems.boards.kanban_schemas import CardRecordField, LockedRecord, RecordSummary
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.display import (
    UNAVAILABLE_OPTION,
    FieldDisplayResolver,
    record_title,
)
from app.systems.sandbox.records.models import Record

FIRST_FIELD_TYPES = frozenset(
    {
        FieldType.TEXT,
        FieldType.EMAIL,
        FieldType.URL,
        FieldType.NUMBER,
        FieldType.DECIMAL,
        FieldType.INTEGER,
        FieldType.DATE,
        FieldType.DATETIME,
        FieldType.SELECT,
        FieldType.USER,
    }
)


def _value(resolver: FieldDisplayResolver, field: Field, record: Record) -> CardRecordField | None:
    value = record.data.get(str(field.id))
    if value is None or not str(value).strip():
        return None
    label = resolver.label(field, value)
    if label == UNAVAILABLE_OPTION:
        return None
    return CardRecordField(field_id=field.id, name=field.name, value=label)


def _summary(db: Session, record: Record, module: Module, fields: list[Field]) -> RecordSummary:
    candidates = [field for field in fields if field.id != module.title_field_id]
    status = next(
        (field for field in candidates if FieldType(field.type) is FieldType.SELECT), None
    )
    first = [
        field
        for field in candidates
        if field is not status and FieldType(field.type) in FIRST_FIELD_TYPES
    ][:2]
    shown = [field for field in (*first, status) if field is not None]
    resolver = FieldDisplayResolver(db, module.id, shown)
    return RecordSummary(
        record_id=record.id,
        module_id=module.id,
        module_name=module.module_name,
        title=record_title(db, record, module),
        fields=[item for field in first if (item := _value(resolver, field, record))],
        status=_value(resolver, status, record) if status is not None else None,
    )


def readable_records(
    db: Session, viewer: User, cards: Iterable[BoardCard]
) -> dict[tuple[UUID, UUID], tuple[Record, Module]]:
    """The live Records of these record cards that the viewer can read now."""

    record_ids = {card.record_id for card in cards if card.record_id is not None}
    if not record_ids:
        return {}
    return {
        (record.id, module.id): (record, module)
        for record, module in db.execute(
            select(Record, Module)
            .join(Module, Module.id == Record.module_id)
            .where(
                Record.org_id == bound_organization_column(),
                Module.org_id == bound_organization_column(),
                Record.id.in_(sorted(record_ids)),
                Record.is_deleted.is_(False),
                Record.deleted_at.is_(None),
                Module.is_deleted.is_(False),
                Module.deleted_at.is_(None),
                module_filter(db, viewer, AccessLevel.READ, Record.module_id),
            )
        ).all()
    }


def card_records(
    db: Session, viewer: User, cards: list[BoardCard]
) -> dict[UUID, RecordSummary | LockedRecord]:
    """One summary or lock per record card, with one Record and one Field query."""

    readable = readable_records(db, viewer, cards)
    modules = {module.id for _, module in readable.values()}
    fields: dict[UUID, list[Field]] = defaultdict(list)
    if modules:
        for field in db.scalars(
            select(Field)
            .where(
                Field.org_id == bound_organization_column(),
                Field.module_id.in_(sorted(modules)),
                Field.is_deleted.is_(False),
            )
            .order_by(Field.position, Field.id)
        ):
            fields[field.module_id].append(field)
    result: dict[UUID, RecordSummary | LockedRecord] = {}
    for card in cards:
        if card.record_id is None or card.module_id is None:
            continue
        source = readable.get((card.record_id, card.module_id))
        if source is None:
            result[card.id] = LockedRecord()
            continue
        record, module = source
        result[card.id] = _summary(db, record, module, fields[module.id])
    return result


def is_locked(db: Session, viewer: User, card: BoardCard) -> bool:
    """Whether this viewer sees ``card`` locked; an objective is never locked."""

    if card.kind != "record" or card.record_id is None or card.module_id is None:
        return False
    return (card.record_id, card.module_id) not in readable_records(db, viewer, [card])
