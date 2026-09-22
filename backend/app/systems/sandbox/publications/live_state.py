"""Publication live-state digest construction."""

import json
from hashlib import sha256

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


def live_state_digest(db: Session, bindings: list[SandboxBinding], timezone: str) -> str:
    rows: list[dict[str, object]] = []
    for binding in bindings:
        target: object | None
        if binding.kind == "department":
            target = db.get(Department, binding.department_id)
        elif binding.kind == "module":
            target = db.get(Module, binding.module_id)
        elif binding.kind in {"field", "relationship"}:
            target = db.get(Field, binding.field_id)
        elif binding.kind == "automation":
            target = db.get(PublishedAutomationDefinition, binding.automation_id)
        else:
            target = None
        if target is None:
            rows.append(
                {
                    "kind": binding.kind,
                    "sandbox": binding.sandbox_id,
                    "bindingId": str(binding.id),
                    "bindingUpdated": binding.updated_at.isoformat(),
                    "bindingDeleted": binding.is_deleted,
                    "missing": True,
                }
            )
            continue
        rows.append(
            {
                "kind": binding.kind,
                "sandbox": binding.sandbox_id,
                "bindingId": str(binding.id),
                "bindingUpdated": binding.updated_at.isoformat(),
                "bindingDeleted": binding.is_deleted,
                "id": str(target.id),
                "updated": target.updated_at.isoformat(),
                "deleted": target.is_deleted,
            }
        )
    structural = {
        "departments": [
            (str(row.id), row.department_name, row.is_deleted, row.updated_at.isoformat())
            for row in db.scalars(select(Department).order_by(Department.id))
        ],
        "modules": [
            (
                str(row.id),
                str(row.department_id),
                row.module_name,
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.scalars(select(Module).order_by(Module.id))
        ],
        "fields": [
            (
                str(row.id),
                str(row.module_id),
                row.name,
                row.type,
                row.position,
                row.required,
                row.config,
                row.audit_redacted,
                row.relationship_target_module_id and str(row.relationship_target_module_id),
                row.relationship_multiple_targets,
                row.relationship_multiple_sources,
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.scalars(select(Field).order_by(Field.id))
        ],
        "records": [
            (str(row.id), str(row.module_id), row.is_deleted, _digest(row.data))
            for row in db.scalars(select(Record).order_by(Record.id))
        ],
        "edges": [
            (
                str(row.id),
                str(row.field_id),
                str(row.source_record_id),
                str(row.target_record_id),
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.scalars(select(RelationshipEdge).order_by(RelationshipEdge.id))
        ],
        "automations": [
            (
                str(row.id),
                str(row.publication_id),
                str(row.published_version_id),
                str(row.publisher_id),
                str(row.module_id),
                row.name,
                row.enabled,
                row.priority,
                row.trigger_kind,
                row.trigger_field_id and str(row.trigger_field_id),
                row.trigger_operator,
                row.trigger_value_kind,
                row.trigger_literal_value,
                row.trigger_value_field_id and str(row.trigger_value_field_id),
                row.schedule_frequency,
                row.schedule_time,
                row.schedule_weekday,
                row.workspace_timezone,
                row.condition_operator,
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.scalars(
                select(PublishedAutomationDefinition).order_by(PublishedAutomationDefinition.id)
            )
        ],
        "conditions": [
            (
                str(row.id),
                str(row.automation_id),
                str(row.field_id),
                row.position,
                row.operator,
                row.value_kind,
                row.literal_value,
                row.value_field_id and str(row.value_field_id),
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.scalars(
                select(PublishedAutomationCondition).order_by(PublishedAutomationCondition.id)
            )
        ],
        "actions": [
            (
                str(row.id),
                str(row.automation_id),
                str(row.target_field_id),
                row.position,
                row.kind,
                row.value_kind,
                row.literal_value,
                row.value_field_id and str(row.value_field_id),
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.scalars(
                select(PublishedAutomationAction).order_by(PublishedAutomationAction.id)
            )
        ],
    }
    return _digest({"timezone": timezone, "bindings": rows, "live": structural})


def _digest(value: object) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
