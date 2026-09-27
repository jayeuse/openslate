"""Semantic comparison for a designer trigger and its published revision."""

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.schemas import TriggerDocument
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.publications.snapshot import PublicationSnapshot
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
)


def trigger_semantics_changed(
    db: Session,
    desired: TriggerDocument,
    module_bindings: dict[str, SandboxBinding],
    field_bindings: dict[str, SandboxBinding],
    trigger_bindings: dict[str, SandboxBinding],
    *,
    snapshot: PublicationSnapshot | None = None,
) -> bool:
    binding = trigger_bindings.get(desired.id)
    live = None
    if binding is not None and binding.trigger_id is not None:
        live = (
            snapshot.triggers.get(binding.trigger_id)
            if snapshot is not None
            else db.get(RecordTrigger, binding.trigger_id)
        )
    if live is None:
        return False
    if snapshot is None:
        conditions = list(
            db.scalars(
                select(RecordTriggerCondition)
                .where(
                    RecordTriggerCondition.trigger_id == live.id,
                    RecordTriggerCondition.is_deleted.is_(False),
                )
                .order_by(RecordTriggerCondition.position)
            )
        )
        actions = list(
            db.scalars(
                select(RecordTriggerAction)
                .where(
                    RecordTriggerAction.trigger_id == live.id,
                    RecordTriggerAction.is_deleted.is_(False),
                )
                .order_by(RecordTriggerAction.position)
            )
        )
    else:
        conditions = snapshot.conditions.get(live.id, [])
        actions = snapshot.actions.get(live.id, [])
    desired_signature = desired_trigger_signature(
        desired,
        module_bindings,
        field_bindings,
    )
    if desired_signature is None:
        return True
    return desired_signature != record_trigger_signature(live, conditions, actions)


def desired_trigger_signature(
    record_trigger: TriggerDocument,
    module_bindings: dict[str, SandboxBinding],
    field_bindings: dict[str, SandboxBinding],
) -> tuple[object, ...] | None:
    trigger = record_trigger.trigger
    module_binding = module_bindings.get(trigger.module_id)
    if module_binding is None or module_binding.module_id is None:
        return None

    def field_id(module_id: str, sandbox_id: str) -> UUID | None:
        binding = field_bindings.get(_field_key(module_id, sandbox_id))
        return binding.field_id if binding is not None else None

    def value_signature(value: Any) -> tuple[object, ...] | None:
        if value is None:
            return None
        if value.kind == "literal":
            return ("literal", {"value": value.value}, None)
        resolved = field_id(value.module_id, value.field_id)
        return ("field-reference", None, resolved and str(resolved))

    trigger_field = getattr(trigger, "field_id", None)
    trigger_signature = (
        trigger.kind,
        str(module_binding.module_id),
        str(field_id(trigger.module_id, trigger_field)) if trigger_field is not None else None,
        getattr(trigger, "operator", None),
        value_signature(getattr(trigger, "value", None)),
        getattr(trigger, "frequency", None),
        getattr(trigger, "time", None),
        getattr(trigger, "weekday", None),
    )
    conditions = tuple(
        (
            position,
            str(field_id(condition.field.module_id, condition.field.field_id)),
            condition.operator,
            value_signature(condition.value),
        )
        for position, condition in enumerate(record_trigger.condition_group.conditions)
    )
    actions = tuple(
        (
            position,
            action.kind,
            str(field_id(action.target.module_id, action.target.field_id)),
            value_signature(action.value),
        )
        for position, action in enumerate(record_trigger.actions)
        if action.kind == "set-field"
    )
    return (
        record_trigger.name,
        record_trigger.enabled,
        record_trigger.priority,
        trigger_signature,
        record_trigger.condition_group.operator,
        conditions,
        actions,
    )


def record_trigger_signature(
    record_trigger: RecordTrigger,
    conditions: list[RecordTriggerCondition],
    actions: list[RecordTriggerAction],
) -> tuple[object, ...]:
    trigger_signature = (
        record_trigger.event_kind,
        str(record_trigger.module_id),
        (
            str(record_trigger.trigger_field_id)
            if record_trigger.trigger_field_id is not None
            else None
        ),
        record_trigger.trigger_operator,
        _published_value_signature(
            record_trigger.trigger_value_kind,
            record_trigger.trigger_literal_value,
            record_trigger.trigger_value_field_id,
        ),
        record_trigger.schedule_frequency,
        record_trigger.schedule_time,
        record_trigger.schedule_weekday,
    )
    condition_signature = tuple(
        (
            condition.position,
            str(condition.field_id),
            condition.operator,
            _published_value_signature(
                condition.value_kind,
                condition.literal_value,
                condition.value_field_id,
            ),
        )
        for condition in conditions
    )
    action_signature = tuple(
        (
            action.position,
            action.kind,
            str(action.target_field_id),
            _published_value_signature(
                action.value_kind,
                action.literal_value,
                action.value_field_id,
            ),
        )
        for action in actions
    )
    return (
        record_trigger.name,
        record_trigger.enabled,
        record_trigger.priority,
        trigger_signature,
        record_trigger.condition_operator,
        condition_signature,
        action_signature,
    )


def _published_value_signature(
    kind: str | None,
    literal: dict[str, Any] | None,
    field_id: UUID | None,
) -> tuple[object, ...] | None:
    if kind is None:
        return None
    return (kind, literal, str(field_id) if field_id is not None else None)
