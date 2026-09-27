"""Shared publication fixtures for durable trigger integration tests."""

from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from sqlalchemy import Engine, delete, func, or_, select, update
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import SandboxDocument, TriggerDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import apply_publication, request_fingerprint
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
    RecordTriggerEvent,
    RecordTriggerRun,
)


@dataclass(frozen=True)
class DocumentBaseline:
    id: UUID
    revision: int
    document: dict[str, Any]
    content_hash: str
    byte_count: int
    performed_by: UUID | None
    updated_at: datetime


def document_baseline(db: Session) -> DocumentBaseline:
    row = db.scalar(select(SandboxDocumentRow))
    assert row is not None
    return DocumentBaseline(
        id=row.id,
        revision=row.revision,
        document=deepcopy(row.document),
        content_hash=row.content_hash,
        byte_count=row.byte_count,
        performed_by=row.performed_by,
        updated_at=row.updated_at,
    )


def cleanup_committed_trigger(
    engine: Engine,
    *,
    actor_id: UUID,
    module_id: UUID,
    definition_id: UUID,
    baseline: DocumentBaseline,
) -> None:
    """Remove only rows committed by a direct multi-session trigger test."""

    with engine.begin() as connection:
        event_ids = list(
            connection.scalars(
                select(RecordTriggerEvent.id).where(
                    RecordTriggerEvent.module_id == module_id
                )
            )
        )
        connection.execute(
            delete(RecordTriggerRun).where(
                RecordTriggerRun.trigger_id == definition_id
            )
        )
        connection.execute(
            delete(RecordTriggerEvent).where(RecordTriggerEvent.module_id == module_id)
        )
        connection.execute(delete(SandboxBinding).where(SandboxBinding.performed_by == actor_id))
        connection.execute(
            delete(RecordTriggerAction).where(
                RecordTriggerAction.trigger_id == definition_id
            )
        )
        connection.execute(
            delete(RecordTriggerCondition).where(
                RecordTriggerCondition.trigger_id == definition_id
            )
        )
        connection.execute(
            delete(RecordTrigger).where(
                RecordTrigger.id == definition_id
            )
        )
        connection.execute(
            delete(SandboxPublication).where(SandboxPublication.actor_id == actor_id)
        )
        connection.execute(delete(SandboxVersion).where(SandboxVersion.performed_by == actor_id))
        connection.execute(delete(Field).where(Field.module_id == module_id))
        connection.execute(delete(Module).where(Module.id == module_id))
        connection.execute(delete(Department).where(Department.performed_by == actor_id))
        connection.execute(
            update(SandboxDocumentRow)
            .where(SandboxDocumentRow.id == baseline.id)
            .values(
                revision=baseline.revision,
                document=baseline.document,
                content_hash=baseline.content_hash,
                byte_count=baseline.byte_count,
                performed_by=baseline.performed_by,
                updated_at=baseline.updated_at,
            )
        )
        audit_filter = or_(
            AuditLog.performed_by == actor_id,
            AuditLog.entity_id == actor_id,
            AuditLog.request_path == f"/internal/sandbox/triggers/{definition_id}",
        )
        if event_ids:
            audit_filter = or_(audit_filter, AuditLog.entity_id.in_(event_ids))
        connection.execute(delete(AuditLog).where(audit_filter))
        connection.execute(delete(User).where(User.id == actor_id))


def publish_trigger(
    db: Session,
    *,
    record_trigger: TriggerDocument | None = None,
    triggers: Sequence[TriggerDocument] | None = None,
) -> tuple[User, Module, dict[str, Field], RecordTrigger]:
    role = "admin"
    assert role is not None
    actor = User(
        email=f"trigger-{uuid7()}@example.test",
        username=f"trigger-{uuid7()}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(actor)
    db.flush()
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=actor.id,
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/sandbox/publications",
    )
    initial = read_document(db)
    if triggers is not None and record_trigger is not None:
        raise ValueError("Pass either trigger or triggers")
    selected_triggers = list(triggers) if triggers is not None else [
        record_trigger or field_change_trigger()
    ]
    if not selected_triggers:
        raise ValueError("At least one trigger is required")
    selected = selected_triggers[0]
    document = publication_document(selected_triggers)
    saved = replace_document(
        db,
        actor_id=actor.id,
        expected_revision=initial.revision,
        document=document,
    )
    preview = publication_plan(db, saved.document)
    assert not preview.blockers
    token_digest = sha256(f"trigger-{actor.id}".encode()).hexdigest()
    apply_publication(
        db,
        actor_id=actor.id,
        expected_revision=saved.revision,
        impact_digest=preview.impact_digest,
        expected_live_state_digest=preview.live_state_digest,
        preview_token_digest=token_digest,
        idempotency_key=f"trigger-{actor.id}",
        fingerprint=request_fingerprint(
            expected_revision=saved.revision,
            document_hash=saved.content_hash,
            impact_digest=preview.impact_digest,
            preview_token_digest=token_digest,
            note=None,
        ),
        note=None,
    )
    module = bound_module(db, "sample-requests")
    fields = {
        name: bound_field(db, _field_key("sample-requests", f"sample-field-requests-{identifier}"))
        for name, identifier in {
            "request-number": "request-number",
            "title": "title",
            "status": "status",
            "priority": "priority",
        }.items()
    }
    definition = db.scalar(
        select(RecordTrigger).where(
            RecordTrigger.name == selected.name,
            RecordTrigger.is_deleted.is_(False),
        )
    )
    assert definition is not None
    return actor, module, fields, definition


