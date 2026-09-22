"""Shared publication fixtures for durable automation integration tests."""

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

from app.systems.access.users.models import Role, User, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import AutomationDocument, SandboxDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import apply_publication, request_fingerprint
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key


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


def cleanup_committed_automation(
    engine: Engine,
    *,
    actor_id: UUID,
    module_id: UUID,
    definition_id: UUID,
    baseline: DocumentBaseline,
) -> None:
    """Remove only rows committed by a direct multi-session automation test."""

    with engine.begin() as connection:
        event_ids = list(
            connection.scalars(
                select(PublishedAutomationEvent.id).where(
                    PublishedAutomationEvent.module_id == module_id
                )
            )
        )
        connection.execute(
            delete(PublishedAutomationRun).where(
                PublishedAutomationRun.automation_id == definition_id
            )
        )
        connection.execute(
            delete(PublishedAutomationEvent).where(PublishedAutomationEvent.module_id == module_id)
        )
        connection.execute(delete(SandboxBinding).where(SandboxBinding.performed_by == actor_id))
        connection.execute(
            delete(PublishedAutomationAction).where(
                PublishedAutomationAction.automation_id == definition_id
            )
        )
        connection.execute(
            delete(PublishedAutomationCondition).where(
                PublishedAutomationCondition.automation_id == definition_id
            )
        )
        connection.execute(
            delete(PublishedAutomationDefinition).where(
                PublishedAutomationDefinition.id == definition_id
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
        )
        if event_ids:
            audit_filter = or_(audit_filter, AuditLog.entity_id.in_(event_ids))
        connection.execute(delete(AuditLog).where(audit_filter))
        connection.execute(delete(User).where(User.id == actor_id))


def publish_automation(
    db: Session,
    *,
    automation: AutomationDocument | None = None,
    automations: Sequence[AutomationDocument] | None = None,
) -> tuple[User, Module, dict[str, Field], PublishedAutomationDefinition]:
    role = db.scalar(select(Role).where(Role.role == "admin"))
    assert role is not None
    actor = User(
        email=f"automation-{uuid7()}@example.test",
        username=f"automation-{uuid7()}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
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
    if automations is not None and automation is not None:
        raise ValueError("Pass either automation or automations")
    selected_automations = list(automations) if automations is not None else [
        automation or field_change_automation()
    ]
    if not selected_automations:
        raise ValueError("At least one automation is required")
    selected = selected_automations[0]
    document = publication_document(selected_automations)
    saved = replace_document(
        db,
        actor_id=actor.id,
        expected_revision=initial.revision,
        document=document,
    )
    preview = publication_plan(db, saved.document)
    assert not preview.blockers
    token_digest = sha256(f"automation-{actor.id}".encode()).hexdigest()
    apply_publication(
        db,
        actor_id=actor.id,
        expected_revision=saved.revision,
        impact_digest=preview.impact_digest,
        expected_live_state_digest=preview.live_state_digest,
        preview_token_digest=token_digest,
        idempotency_key=f"automation-{actor.id}",
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
        select(PublishedAutomationDefinition).where(
            PublishedAutomationDefinition.name == selected.name,
            PublishedAutomationDefinition.is_deleted.is_(False),
        )
    )
    assert definition is not None
    return actor, module, fields, definition


def publication_document(automations: Sequence[AutomationDocument]) -> SandboxDocument:
    return SandboxDocument.model_validate(
        {
            "kind": "openslate-sandbox",
            "schemaVersion": 2,
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
            "automations": [item.model_dump(by_alias=True, mode="json") for item in automations],
            "scenarios": [],
        }
    )


def field_change_automation() -> AutomationDocument:
    return AutomationDocument.model_validate(
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


def schedule_automation() -> AutomationDocument:
    payload = field_change_automation().model_dump(by_alias=True, mode="json")
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
    return AutomationDocument.model_validate(payload)


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
    return db.scalar(select(func.count()).select_from(PublishedAutomationEvent)) or 0
