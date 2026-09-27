"""Publication live-state digest construction."""

import json
from hashlib import sha256

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.snapshot import (
    PublicationSnapshot,
    load_publication_snapshot,
)
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


def live_state_digest(
    db: Session,
    bindings: list[SandboxBinding],
    timezone: str,
    *,
    snapshot: PublicationSnapshot | None = None,
) -> str:
    if snapshot is None:
        snapshot = load_publication_snapshot(db, bindings)
    rows: list[dict[str, object]] = []
    for binding in bindings:
        target = snapshot.binding_target(binding)
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
            (str(identifier), name, deleted, updated.isoformat())
            for identifier, name, deleted, updated in db.execute(
                select(
                    Department.id,
                    Department.department_name,
                    Department.is_deleted,
                    Department.updated_at,
                ).order_by(Department.id)
            )
        ],
        "modules": [
            (
                str(row.id),
                str(row.department_id),
                row.module_name,
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.execute(
                select(
                    Module.id,
                    Module.department_id,
                    Module.module_name,
                    Module.is_deleted,
                    Module.updated_at,
                ).order_by(Module.id)
            )
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
            for row in db.execute(
                select(
                    Field.id,
                    Field.module_id,
                    Field.name,
                    Field.type,
                    Field.position,
                    Field.required,
                    Field.config,
                    Field.audit_redacted,
                    Field.relationship_target_module_id,
                    Field.relationship_multiple_targets,
                    Field.relationship_multiple_sources,
                    Field.is_deleted,
                    Field.updated_at,
                ).order_by(Field.id)
            )
        ],
        "records": [
            (str(identifier), str(module_id), deleted, _digest(data))
            for identifier, module_id, deleted, data in db.execute(
                select(Record.id, Record.module_id, Record.is_deleted, Record.data)
                .order_by(Record.id)
                .execution_options(yield_per=500)
            )
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
            for row in db.execute(
                select(
                    RelationshipEdge.id,
                    RelationshipEdge.field_id,
                    RelationshipEdge.source_record_id,
                    RelationshipEdge.target_record_id,
                    RelationshipEdge.is_deleted,
                    RelationshipEdge.updated_at,
                ).order_by(RelationshipEdge.id)
            )
        ],
        "triggers": [
            (
                str(row.id),
                str(row.publication_id),
                str(row.published_version_id),
                str(row.publisher_id),
                str(row.module_id),
                row.name,
                row.enabled,
                row.priority,
                row.event_kind,
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
            for row in db.execute(
                select(
                    RecordTrigger.id,
                    RecordTrigger.publication_id,
                    RecordTrigger.published_version_id,
                    RecordTrigger.publisher_id,
                    RecordTrigger.module_id,
                    RecordTrigger.name,
                    RecordTrigger.enabled,
                    RecordTrigger.priority,
                    RecordTrigger.event_kind,
                    RecordTrigger.trigger_field_id,
                    RecordTrigger.trigger_operator,
                    RecordTrigger.trigger_value_kind,
                    RecordTrigger.trigger_literal_value,
                    RecordTrigger.trigger_value_field_id,
                    RecordTrigger.schedule_frequency,
                    RecordTrigger.schedule_time,
                    RecordTrigger.schedule_weekday,
                    RecordTrigger.workspace_timezone,
                    RecordTrigger.condition_operator,
                    RecordTrigger.is_deleted,
                    RecordTrigger.updated_at,
                ).order_by(RecordTrigger.id)
            )
        ],
        "conditions": [
            (
                str(row.id),
                str(row.trigger_id),
                str(row.field_id),
                row.position,
                row.operator,
                row.value_kind,
                row.literal_value,
                row.value_field_id and str(row.value_field_id),
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.execute(
                select(
                    RecordTriggerCondition.id,
                    RecordTriggerCondition.trigger_id,
                    RecordTriggerCondition.field_id,
                    RecordTriggerCondition.position,
                    RecordTriggerCondition.operator,
                    RecordTriggerCondition.value_kind,
                    RecordTriggerCondition.literal_value,
                    RecordTriggerCondition.value_field_id,
                    RecordTriggerCondition.is_deleted,
                    RecordTriggerCondition.updated_at,
                ).order_by(RecordTriggerCondition.id)
            )
        ],
        "actions": [
            (
                str(row.id),
                str(row.trigger_id),
                str(row.target_field_id),
                row.position,
                row.kind,
                row.value_kind,
                row.literal_value,
                row.value_field_id and str(row.value_field_id),
                row.is_deleted,
                row.updated_at.isoformat(),
            )
            for row in db.execute(
                select(
                    RecordTriggerAction.id,
                    RecordTriggerAction.trigger_id,
                    RecordTriggerAction.target_field_id,
                    RecordTriggerAction.position,
                    RecordTriggerAction.kind,
                    RecordTriggerAction.value_kind,
                    RecordTriggerAction.literal_value,
                    RecordTriggerAction.value_field_id,
                    RecordTriggerAction.is_deleted,
                    RecordTriggerAction.updated_at,
                ).order_by(RecordTriggerAction.id)
            )
        ],
    }
    return _digest({"timezone": timezone, "bindings": rows, "live": structural})


def _digest(value: object) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
