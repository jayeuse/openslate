"""Designer-to-publication conversion and trigger planning rules."""

import json
from hashlib import sha256

from app.systems.sandbox.designs.schemas import (
    DesignField,
    RelationshipDocument,
    SandboxDocument,
    TriggerDocument,
)
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.fields.validation import field_config
from app.systems.sandbox.publications.schemas import PublicationBlocker


def _trigger_blockers(
    document: SandboxDocument, record_trigger: TriggerDocument
) -> list[PublicationBlocker]:
    blockers: list[PublicationBlocker] = []
    trigger = record_trigger.trigger
    module_id = getattr(trigger, "module_id", None)
    if trigger.kind == "schedule" and module_id is None:
        blockers.append(
            PublicationBlocker(
                code="schedule_module_required",
                message="Schedules require a module",
                target_id=record_trigger.id,
            )
        )
    if trigger.kind != "schedule" and module_id is None:
        blockers.append(
            PublicationBlocker(
                code="trigger_module_required",
                message="Trigger event requires a module",
                target_id=record_trigger.id,
            )
        )
    trigger_value = getattr(trigger, "value", None)
    blockers.extend(_value_scope_blockers(module_id, trigger_value, record_trigger.id))
    for condition in record_trigger.condition_group.conditions:
        blockers.extend(_reference_scope_blockers(condition.field, record_trigger.id))
        if module_id is not None and condition.field.module_id != module_id:
            blockers.append(
                PublicationBlocker(
                    code="trigger_cross_module_reference",
                    message="Conditions must use the trigger module",
                    target_id=record_trigger.id,
                )
            )
        blockers.extend(_value_scope_blockers(module_id, condition.value, record_trigger.id))
    for action in record_trigger.actions:
        if action.kind != "set-field":
            blockers.append(
                PublicationBlocker(
                    code="trigger_action_unsupported",
                    message="Only Set field actions can be published",
                    target_id=record_trigger.id,
                )
            )
            continue
        blockers.extend(_reference_scope_blockers(action.target, record_trigger.id))
        if module_id is not None and action.target.module_id != module_id:
            blockers.append(
                PublicationBlocker(
                    code="trigger_cross_module_reference",
                    message="Set field must target the trigger module",
                    target_id=record_trigger.id,
                )
            )
        target = _document_field(document, action.target.module_id, action.target.field_id)
        if target is not None and target.type not in {
            "Text",
            "Long text",
            "Number",
            "Integer",
            "Date",
            "Date/Time",
            "Checkbox",
            "Select",
            "User",
            "Email",
            "URL",
        }:
            blockers.append(
                PublicationBlocker(
                    code="trigger_target_not_primitive",
                    message="Set field actions must target primitive fields",
                    target_id=record_trigger.id,
                )
            )
        blockers.extend(_value_scope_blockers(module_id, action.value, record_trigger.id))
    return blockers


def _value_scope_blockers(
    module_id: str | None, value: object, target_id: str
) -> list[PublicationBlocker]:
    blockers = _reference_scope_blockers(value, target_id)
    reference_module = getattr(value, "module_id", None)
    if reference_module is not None and reference_module != module_id:
        blockers.append(
            PublicationBlocker(
                code="trigger_cross_module_reference",
                message="Trigger values must use the trigger module",
                target_id=target_id,
            )
        )
    return blockers


def _reference_scope_blockers(reference: object, target_id: str) -> list[PublicationBlocker]:
    if getattr(reference, "relationship_id", None) is None:
        return []
    return [
        PublicationBlocker(
            code="trigger_relationship_reference_unsupported",
            message="Relationship-based trigger references are not supported yet",
            target_id=target_id,
        )
    ]


def _document_field(document: SandboxDocument, module_id: str, field_id: str) -> DesignField | None:
    for module in document.design.modules:
        if module.id == module_id:
            return next((field for field in module.fields if field.id == field_id), None)
    return None


def _field_type(field: DesignField) -> str:
    return {
        "Text": "text",
        "Long text": "long_text",
        "Email": "email",
        "URL": "url",
        "Number": "number",
        "Integer": "int",
        "Date": "date",
        "Date/Time": "datetime",
        "Checkbox": "boolean",
        "Select": "select",
        "User": "user",
    }[field.type]


def _field_key(module_id: str, field_id: str) -> str:
    key = f"field:raw:{len(module_id)}:{module_id}:{field_id}"
    if len(key) <= 1_000:
        return key
    return f"field:hash:{sha256(f'{module_id}\x00{field_id}'.encode()).hexdigest()}"


def relationship_metadata(relationship: RelationshipDocument) -> tuple[bool, bool]:
    return {
        "one-to-one": (False, False),
        "one-to-many": (True, False),
        "many-to-many": (True, True),
    }[relationship.cardinality]


def operational_config(field: DesignField) -> dict[str, object]:
    """Convert the designer contract to the operational field validator contract."""

    config = field.config.model_dump(by_alias=True, exclude={"kind"})
    if field.type in {"Number", "Integer"}:
        converted = {
            "defaultValue": config.get("defaultValue"),
            "minimum": config.get("min"),
            "maximum": config.get("max"),
            "step": config.get("step"),
        }
    elif field.type in {"Text", "Long text", "Email", "URL"}:
        converted = {
            "defaultValue": config.get("defaultValue"),
            "maxLength": config.get("maxLength"),
        }
    elif field.type in {"Date", "Date/Time"}:
        converted = {
            "defaultValue": config.get("defaultValue"),
            "earliest": config.get("earliest"),
            "latest": config.get("latest"),
        }
    elif field.type == "Checkbox":
        converted = {"defaultValue": config.get("defaultValue")}
    elif field.type == "Select":
        converted = {
            "defaultValue": config.get("defaultValue"),
            "options": config.get("options"),
        }
    else:
        converted = {}
    present = {key: value for key, value in converted.items() if value is not None}
    return field_config(FieldType(_field_type(field)), present)


def _digest(value: object) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
