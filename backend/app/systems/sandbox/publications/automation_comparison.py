"""Semantic comparison for a designer automation and its published revision."""

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.designs.schemas import AutomationDocument
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.publications.snapshot import PublicationSnapshot


def automation_semantics_changed(
    db: Session,
    desired: AutomationDocument,
    module_bindings: dict[str, SandboxBinding],
    field_bindings: dict[str, SandboxBinding],
    automation_bindings: dict[str, SandboxBinding],
    *,
    snapshot: PublicationSnapshot | None = None,
) -> bool:
    binding = automation_bindings.get(desired.id)
    live = None
    if binding is not None and binding.automation_id is not None:
        live = (
            snapshot.automations.get(binding.automation_id)
            if snapshot is not None
            else db.get(PublishedAutomationDefinition, binding.automation_id)
        )
    if live is None:
        return False
    if snapshot is None:
        conditions = list(
            db.scalars(
                select(PublishedAutomationCondition)
                .where(
                    PublishedAutomationCondition.automation_id == live.id,
                    PublishedAutomationCondition.is_deleted.is_(False),
                )
                .order_by(PublishedAutomationCondition.position)
            )
        )
        actions = list(
            db.scalars(
                select(PublishedAutomationAction)
                .where(
                    PublishedAutomationAction.automation_id == live.id,
                    PublishedAutomationAction.is_deleted.is_(False),
                )
                .order_by(PublishedAutomationAction.position)
            )
        )
    else:
        conditions = snapshot.conditions.get(live.id, [])
        actions = snapshot.actions.get(live.id, [])
    desired_signature = desired_automation_signature(
        desired,
        module_bindings,
        field_bindings,
    )
    if desired_signature is None:
        return True
    return desired_signature != published_automation_signature(live, conditions, actions)


def desired_automation_signature(
    automation: AutomationDocument,
    module_bindings: dict[str, SandboxBinding],
    field_bindings: dict[str, SandboxBinding],
) -> tuple[object, ...] | None:
    trigger = automation.trigger
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
        for position, condition in enumerate(automation.condition_group.conditions)
    )
    actions = tuple(
        (
            position,
            action.kind,
            str(field_id(action.target.module_id, action.target.field_id)),
            value_signature(action.value),
        )
        for position, action in enumerate(automation.actions)
        if action.kind == "set-field"
    )
    return (
        automation.name,
        automation.enabled,
        automation.priority,
        trigger_signature,
        automation.condition_group.operator,
        conditions,
        actions,
    )


def published_automation_signature(
    automation: PublishedAutomationDefinition,
    conditions: list[PublishedAutomationCondition],
    actions: list[PublishedAutomationAction],
) -> tuple[object, ...]:
    trigger_signature = (
        automation.trigger_kind,
        str(automation.module_id),
        str(automation.trigger_field_id) if automation.trigger_field_id is not None else None,
        automation.trigger_operator,
        _published_value_signature(
            automation.trigger_value_kind,
            automation.trigger_literal_value,
            automation.trigger_value_field_id,
        ),
        automation.schedule_frequency,
        automation.schedule_time,
        automation.schedule_weekday,
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
        automation.name,
        automation.enabled,
        automation.priority,
        trigger_signature,
        automation.condition_operator,
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