def publication_document(triggers: Sequence[TriggerDocument]) -> SandboxDocument:
    return SandboxDocument.model_validate(
        {
            "kind": "openslate-sandbox",
            "schemaVersion": 3,
            "design": {
                "departments": [{"id": "sample-operations", "name": "Operations"}],
                "modules": [
                    {
                        "id": "sample-requests",
                        "departmentId": "sample-operations",
                        "name": "Requests",
                        "fields": [
                            {
                                "id": "sample-field-requests-request-number",
                                "name": "Request number",
                                "type": "Text",
                                "required": True,
                                "config": {"kind": "text", "defaultValue": ""},
                            },
                            {
                                "id": "sample-field-requests-title",
                                "name": "Title",
                                "type": "Text",
                                "config": {"kind": "text", "defaultValue": ""},
                            },
                            {
                                "id": "sample-field-requests-status",
                                "name": "Status",
                                "type": "Select",
                                "config": {
                                    "kind": "select",
                                    "defaultValue": "Open",
                                    "options": ["Open", "In progress", "Complete"],
                                },
                            },
                            {
                                "id": "sample-field-requests-priority",
                                "name": "Priority",
                                "type": "Select",
                                "config": {
                                    "kind": "select",
                                    "defaultValue": "Low",
                                    "options": ["Low", "High"],
                                },
                            },
                        ],
                    }
                ],
                "relationships": [],
                "layout": {
                    "sample-operations": {"x": 0, "y": 0, "width": 600, "height": 300},
                    "sample-requests": {"x": 40, "y": 40, "width": 280, "height": 220},
                },
            },
            "triggers": [item.model_dump(by_alias=True, mode="json") for item in triggers],
            "scenarios": [],
        }
    )


def field_change_trigger() -> TriggerDocument:
    return TriggerDocument.model_validate(
        {
            "id": "set-request-status",
            "name": "Set request status",
            "enabled": True,
            "priority": 0,
            "trigger": {
                "kind": "field-changed",
                "moduleId": "sample-requests",
                "fieldId": "sample-field-requests-priority",
            },
            "conditionGroup": {
                "operator": "all",
                "conditions": [
                    {
                        "id": "priority-high",
                        "field": {
                            "moduleId": "sample-requests",
                            "fieldId": "sample-field-requests-priority",
                        },
                        "operator": "=",
                        "value": {"kind": "literal", "value": "High"},
                    }
                ],
            },
            "actions": [
                {
                    "id": "set-in-progress",
                    "kind": "set-field",
                    "target": {
                        "moduleId": "sample-requests",
                        "fieldId": "sample-field-requests-status",
                    },
                    "value": {"kind": "literal", "value": "In progress"},
                }
            ],
        }
    )


def schedule_trigger() -> TriggerDocument:
    payload = field_change_trigger().model_dump(by_alias=True, mode="json")
    payload["id"] = "complete-on-schedule"
    payload["name"] = "Complete requests on schedule"
    payload["trigger"] = {
        "kind": "schedule",
        "moduleId": "sample-requests",
        "frequency": "daily",
        "time": "08:30",
    }
    payload["conditionGroup"] = {"operator": "all", "conditions": []}
    payload["actions"][0]["value"] = {"kind": "literal", "value": "Complete"}
    return TriggerDocument.model_validate(payload)


def bound_module(db: Session, sandbox_id: str) -> Module:
    binding = db.scalar(
        select(SandboxBinding).where(
            SandboxBinding.kind == "module", SandboxBinding.sandbox_id == sandbox_id
        )
    )
    assert binding is not None and binding.module_id is not None
    module = db.get(Module, binding.module_id)
    assert module is not None
    return module


def bound_field(db: Session, sandbox_id: str) -> Field:
    binding = db.scalar(
        select(SandboxBinding).where(
            SandboxBinding.kind == "field", SandboxBinding.sandbox_id == sandbox_id
        )
    )
    assert binding is not None and binding.field_id is not None
    field = db.get(Field, binding.field_id)
    assert field is not None
    return field


def event_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(RecordTriggerEvent)) or 0
