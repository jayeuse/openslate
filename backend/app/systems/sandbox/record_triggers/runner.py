"""Record trigger evaluation and bounded schedule continuation."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import validate_field_value
from app.systems.sandbox.record_triggers.execution import (
    ClaimedTriggerEvent,
    locked_claim,
    release_schedule_continuation,
)
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.record_triggers.outbox import enqueue_child_field_event
from app.systems.sandbox.records.models import Record

SCHEDULE_RECORD_CHUNK = 100
ACTOR_LABEL_LENGTH = 100
_MISSING = object()

def execute_claim(db: Session, claim: ClaimedTriggerEvent) -> bool:
    """Execute one fenced event as the workspace, requeuing only schedule continuations."""

    event = locked_claim(db, claim)
    if event is None:
        return False
    root = _locked_root(db, event)
    fields = _lock_module_fields(db, event.module_id)
    records, has_more = _records(db, event)
    definitions = _definitions(db, event)
    changed: dict[UUID, tuple[Record, dict[str, object]]] = {}
    for definition in definitions:
        _set_context(db, definition.id, definition.name)
        if not _trigger_matches(event, definition, fields):
            _finish_run(db, event, definition, "skipped", {})
            db.flush()
            continue
        matched, applied = _apply_definition(db, event, root, definition, records, changed, fields)
        event.schedule_matched_count += matched if event.event_kind == "schedule" else 0
        event.schedule_action_count += applied if event.event_kind == "schedule" else 0
        if event.event_kind != "schedule" or not has_more or root.action_budget <= 0:
            _finish_run(
                db,
                event,
                definition,
                "succeeded" if _has_match(event, matched) else "skipped",
                _details(event, matched, applied, root),
            )
        db.flush()

    for record, previous in changed.values():
        enqueue_child_field_event(
            db, record=record, previous=previous, parent=event, action_budget=root.action_budget
        )
    if event.event_kind == "schedule" and has_more and root.action_budget > 0:
        event.schedule_cursor_record_id = (
            records[-1].id if records else event.schedule_cursor_record_id
        )
        release_schedule_continuation(event)
    else:
        event.state = TriggerEventState.SUCCEEDED
        event.lease_token = None
        event.lease_expires_at = None
    db.flush()
    return True


def _locked_root(db: Session, event: RecordTriggerEvent) -> RecordTriggerEvent:
    if event.root_event_id is None:
        return event
    root = db.scalar(
        select(RecordTriggerEvent)
        .where(RecordTriggerEvent.id == event.root_event_id)
        .with_for_update()
    )
    if root is None:
        raise RuntimeError("Trigger root event is unavailable")
    return root


def _definitions(db: Session, event: RecordTriggerEvent) -> list[RecordTrigger]:
    statement = (
        select(RecordTrigger)
        .where(
            RecordTrigger.enabled.is_(True),
            RecordTrigger.suspended_at.is_(None),
            RecordTrigger.module_id == event.module_id,
        )
        .order_by(
            RecordTrigger.priority,
            RecordTrigger.execution_position,
            RecordTrigger.created_at,
            RecordTrigger.id,
        )
        .with_for_update()
    )
    if event.event_kind == "schedule":
        statement = statement.where(
            RecordTrigger.id == event.scheduled_trigger_id,
            RecordTrigger.event_kind == "schedule",
        )
    else:
        statement = statement.where(
            RecordTrigger.is_deleted.is_(False),
            RecordTrigger.event_kind != "schedule",
        )
    return list(db.scalars(statement))


def _lock_module_fields(db: Session, module_id: UUID) -> dict[UUID, Field]:
    fields = list(
        db.scalars(
            select(Field).where(Field.module_id == module_id).order_by(Field.id).with_for_update()
        )
    )
    return {field.id: field for field in fields}


def _records(db: Session, event: RecordTriggerEvent) -> tuple[list[Record], bool]:
    statement = select(Record).where(Record.is_deleted.is_(False))
    if event.event_kind != "schedule":
        if event.record_id is None:
            return [], False
        return list(
            db.scalars(statement.where(Record.id == event.record_id).with_for_update())
        ), False
    statement = statement.where(Record.module_id == event.module_id)
    if event.schedule_cursor_record_id is not None:
        statement = statement.where(Record.id > event.schedule_cursor_record_id)
    if event.schedule_upper_record_id is None:
        return [], False
    statement = statement.where(Record.id <= event.schedule_upper_record_id).order_by(Record.id)
    records = list(db.scalars(statement.limit(SCHEDULE_RECORD_CHUNK).with_for_update()))
    if not records:
        return [], False
    next_exists = db.scalar(
        select(
            exists().where(
                Record.module_id == event.module_id,
                Record.is_deleted.is_(False),
                Record.id > records[-1].id,
                Record.id <= event.schedule_upper_record_id,
            )
        )
    )
    return records, bool(next_exists)


def _apply_definition(
    db: Session,
    event: RecordTriggerEvent,
    root: RecordTriggerEvent,
    definition: RecordTrigger,
    records: list[Record],
    changed: dict[UUID, tuple[Record, dict[str, object]]],
    fields: dict[UUID, Field],
) -> tuple[int, int]:
    conditions = _conditions(db, definition.id)
    actions = _actions(db, definition.id)
    matched = applied = 0
    for record in records:
        if root.action_budget <= 0:
            break
        if not _conditions_match(record, definition, conditions, fields):
            continue
        matched += 1
        changed.setdefault(record.id, (record, dict(record.data)))
        applied += _apply_actions(db, record, actions, root)
        db.flush()
    return matched, applied


def _conditions(db: Session, definition_id: UUID) -> list[RecordTriggerCondition]:
    return list(
        db.scalars(
            select(RecordTriggerCondition)
            .where(
                RecordTriggerCondition.trigger_id == definition_id,
                RecordTriggerCondition.is_deleted.is_(False),
            )
            .order_by(RecordTriggerCondition.position, RecordTriggerCondition.id)
            .with_for_update()
        )
    )


def _actions(db: Session, definition_id: UUID) -> list[RecordTriggerAction]:
    return list(
        db.scalars(
            select(RecordTriggerAction)
            .where(
                RecordTriggerAction.trigger_id == definition_id,
                RecordTriggerAction.is_deleted.is_(False),
            )
            .order_by(RecordTriggerAction.position, RecordTriggerAction.id)
            .with_for_update()
        )
    )


def _trigger_matches(
    event: RecordTriggerEvent,
    definition: RecordTrigger,
    fields: dict[UUID, Field],
) -> bool:
    if definition.event_kind == "schedule":
        return event.event_kind == "schedule" and event.scheduled_trigger_id == definition.id
    if definition.event_kind == "record-created":
        return event.event_kind == "record-created"
    field_id = definition.trigger_field_id
    if (
        field_id is None
        or event.event_kind != "field-changed"
        or str(field_id) not in event.changed_field_ids
    ):
        return False
    if definition.event_kind == "field-changed":
        return True
    target = _value(
        definition.trigger_value_kind,
        definition.trigger_literal_value,
        definition.trigger_value_field_id,
        event.values,
    )
    return _compare(
        event.values.get(str(field_id), _MISSING),
        definition.trigger_operator,
        target,
        _field_type(fields, field_id),
    ) and not _compare(
        event.previous_values.get(str(field_id), _MISSING),
        definition.trigger_operator,
        target,
        _field_type(fields, field_id),
    )


def _conditions_match(
    record: Record,
    definition: RecordTrigger,
    conditions: list[RecordTriggerCondition],
    fields: dict[UUID, Field],
) -> bool:
    outcomes = [
        _compare(
            record.data.get(str(condition.field_id), _MISSING),
            condition.operator,
            _value(
                condition.value_kind, condition.literal_value, condition.value_field_id, record.data
            ),
            _field_type(fields, condition.field_id),
        )
        for condition in conditions
    ]
    return all(outcomes) if definition.condition_operator == "all" else any(outcomes)


def _apply_actions(
    db: Session,
    record: Record,
    actions: list[RecordTriggerAction],
    root: RecordTriggerEvent,
) -> int:
    changed = 0
    for action in actions:
        if root.action_budget <= 0:
            break
        field = db.get(Field, action.target_field_id)
        if (
            field is None
            or field.is_deleted
            or field.module_id != record.module_id
            or FieldType(field.type) is FieldType.RELATIONSHIP
        ):
            continue
        value = _value(action.value_kind, action.literal_value, action.value_field_id, record.data)
        if value is _MISSING:
            continue
        normalized = validate_field_value(field, value)
        key = str(field.id)
        if key in record.data and record.data[key] == normalized:
            continue
        record.data = {**record.data, key: normalized}
        root.action_budget -= 1
        changed += 1
    return changed


def _value(
    kind: str | None, literal: dict[str, Any] | None, field_id: UUID | None, values: dict[str, Any]
) -> Any:
    if kind == "literal" and literal is not None and "value" in literal:
        return literal["value"]
    if kind == "field-reference" and field_id is not None:
        return values.get(str(field_id), _MISSING)
    return _MISSING


def _field_type(fields: dict[UUID, Field], field_id: UUID) -> FieldType | None:
    field = fields.get(field_id)
    return FieldType(field.type) if field is not None else None


def _compare(
    left: Any,
    operator: str | None,
    right: Any,
    field_type: FieldType | None = None,
) -> bool:
    if left is _MISSING or right is _MISSING or operator is None:
        return False
    if field_type is FieldType.DATETIME:
        if not isinstance(left, str) or not isinstance(right, str):
            return False
        parsed_left = parse_datetime(left)
        parsed_right = parse_datetime(right)
        if parsed_left is None or parsed_right is None:
            return False
        left, right = parsed_left, parsed_right
    if operator == "=":
        return bool(left == right)
    if operator == "!=":
        return bool(left != right)
    try:
        if operator == ">":
            return bool(left > right)
        if operator == ">=":
            return bool(left >= right)
        if operator == "<":
            return bool(left < right)
        if operator == "<=":
            return bool(left <= right)
        return False
    except TypeError:
        return False


def _finish_run(
    db: Session,
    event: RecordTriggerEvent,
    definition: RecordTrigger,
    state: str,
    details: dict[str, Any],
) -> None:
    if (
        db.scalar(
            select(RecordTriggerRun.id).where(
                RecordTriggerRun.event_id == event.id,
                RecordTriggerRun.trigger_id == definition.id,
            )
        )
        is None
    ):
        db.add(
            RecordTriggerRun(
                event_id=event.id, trigger_id=definition.id, state=state, details=details
            )
        )


def _details(
    event: RecordTriggerEvent, matched: int, applied: int, root: RecordTriggerEvent
) -> dict[str, Any]:
    values: dict[str, Any] = (
        {
            "recordsMatched": event.schedule_matched_count,
            "actionsApplied": event.schedule_action_count,
        }
        if event.event_kind == "schedule"
        else {"recordsMatched": matched, "actionsApplied": applied}
    )
    if root.action_budget <= 0:
        values["budgetExhausted"] = True
    return values


def _has_match(event: RecordTriggerEvent, matched: int) -> bool:
    return event.schedule_matched_count > 0 if event.event_kind == "schedule" else matched > 0


def _set_context(db: Session, trigger_id: UUID, name: str) -> None:
    """Attribute trigger writes to the workspace, labelled with the trigger name."""

    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=None,
        actor_label=f"Trigger: {name}"[:ACTOR_LABEL_LENGTH],
        request_id=uuid7(),
        request_method="TRIGGER",
        request_path=f"/internal/sandbox/triggers/{trigger_id}",
    )
