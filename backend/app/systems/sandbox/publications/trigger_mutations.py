"""Apply published Sandbox trigger definitions and their ordered children."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.publications.trigger_comparison import trigger_semantics_changed
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
)


def apply_record_triggers(
    db: Session,
    document: Any,
    bindings: Any,
    modules: dict[str, Module],
    fields: dict[str, Field],
    publication_id: UUID,
    version_id: UUID,
    workspace_timezone: str,
    actor_id: UUID,
) -> None:
    desired_ids = {record_trigger.id for record_trigger in document.triggers}
    for sandbox_id, binding in bindings["trigger"].items():
        if sandbox_id in desired_ids or binding.trigger_id is None:
            continue
        old = db.get(RecordTrigger, binding.trigger_id)
        if old is not None:
            old.enabled = False
            old.is_deleted = True
            old.deleted_at = datetime.now(UTC)
            old.performed_by = actor_id

    for execution_position, desired in enumerate(document.triggers):
        trigger = desired.trigger
        module_id = getattr(trigger, "module_id", None)
        if module_id is None:
            continue
        binding = bindings["trigger"].get(desired.id)
        old = (
            db.get(RecordTrigger, binding.trigger_id)
            if binding is not None
            else None
        )
        if old is not None and not old.is_deleted and not trigger_semantics_changed(
            db,
            desired,
            bindings["module"],
            bindings["field"],
            bindings["trigger"],
        ):
            old.execution_position = execution_position
            old.workspace_timezone = workspace_timezone
            old.performed_by = actor_id
            continue
        if old is not None:
            old.is_deleted = True
            old.deleted_at = datetime.now(UTC)
            old.performed_by = actor_id

        field_id = getattr(trigger, "field_id", None)
        trigger_value = getattr(trigger, "value", None)
        trigger_value_kind, trigger_literal, trigger_value_field_id = _value_columns(
            trigger_value, fields
        )
        definition = RecordTrigger(
            org_id=modules[module_id].org_id,
            publication_id=publication_id,
            published_version_id=version_id,
            publisher_id=actor_id,
            module_id=modules[module_id].id,
            name=desired.name,
            enabled=desired.enabled,
            priority=desired.priority,
            execution_position=execution_position,
            event_kind=trigger.kind,
            trigger_field_id=(
                fields[_field_key(module_id, field_id)].id if field_id is not None else None
            ),
            trigger_operator=getattr(trigger, "operator", None),
            trigger_value_kind=trigger_value_kind,
            trigger_literal_value=trigger_literal,
            trigger_value_field_id=trigger_value_field_id,
            schedule_frequency=getattr(trigger, "frequency", None),
            schedule_time=getattr(trigger, "time", None),
            schedule_weekday=getattr(trigger, "weekday", None),
            workspace_timezone=workspace_timezone,
            condition_operator=desired.condition_group.operator,
            performed_by=actor_id,
        )
        db.add(definition)
        db.flush()
        if binding is None:
            db.add(
                SandboxBinding(
                    org_id=definition.org_id,
                    kind="trigger",
                    sandbox_id=desired.id,
                    trigger_id=definition.id,
                    performed_by=actor_id,
                )
            )
        else:
            binding.trigger_id = definition.id
            binding.performed_by = actor_id

        for position, condition in enumerate(desired.condition_group.conditions):
            value_kind, literal_value, value_field_id = _value_columns(condition.value, fields)
            db.add(
                RecordTriggerCondition(
                    org_id=definition.org_id,
                    trigger_id=definition.id,
                    field_id=fields[
                        _field_key(condition.field.module_id, condition.field.field_id)
                    ].id,
                    position=position,
                    operator=condition.operator,
                    value_kind=value_kind,
                    literal_value=literal_value,
                    value_field_id=value_field_id,
                    performed_by=actor_id,
                )
            )
        for position, action in enumerate(desired.actions):
            if action.kind != "set-field":
                continue
            value_kind, literal_value, value_field_id = _value_columns(action.value, fields)
            db.add(
                RecordTriggerAction(
                    org_id=definition.org_id,
                    trigger_id=definition.id,
                    target_field_id=fields[
                        _field_key(action.target.module_id, action.target.field_id)
                    ].id,
                    position=position,
                    kind=action.kind,
                    value_kind=value_kind,
                    literal_value=literal_value,
                    value_field_id=value_field_id,
                    performed_by=actor_id,
                )
            )


def _value_columns(
    value: Any, fields: dict[str, Field]
) -> tuple[str | None, dict[str, Any] | None, UUID | None]:
    if value is None:
        return None, None, None
    if value.kind == "literal":
        return "literal", {"value": value.value}, None
    return "field-reference", None, fields[_field_key(value.module_id, value.field_id)].id
