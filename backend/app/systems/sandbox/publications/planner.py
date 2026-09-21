"""Pure-ish publication planning and bounded live-state inspection."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.automations.models import PublishedAutomationDefinition
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import DesignField, SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from app.systems.sandbox.fields.impact import validate_change_impact
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.automation_comparison import (
    automation_semantics_changed,
)
from app.systems.sandbox.publications.binding_keys import normalize_legacy_field_bindings
from app.systems.sandbox.publications.close_rules import (
    close_blockers,
    hierarchy_close_blockers,
    live_dependencies_exist,
    live_relationship_department_blockers,
    unmanaged_field_blockers,
)
from app.systems.sandbox.publications.live_state import live_state_digest
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.preflight import (
    live_name_blockers,
    module_schema_blockers,
    structure_name_blockers,
)
from app.systems.sandbox.publications.rules import (
    _automation_blockers,
    _digest,
    _field_key,
    _field_type,
    operational_config,
    relationship_metadata,
)
from app.systems.sandbox.publications.schemas import (
    PublicationBlocker,
    PublicationChange,
    PublicationCounts,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.service import (
    RelationshipConflict,
    validate_cardinality_change,
)

BindingKind = Literal["department", "module", "field", "relationship", "automation"]


@dataclass(frozen=True, slots=True)
class PublicationPlan:
    changes: tuple[PublicationChange, ...]
    blockers: tuple[PublicationBlocker, ...]
    warnings: tuple[str, ...]
    counts: PublicationCounts
    impact_digest: str
    live_state_digest: str
    workspace_timezone: str


def publication_plan(db: Session, document: SandboxDocument) -> PublicationPlan:
    """Build a deterministic plan without changing the document or live structure."""

    bindings = list(
        db.scalars(select(SandboxBinding).order_by(SandboxBinding.kind, SandboxBinding.sandbox_id))
    )
    by_kind = _binding_map(bindings)
    changes: list[PublicationChange] = []
    blockers = [
        PublicationBlocker(
            code="document_invalid", message=issue.message, target_id=issue.target_id
        )
        for issue in validate_document(document)
    ]
    try:
        normalize_legacy_field_bindings(document, by_kind, persist=False)
    except ValueError as error:
        blockers.append(
            PublicationBlocker(
                code="field_binding_ambiguous", message=str(error), target_id=None
            )
        )
    blockers.extend(_legacy_mapping_blockers(document))
    blockers.extend(structure_name_blockers(document))
    blockers.extend(live_name_blockers(db, document, by_kind))
    desired_ids: dict[BindingKind, set[str]] = {kind: set() for kind in _kinds()}

    for item in document.design.departments:
        desired_ids["department"].add(item.id)
        _plan_item(
            db, changes, "department", item.id, item.name, item.closed, by_kind["department"]
        )
    for module in document.design.modules:
        desired_ids["module"].add(module.id)
        _plan_item(db, changes, "module", module.id, module.name, module.closed, by_kind["module"])
        module_binding = by_kind["module"].get(module.id)
        expected_department = by_kind["department"].get(module.department_id)
        if (
            module_binding is not None
            and expected_department is not None
            and module_binding.module_id is not None
            and expected_department.department_id is not None
        ):
            live_module = db.get(Module, module_binding.module_id)
            if (
                live_module is not None
                and live_module.department_id != expected_department.department_id
            ):
                _append_update(changes, "module", module.id, module.name)
        active_position = 0
        for field in module.fields:
            field_key = _field_key(module.id, field.id)
            desired_ids["field"].add(field_key)
            _plan_item(db, changes, "field", field_key, field.name, field.closed, by_kind["field"])
            try:
                desired_config = operational_config(field)
            except ValueError:
                if not field.closed and not module.closed:
                    active_position += 1
                continue
            bound = by_kind["field"].get(field_key)
            if (
                bound is None
                and field.required
                and not field.closed
                and not module.closed
                and module_binding is not None
                and module_binding.module_id is not None
                and db.scalar(
                    select(Record.id)
                    .where(
                        Record.module_id == module_binding.module_id,
                        Record.is_deleted.is_(False),
                    )
                    .limit(1)
                )
                is not None
            ):
                blockers.append(
                    PublicationBlocker(
                        code="field_change_invalidates_records",
                        message="This required field would invalidate active records",
                        target_id=field_key,
                    )
                )
            if bound is not None and bound.field_id is not None:
                blockers.extend(_type_change_blocker(db, bound.field_id, field))
                live_field = db.get(Field, bound.field_id)
                expected_position = (
                    active_position if not field.closed and not module.closed else None
                )
                if live_field is not None and (
                    live_field.required != field.required
                    or (expected_position is not None and live_field.position != expected_position)
                    or live_field.config != desired_config
                ):
                    _append_update(changes, "field", field_key, field.name)
                    blockers.extend(
                        _field_impact_blockers(db, live_field, field, field_key, desired_config)
                    )
            if not field.closed and not module.closed:
                active_position += 1
    module_departments = {module.id: module.department_id for module in document.design.modules}
    for relationship in document.design.relationships:
        desired_ids["relationship"].add(relationship.id)
        _plan_item(
            db,
            changes,
            "relationship",
            relationship.id,
            relationship.name,
            False,
            by_kind["relationship"],
        )
        if module_departments.get(relationship.source_module_id) != module_departments.get(
            relationship.target_module_id
        ):
            blockers.append(
                PublicationBlocker(
                    code="relationship_department_mismatch",
                    message="Connected modules must stay in the same department",
                    target_id=relationship.id,
                )
            )
        binding = by_kind["relationship"].get(relationship.id)
        if binding is not None and binding.field_id is not None:
            live = db.get(Field, binding.field_id)
            source_binding = by_kind["module"].get(relationship.source_module_id)
            desired_source = source_binding.module_id if source_binding is not None else None
            if (
                live is not None
                and desired_source is not None
                and live.module_id != desired_source
                and live_dependencies_exist(db, "relationship", live.id)
            ):
                blockers.append(
                    PublicationBlocker(
                        code="relationship_move_has_live_dependencies",
                        message="Move this relationship after its live links are removed",
                        target_id=relationship.id,
                    )
                )
            if live is not None:
                multiple_targets, multiple_sources = relationship_metadata(relationship)
                target_binding = by_kind["module"].get(relationship.target_module_id)
                expected_target = target_binding.module_id if target_binding is not None else None
                if (
                    live.relationship_target_module_id != expected_target
                    and live_dependencies_exist(db, "relationship", live.id)
                ):
                    blockers.append(
                        PublicationBlocker(
                            code="relationship_target_change_has_live_edges",
                            message="Remove live relationships before changing their target module",
                            target_id=relationship.id,
                        )
                    )
                try:
                    validate_cardinality_change(db, live, multiple_targets, multiple_sources)
                except RelationshipConflict:
                    blockers.append(
                        PublicationBlocker(
                            code="relationship_cardinality_has_live_edges",
                            message=(
                                "Existing relationships conflict with the requested cardinality"
                            ),
                            target_id=relationship.id,
                        )
                    )
                if (
                    live.relationship_multiple_targets != multiple_targets
                    or live.relationship_multiple_sources != multiple_sources
                    or live.relationship_target_module_id != expected_target
                ):
                    _append_update(changes, "relationship", relationship.id, relationship.name)
    for execution_position, automation in enumerate(document.automations):
        desired_ids["automation"].add(automation.id)
        _plan_item(
            db, changes, "automation", automation.id, automation.name, False, by_kind["automation"]
        )
        if automation_semantics_changed(
            db,
            automation,
            by_kind["module"],
            by_kind["field"],
            by_kind["automation"],
        ):
            _append_update(changes, "automation", automation.id, automation.name)
        binding = by_kind["automation"].get(automation.id)
        automation_live = (
            db.get(PublishedAutomationDefinition, binding.automation_id)
            if binding is not None and binding.automation_id is not None
            else None
        )
        if automation_live is not None and automation_live.execution_position != execution_position:
            _append_update(changes, "automation", automation.id, automation.name)
        blockers.extend(_automation_blockers(document, automation))

    _plan_removed_items(db, changes, by_kind, desired_ids)
    blockers.extend(module_schema_blockers(document))
    blockers.extend(close_blockers(db, by_kind, desired_ids, document))
    blockers.extend(hierarchy_close_blockers(document))
    blockers.extend(unmanaged_field_blockers(db, by_kind, document))
    blockers.extend(live_relationship_department_blockers(db, by_kind, document))
    profile = db.scalar(select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True)))
    if profile is None:
        blockers.append(
            PublicationBlocker(
                code="workspace_unavailable", message="Workspace settings are unavailable"
            )
        )
        timezone = ""
    else:
        timezone = profile.timezone
    return replace(
        _finish(changes, blockers),
        live_state_digest=live_state_digest(db, bindings, timezone),
        workspace_timezone=timezone,
    )
def locked_publication_plan(db: Session, document: SandboxDocument) -> PublicationPlan:
    """Recompute plan after executor acquired its canonical operational locks."""

    return publication_plan(db, document)
def _finish(
    changes: list[PublicationChange], blockers: list[PublicationBlocker]
) -> PublicationPlan:
    ordered_changes = tuple(
        sorted(changes, key=lambda item: (item.kind, item.sandbox_id, item.action))
    )
    ordered_blockers = tuple(
        sorted(blockers, key=lambda item: (item.code, item.target_id or "", item.message))
    )
    counts = PublicationCounts(
        **{kind + "s": sum(change.kind == kind for change in ordered_changes) for kind in _kinds()}
    )
    impact_payload = {
        "changes": [item.model_dump(by_alias=True) for item in ordered_changes],
        "blockers": [item.model_dump(by_alias=True) for item in ordered_blockers],
    }
    impact = _digest(impact_payload)
    return PublicationPlan(
        changes=ordered_changes,
        blockers=ordered_blockers,
        warnings=(),
        counts=counts,
        impact_digest=impact,
        live_state_digest=_digest(impact_payload["changes"]),
        workspace_timezone="",
    )
def _kinds() -> tuple[BindingKind, ...]:
    return ("department", "module", "field", "relationship", "automation")
def _binding_map(bindings: list[SandboxBinding]) -> dict[BindingKind, dict[str, SandboxBinding]]:
    result: dict[BindingKind, dict[str, SandboxBinding]] = {kind: {} for kind in _kinds()}
    for binding in bindings:
        if binding.kind in result and not binding.is_deleted:
            result[binding.kind][binding.sandbox_id] = binding
    return result


def _plan_item(
    db: Session,
    changes: list[PublicationChange],
    kind: BindingKind,
    sandbox_id: str,
    label: str,
    closed: bool,
    bindings: dict[str, SandboxBinding],
) -> None:
    bound = bindings.get(sandbox_id)
    if bound is None or _bound_target(db, kind, bound) is None:
        changes.append(
            PublicationChange(kind=kind, action="create", sandbox_id=sandbox_id, label=label)
        )
    else:
        target = _bound_target(db, kind, bound)
        if target is None:
            return
        target_label = (
            target.department_name
            if kind == "department"
            else target.module_name
            if kind == "module"
            else target.name
        )
        if closed and not target.is_deleted:
            changes.append(
                PublicationChange(kind=kind, action="close", sandbox_id=sandbox_id, label=label)
            )
        elif not closed and target.is_deleted:
            changes.append(
                PublicationChange(kind=kind, action="reopen", sandbox_id=sandbox_id, label=label)
            )
        elif target_label != label:
            changes.append(
                PublicationChange(kind=kind, action="update", sandbox_id=sandbox_id, label=label)
            )


def _append_update(
    changes: list[PublicationChange], kind: BindingKind, sandbox_id: str, label: str
) -> None:
    if not any(
        change.kind == kind and change.sandbox_id == sandbox_id and change.action == "update"
        for change in changes
    ):
        changes.append(
            PublicationChange(kind=kind, action="update", sandbox_id=sandbox_id, label=label)
        )


def _bound_target(db: Session, kind: BindingKind, binding: SandboxBinding) -> Any | None:
    if kind == "department":
        return db.get(Department, binding.department_id)
    if kind == "module":
        return db.get(Module, binding.module_id)
    if kind in {"field", "relationship"}:
        return db.get(Field, binding.field_id)
    return db.get(PublishedAutomationDefinition, binding.automation_id)


def _type_change_blocker(
    db: Session, field_id: UUID, desired: DesignField
) -> list[PublicationBlocker]:
    from app.systems.sandbox.fields.models import Field

    actual = db.get(Field, field_id)
    if actual is None:
        return [
            PublicationBlocker(
                code="binding_missing", message="Bound field is unavailable", target_id=desired.id
            )
        ]
    if actual.type != _field_type(desired):
        return [
            PublicationBlocker(
                code="field_type_change_blocked",
                message="A published field type cannot be changed",
                target_id=desired.id,
            )
        ]
    return []


def _field_impact_blockers(
    db: Session,
    live: Field,
    desired: DesignField,
    field_key: str,
    desired_config: dict[str, object],
) -> list[PublicationBlocker]:
    if live.type != _field_type(desired):
        return []
    try:
        validate_change_impact(
            db,
            live,
            FieldType(_field_type(desired)),
            desired.required,
            desired_config,
        )
    except ValueError:
        return [
            PublicationBlocker(
                code="field_change_invalidates_records",
                message="This field change would invalidate active records",
                target_id=field_key,
            )
        ]
    return []


def _plan_removed_items(
    db: Session,
    changes: list[PublicationChange],
    bindings: dict[BindingKind, dict[str, SandboxBinding]],
    desired_ids: dict[BindingKind, set[str]],
) -> None:
    for kind in _kinds():
        for sandbox_id, binding in bindings[kind].items():
            if sandbox_id in desired_ids[kind]:
                continue
            target = _bound_target(db, kind, binding)
            if target is None or target.is_deleted:
                continue
            label = (
                target.department_name
                if kind == "department"
                else target.module_name
                if kind == "module"
                else target.name
            )
            changes.append(
                PublicationChange(kind=kind, action="close", sandbox_id=sandbox_id, label=label)
            )


def _legacy_mapping_blockers(document: SandboxDocument) -> list[PublicationBlocker]:
    return [
        PublicationBlocker(
            code="relationship_field_mappings_unsupported",
            message="Relationship field mappings must be removed before publishing",
            target_id=relationship.id,
        )
        for relationship in document.design.relationships
        if relationship.field_mappings
    ]
