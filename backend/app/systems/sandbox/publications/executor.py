"""Atomic application of a reviewed Sandbox document to operational structure."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.service import (
    _append_version,
    _locked_document,
    _parse_row_document,
)
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.validation import validate_module_schema
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.automation_mutations import apply_published_automations
from app.systems.sandbox.publications.binding_keys import normalize_legacy_field_bindings
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication
from app.systems.sandbox.publications.planner import (
    _binding_map,
    locked_publication_plan,
)
from app.systems.sandbox.publications.rules import (
    _field_key,
    _field_type,
    operational_config,
    relationship_metadata,
)
from app.systems.sandbox.publications.schemas import PublicationResponse, PublicationVersion
from app.systems.sandbox.publications.structure_mutations import (
    close_removed_structure,
    stage_bound_names_and_positions,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


class PublicationError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 409) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def request_fingerprint(
    *,
    expected_revision: int,
    document_hash: str,
    impact_digest: str,
    preview_token_digest: str,
    note: str | None,
) -> str:
    payload = {
        "expectedRevision": expected_revision,
        "documentHash": document_hash,
        "impactDigest": impact_digest,
        "previewTokenDigest": preview_token_digest,
        "note": note,
    }
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def replay_or_conflict(
    db: Session,
    *,
    actor_id: UUID,
    idempotency_key: str,
    fingerprint: str,
    preview_token_digest: str,
) -> PublicationResponse | None:
    previous = db.scalar(
        select(SandboxPublication)
        .where(
            SandboxPublication.actor_id == actor_id,
            SandboxPublication.idempotency_key == idempotency_key,
        )
        .with_for_update()
    )
    if previous is None:
        consumed = db.scalar(
            select(SandboxPublication)
            .where(SandboxPublication.preview_token_digest == preview_token_digest)
            .with_for_update()
        )
        if consumed is not None:
            raise PublicationError("preview_mismatch", "Publication review was already used")
        return None
    if previous.request_fingerprint != fingerprint:
        raise PublicationError(
            "idempotency_mismatch", "Idempotency-Key was already used for a different publication"
        )
    return PublicationResponse.model_validate_json(json.dumps(previous.response_body))


def apply_publication(
    db: Session,
    *,
    actor_id: UUID,
    expected_revision: int,
    impact_digest: str,
    expected_live_state_digest: str,
    preview_token_digest: str,
    idempotency_key: str,
    fingerprint: str,
    note: str | None,
) -> PublicationResponse:
    """Apply publication after password/auth/token verification at the route boundary."""

    document_row = _locked_document(db, expected_revision)
    replay = replay_or_conflict(
        db,
        actor_id=actor_id,
        idempotency_key=idempotency_key,
        fingerprint=fingerprint,
        preview_token_digest=preview_token_digest,
    )
    if replay is not None:
        return replay
    document = _parse_row_document(document_row)
    _lock_operational_rows(db)
    plan = locked_publication_plan(db, document)
    if plan.blockers:
        raise PublicationError("publication_blocked", "Fix the listed publication blockers")
    if plan.impact_digest != impact_digest:
        raise PublicationError("preview_mismatch", "The review no longer matches this publication")
    if plan.live_state_digest != expected_live_state_digest:
        raise PublicationError("live_state_changed", "Live structure changed after review")
    bindings = _binding_map(list(db.scalars(select(SandboxBinding).with_for_update()).all()))
    try:
        normalize_legacy_field_bindings(document, bindings, persist=True)
    except ValueError as error:
        raise PublicationError("field_binding_ambiguous", str(error)) from error
    retired = stage_bound_names_and_positions(db, document, bindings, actor_id)
    departments = _apply_departments(db, document, bindings, actor_id)
    modules = _apply_modules(db, document, bindings, departments, actor_id)
    fields = _apply_fields(db, document, bindings, modules, actor_id)
    _apply_relationships(db, document, bindings, modules, actor_id)
    close_removed_structure(db, document, bindings, actor_id, retired)
    version = _append_version(
        db,
        row=document_row,
        document=document,
        kind="published",
        label="Published structure",
        note=note,
        actor_id=actor_id,
    )
    db.flush()
    publication = SandboxPublication(
        document_id=document_row.id,
        version_id=version.id,
        actor_id=actor_id,
        document_revision=document_row.revision,
        document_hash=document_row.content_hash,
        impact_digest=plan.impact_digest,
        live_state_digest=plan.live_state_digest,
        preview_token_digest=preview_token_digest,
        idempotency_key=idempotency_key,
        request_fingerprint=fingerprint,
        note=note,
        response_body={},
        performed_by=actor_id,
    )
    db.add(publication)
    db.flush()
    apply_published_automations(
        db,
        document,
        bindings,
        modules,
        fields,
        publication.id,
        version.id,
        plan.workspace_timezone,
        actor_id,
    )
    _accept_schemas(db, modules)
    _assert_no_record_or_edge_changes(db)
    response = PublicationResponse(
        id=publication.id,
        version=PublicationVersion(
            id=version.id,
            sequence=version.sequence,
            kind="published",
            label=version.label,
        ),
        document_revision=document_row.revision,
        document_hash=document_row.content_hash,
        impact_digest=plan.impact_digest,
        published_at=publication.created_at,
    )
    publication.response_body = response.model_dump(by_alias=True, mode="json")
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        replay = replay_or_conflict(
            db,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            preview_token_digest=preview_token_digest,
        )
        if replay is not None:
            return replay
        raise PublicationError(
            "publication_unavailable", "Unable to publish the Sandbox structure", 503
        ) from error
    return response


def _lock_operational_rows(db: Session) -> None:
    """Use canonical class order before blocker inspection and mutation."""

    for model in (
        WorkspaceProfile,
        SandboxBinding,
        Department,
        Module,
        Field,
        Record,
        RelationshipEdge,
        PublishedAutomationDefinition,
        PublishedAutomationCondition,
        PublishedAutomationAction,
    ):
        db.scalars(select(model).order_by(model.id).with_for_update()).all()


def _apply_departments(
    db: Session, document: Any, bindings: Any, actor_id: UUID
) -> dict[str, Department]:
    result: dict[str, Department] = {}
    for desired in document.design.departments:
        binding = bindings["department"].get(desired.id)
        row = db.get(Department, binding.department_id) if binding is not None else None
        if row is None:
            row = Department(
                department_name=desired.name,
                is_deleted=desired.closed,
                deleted_at=datetime.now(UTC) if desired.closed else None,
                performed_by=actor_id,
            )
            db.add(row)
            db.flush()
            _bind(db, "department", desired.id, actor_id, department_id=row.id)
        else:
            row.department_name = desired.name
            row.is_deleted = desired.closed
            row.deleted_at = datetime.now(UTC) if desired.closed else None
            row.performed_by = actor_id
        result[desired.id] = row
    return result


def _apply_modules(
    db: Session, document: Any, bindings: Any, departments: dict[str, Department], actor_id: UUID
) -> dict[str, Module]:
    result: dict[str, Module] = {}
    for desired in document.design.modules:
        department = departments[desired.department_id]
        binding = bindings["module"].get(desired.id)
        row = db.get(Module, binding.module_id) if binding is not None else None
        if row is None:
            closed = desired.closed or department.is_deleted
            row = Module(
                department_id=department.id,
                module_name=desired.name,
                is_schema_accepted=False,
                is_deleted=closed,
                deleted_at=datetime.now(UTC) if closed else None,
                performed_by=actor_id,
            )
            db.add(row)
            db.flush()
            _bind(db, "module", desired.id, actor_id, module_id=row.id)
        else:
            row.department_id = department.id
            row.module_name = desired.name
            closed = desired.closed or department.is_deleted
            row.is_deleted = closed
            row.deleted_at = datetime.now(UTC) if closed else None
            row.is_schema_accepted = False
            row.performed_by = actor_id
        result[desired.id] = row
    return result


def _apply_fields(
    db: Session, document: Any, bindings: Any, modules: dict[str, Module], actor_id: UUID
) -> dict[str, Field]:
    result: dict[str, Field] = {}
    for module in document.design.modules:
        active_position = 0
        for desired in module.fields:
            field_key = _field_key(module.id, desired.id)
            binding = bindings["field"].get(field_key)
            row = db.get(Field, binding.field_id) if binding is not None else None
            closed = desired.closed or modules[module.id].is_deleted
            if row is None:
                row = Field(
                    module_id=modules[module.id].id,
                    name=desired.name,
                    type=FieldType(_field_type(desired)),
                    required=desired.required,
                    position=active_position,
                    config=operational_config(desired),
                    is_deleted=closed,
                    deleted_at=datetime.now(UTC) if closed else None,
                    performed_by=actor_id,
                )
                db.add(row)
                db.flush()
                _bind(db, "field", field_key, actor_id, field_id=row.id)
            else:
                row.module_id = modules[module.id].id
                row.name = desired.name
                row.required = desired.required
                row.position = active_position
                row.config = operational_config(desired)
                row.is_deleted = closed
                row.deleted_at = datetime.now(UTC) if closed else None
                row.performed_by = actor_id
            result[field_key] = row
            if not closed:
                active_position += 1
    return result


def _apply_relationships(
    db: Session,
    document: Any,
    bindings: Any,
    modules: dict[str, Module],
    actor_id: UUID,
) -> None:
    positions = {
        module.id: sum(
            not field.closed and not modules[module.id].is_deleted for field in module.fields
        )
        for module in document.design.modules
    }
    for desired in document.design.relationships:
        binding = bindings["relationship"].get(desired.id)
        row = db.get(Field, binding.field_id) if binding is not None else None
        multiple_targets, multiple_sources = relationship_metadata(desired)
        if row is None:
            closed = modules[desired.source_module_id].is_deleted
            row = Field(
                module_id=modules[desired.source_module_id].id,
                name=desired.name,
                type=FieldType.RELATIONSHIP,
                required=False,
                position=positions[desired.source_module_id],
                config={},
                relationship_target_module_id=modules[desired.target_module_id].id,
                relationship_multiple_targets=multiple_targets,
                relationship_multiple_sources=multiple_sources,
                is_deleted=closed,
                deleted_at=datetime.now(UTC) if closed else None,
                performed_by=actor_id,
            )
            if not closed:
                positions[desired.source_module_id] += 1
            db.add(row)
            db.flush()
            _bind(db, "relationship", desired.id, actor_id, field_id=row.id)
        else:
            row.module_id = modules[desired.source_module_id].id
            row.name = desired.name
            row.position = positions[desired.source_module_id]
            if not modules[desired.source_module_id].is_deleted:
                positions[desired.source_module_id] += 1
            row.relationship_target_module_id = modules[desired.target_module_id].id
            row.relationship_multiple_targets = multiple_targets
            row.relationship_multiple_sources = multiple_sources
            row.is_deleted = modules[desired.source_module_id].is_deleted
            row.deleted_at = datetime.now(UTC) if row.is_deleted else None
            row.performed_by = actor_id


def _accept_schemas(db: Session, modules: dict[str, Module]) -> None:
    for module in modules.values():
        if module.is_deleted:
            continue
        active = list(
            db.scalars(
                select(Field).where(Field.module_id == module.id, Field.is_deleted.is_(False))
            ).all()
        )
        validate_module_schema(active)
        module.is_schema_accepted = True


def _bind(db: Session, kind: str, sandbox_id: str, actor_id: UUID, **target: UUID) -> None:
    db.add(SandboxBinding(kind=kind, sandbox_id=sandbox_id, performed_by=actor_id, **target))


def _assert_no_record_or_edge_changes(db: Session) -> None:
    changed = set(db.new).union(db.dirty).union(db.deleted)
    if any(isinstance(item, (Record, RelationshipEdge)) for item in changed):
        raise PublicationError(
            "publication_unavailable", "Publication attempted to alter live records", 500
        )
