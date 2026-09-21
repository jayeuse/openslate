"""Published automation evaluation and bounded schedule continuation."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import Role, User
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.sandbox.automations.execution import (
    ClaimedAutomationEvent,
    locked_claim,
    release_schedule_continuation,
)
from app.systems.sandbox.automations.models import (
    AutomationEventState,
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.automations.outbox import enqueue_child_field_event
from app.systems.sandbox.designs.date_values import parse_datetime
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import validate_field_value
from app.systems.sandbox.records.models import Record

SCHEDULE_RECORD_CHUNK = 100
_MISSING = object()


def execute_claim(db: Session, claim: ClaimedAutomationEvent) -> bool:
    """Execute one fenced event, requeuing only successful schedule continuations."""

    event = locked_claim(db, claim)
    if event is None:
        return False
    root = _locked_root(db, event)
    definition_ids, publisher_ids = _candidate_definition_ids(db, event)
    _lock_publishers(db, publisher_ids)
    fields = _lock_module_fields(db, event.module_id)
    records, has_more = _records(db, event)
    definitions = _definitions(db, event, definition_ids)
    changed: dict[UUID, tuple[Record, dict[str, object]]] = {}
    for definition in definitions:
        _set_context(db, definition.publisher_id, definition.id)
        if not _publisher_can_write(db, definition.publisher_id):
            _suspend(definition)
            _finish_run(db, event, definition, "suspended", {})
            db.flush()
            continue
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
        event.state = AutomationEventState.SUCCEEDED
        event.lease_token = None
        event.lease_expires_at = None
    db.flush()
    return True


def _locked_root(db: Session, event: PublishedAutomationEvent) -> PublishedAutomationEvent:
    if event.root_event_id is None:
        return event
    root = db.scalar(
        select(PublishedAutomationEvent)
        .where(PublishedAutomationEvent.id == event.root_event_id)
        .with_for_update()
    )
    if root is None:
        raise RuntimeError("Automation root event is unavailable")
    return root


def _definitions(
    db: Session,
    event: PublishedAutomationEvent,
    allowed_ids: set[UUID],
) -> list[PublishedAutomationDefinition]:
    if not allowed_ids:
        return []
    statement = (
        select(PublishedAutomationDefinition)
        .where(
            PublishedAutomationDefinition.enabled.is_(True),
            PublishedAutomationDefinition.is_deleted.is_(False),
            PublishedAutomationDefinition.suspended_at.is_(None),
            PublishedAutomationDefinition.module_id == event.module_id,
        )
        .order_by(
            PublishedAutomationDefinition.priority,
            PublishedAutomationDefinition.execution_position,
            PublishedAutomationDefinition.created_at,
            PublishedAutomationDefinition.id,
        )
        .with_for_update()
    )
    if event.event_kind == "schedule":
        statement = statement.where(
            PublishedAutomationDefinition.id == event.scheduled_automation_id,
            PublishedAutomationDefinition.trigger_kind == "schedule",
        )
    else:
        statement = statement.where(PublishedAutomationDefinition.trigger_kind != "schedule")
    return list(db.scalars(statement.where(PublishedAutomationDefinition.id.in_(allowed_ids))))


def _candidate_definition_ids(
    db: Session, event: PublishedAutomationEvent
) -> tuple[set[UUID], set[UUID]]:
    statement = select(
        PublishedAutomationDefinition.id, PublishedAutomationDefinition.publisher_id
    ).where(
        PublishedAutomationDefinition.enabled.is_(True),
        PublishedAutomationDefinition.is_deleted.is_(False),
        PublishedAutomationDefinition.suspended_at.is_(None),
        PublishedAutomationDefinition.module_id == event.module_id,
    )
    if event.event_kind == "schedule":
        statement = statement.where(
            PublishedAutomationDefinition.id == event.scheduled_automation_id,
            PublishedAutomationDefinition.trigger_kind == "schedule",
        )
    else:
        statement = statement.where(PublishedAutomationDefinition.trigger_kind != "schedule")
    rows = db.execute(statement).all()
    return {row.id for row in rows}, {row.publisher_id for row in rows}


def _lock_publishers(db: Session, publisher_ids: set[UUID]) -> None:
    if not publisher_ids:
        return
    publishers = list(
        db.scalars(
            select(User).where(User.id.in_(publisher_ids)).order_by(User.id).with_for_update()
        )
    )
    role_ids = {publisher.role_id for publisher in publishers}
    if role_ids:
        list(
            db.scalars(
                select(Role).where(Role.id.in_(role_ids)).order_by(Role.id).with_for_update()
            )
        )


def _lock_module_fields(db: Session, module_id: UUID) -> dict[UUID, Field]:
    fields = list(
        db.scalars(
            select(Field).where(Field.module_id == module_id).order_by(Field.id).with_for_update()
        )
    )
    return {field.id: field for field in fields}


def _records(db: Session, event: PublishedAutomationEvent) -> tuple[list[Record], bool]:
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
    event: PublishedAutomationEvent,
    root: PublishedAutomationEvent,
    definition: PublishedAutomationDefinition,
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


def _conditions(db: Session, definition_id: UUID) -> list[PublishedAutomationCondition]:
    return list(
        db.scalars(
            select(PublishedAutomationCondition)
            .where(
                PublishedAutomationCondition.automation_id == definition_id,
                PublishedAutomationCondition.is_deleted.is_(False),
            )
            .order_by(PublishedAutomationCondition.position, PublishedAutomationCondition.id)
            .with_for_update()
        )
    )


def _actions(db: Session, definition_id: UUID) -> list[PublishedAutomationAction]:
    return list(
        db.scalars(
            select(PublishedAutomationAction)
            .where(
                PublishedAutomationAction.automation_id == definition_id,
                PublishedAutomationAction.is_deleted.is_(False),
            )
            .order_by(PublishedAutomationAction.position, PublishedAutomationAction.id)
            .with_for_update()
        )
    )


def _publisher_can_write(db: Session, publisher_id: UUID) -> bool:
    publisher = db.scalar(
        select(User)
        .options(joinedload(User.role))
        .where(User.id == publisher_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User)
    )
    role = (
        db.scalar(select(Role).where(Role.id == publisher.role_id).with_for_update())
        if publisher
        else None
    )
    return bool(
        publisher
        and role
        and not publisher.is_deleted
        and publisher.status == "active"
        and is_established_user(publisher)
        and not role.is_deleted
        and has_capability(role, Capability.RECORDS_WRITE)
    )


def _trigger_matches(
    event: PublishedAutomationEvent,
    definition: PublishedAutomationDefinition,
    fields: dict[UUID, Field],
) -> bool:
    if definition.trigger_kind == "schedule":
        return event.event_kind == "schedule" and event.scheduled_automation_id == definition.id
    if definition.trigger_kind == "record-created":
        return event.event_kind == "record-created"
    field_id = definition.trigger_field_id
    if (
        field_id is None
        or event.event_kind != "field-changed"
        or str(field_id) not in event.changed_field_ids
    ):
        return False
    if definition.trigger_kind == "field-changed":
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
    definition: PublishedAutomationDefinition,
    conditions: list[PublishedAutomationCondition],
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
    actions: list[PublishedAutomationAction],
    root: PublishedAutomationEvent,
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


def _suspend(definition: PublishedAutomationDefinition) -> None:
    definition.enabled = False
    definition.suspended_at = utc_now()
    definition.suspension_reason = "Publisher no longer has permission to update records"


def _finish_run(
    db: Session,
    event: PublishedAutomationEvent,
    definition: PublishedAutomationDefinition,
    state: str,
    details: dict[str, Any],
) -> None:
    if (
        db.scalar(
            select(PublishedAutomationRun.id).where(
                PublishedAutomationRun.event_id == event.id,
                PublishedAutomationRun.automation_id == definition.id,
            )
        )
        is None
    ):
        db.add(
            PublishedAutomationRun(
                event_id=event.id, automation_id=definition.id, state=state, details=details
            )
        )


def _details(
    event: PublishedAutomationEvent, matched: int, applied: int, root: PublishedAutomationEvent
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


def _has_match(event: PublishedAutomationEvent, matched: int) -> bool:
    return event.schedule_matched_count > 0 if event.event_kind == "schedule" else matched > 0


def _set_context(db: Session, publisher_id: UUID, automation_id: UUID) -> None:
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=publisher_id,
        request_id=uuid7(),
        request_method="AUTOMATION",
        request_path=f"/internal/sandbox/automations/{automation_id}",
    )
