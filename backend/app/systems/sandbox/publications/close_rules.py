"""Safety rules for closing published Sandbox structure."""

from collections.abc import Collection, Mapping
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.publications.schemas import PublicationBlocker
from app.systems.sandbox.publications.snapshot import PublicationSnapshot
from app.systems.sandbox.publications.trigger_comparison import trigger_semantics_changed
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
)
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

type BindingKind = Literal["department", "module", "field", "relationship", "trigger"]


def close_blockers(
    db: Session,
    bindings: dict[BindingKind, dict[str, SandboxBinding]],
    desired_ids: dict[BindingKind, set[str]],
    document: SandboxDocument,
    *,
    snapshot: PublicationSnapshot | None = None,
) -> list[PublicationBlocker]:
    blockers: list[PublicationBlocker] = []
    desired_triggers = {record_trigger.id: record_trigger for record_trigger in document.triggers}
    retiring_trigger_ids = frozenset(
        binding.trigger_id
        for sandbox_id, binding in bindings["trigger"].items()
        if binding.trigger_id is not None
        and (
            sandbox_id not in desired_triggers
            or trigger_semantics_changed(
                db,
                desired_triggers[sandbox_id],
                bindings["module"],
                bindings["field"],
                bindings["trigger"],
                snapshot=snapshot,
            )
        )
    )
    department_closed = {
        department.id for department in document.design.departments if department.closed
    }
    module_closed = {module.id for module in document.design.modules if module.closed}
    desired_relationships = {
        relationship.id: relationship for relationship in document.design.relationships
    }
    retiring_relationship_field_ids = frozenset(
        binding.field_id
        for sandbox_id, binding in bindings["relationship"].items()
        if binding.field_id is not None
        and (
            sandbox_id not in desired_ids["relationship"]
            or (
                sandbox_id in desired_relationships
                and (
                    desired_relationships[sandbox_id].source_module_id in module_closed
                    or desired_relationships[sandbox_id].target_module_id in module_closed
                )
            )
        )
    )
    field_closed = {
        _field_key(module.id, field.id)
        for module in document.design.modules
        for field in module.fields
        if field.closed
    }
    for kind in ("department", "module", "field", "relationship"):
        for sandbox_id, binding in bindings[kind].items():
            desired_closed = sandbox_id not in desired_ids[kind] or (
                (kind == "department" and sandbox_id in department_closed)
                or (kind == "module" and sandbox_id in module_closed)
                or (kind == "field" and sandbox_id in field_closed)
            )
            live_id = (
                binding.field_id
                if kind in {"field", "relationship"}
                else (binding.module_id if kind == "module" else binding.department_id)
            )
            if not desired_closed or live_id is None:
                continue
            hierarchy_dependency = (
                kind == "department"
                and _department_has_unmanaged_modules(
                    db,
                    live_id,
                    bindings["module"],
                    desired_ids["module"],
                    module_closed,
                )
            ) or (
                kind == "module"
                and _module_has_unmanaged_fields(
                    db,
                    live_id,
                    bindings["field"],
                    bindings["relationship"],
                )
            )
            if (
                hierarchy_dependency
                or live_dependencies_exist(
                    db,
                    kind,
                    live_id,
                    ignored_trigger_ids=retiring_trigger_ids,
                    ignored_relationship_field_ids=retiring_relationship_field_ids,
                )
                or (
                    kind in {"field", "relationship"}
                    and _field_has_trigger_dependency(
                        db,
                        live_id,
                        ignored_trigger_ids=retiring_trigger_ids,
                    )
                )
            ):
                blockers.append(
                    PublicationBlocker(
                        code="close_has_live_dependencies",
                        message=(
                            "Published structure with live records or relationships "
                            "must be closed manually"
                        ),
                        target_id=sandbox_id,
                    )
                )
    return blockers


def hierarchy_close_blockers(document: SandboxDocument) -> list[PublicationBlocker]:
    closed_departments = {item.id for item in document.design.departments if item.closed}
    return [
        PublicationBlocker(
            code="department_close_incomplete",
            message="Close a department's modules before publishing its closure",
            target_id=module.id,
        )
        for module in document.design.modules
        if module.department_id in closed_departments and not module.closed
    ]


def unmanaged_field_blockers(
    db: Session,
    bindings: dict[BindingKind, dict[str, SandboxBinding]],
    document: SandboxDocument,
) -> list[PublicationBlocker]:
    """Block publication when active live fields are outside Sandbox ownership."""

    bound_field_ids = {
        binding.field_id
        for kind in ("field", "relationship")
        for binding in bindings[kind].values()
        if binding.field_id is not None
    }
    candidate_modules = {
        binding.module_id
        for module in document.design.modules
        if not module.closed
        and (binding := bindings["module"].get(module.id)) is not None
        and binding.module_id is not None
    }
    unmanaged_module_ids: set[UUID] = set()
    if candidate_modules:
        unmanaged_module_ids = set(
            db.scalars(
                select(Field.module_id)
                .where(
                    Field.module_id.in_(candidate_modules),
                    Field.is_deleted.is_(False),
                    Field.id.not_in(bound_field_ids),
                )
                .distinct()
            )
        )
    blockers: list[PublicationBlocker] = []
    for module in document.design.modules:
        if module.closed:
            continue
        binding = bindings["module"].get(module.id)
        if binding is None or binding.module_id is None:
            continue
        if binding.module_id in unmanaged_module_ids:
            blockers.append(
                PublicationBlocker(
                    code="module_has_unmanaged_fields",
                    message="Remove or close fields created outside Sandbox before publishing",
                    target_id=module.id,
                )
            )
    return blockers


def live_dependencies_exist(
    db: Session,
    kind: BindingKind,
    live_id: UUID,
    *,
    ignored_trigger_ids: Collection[UUID] = (),
    ignored_relationship_field_ids: Collection[UUID] = (),
) -> bool:
    if kind == "module":
        has_records = (
            db.scalar(
                select(Record.id)
                .where(Record.module_id == live_id, Record.is_deleted.is_(False))
                .limit(1)
            )
            is not None
        )
        relationship_filters = [
            Field.relationship_target_module_id == live_id,
            Field.is_deleted.is_(False),
        ]
        if ignored_relationship_field_ids:
            relationship_filters.append(Field.id.not_in(ignored_relationship_field_ids))
        has_relationship_target = (
            db.scalar(select(Field.id).where(*relationship_filters).limit(1)) is not None
        )
        trigger_filters = [
            RecordTrigger.module_id == live_id,
            RecordTrigger.is_deleted.is_(False),
            RecordTrigger.enabled.is_(True),
        ]
        if ignored_trigger_ids:
            trigger_filters.append(RecordTrigger.id.not_in(ignored_trigger_ids))
        has_triggers = (
            db.scalar(select(RecordTrigger.id).where(*trigger_filters).limit(1)) is not None
        )
        return has_records or has_relationship_target or has_triggers
    if kind in {"field", "relationship"}:
        if kind == "field":
            field = db.get(Field, live_id)
            if field is not None:
                for record in db.scalars(
                    select(Record).where(
                        Record.module_id == field.module_id,
                        Record.is_deleted.is_(False),
                    )
                ):
                    if str(field.id) in record.data:
                        return True
        return (
            db.scalar(
                select(RelationshipEdge.id)
                .where(
                    RelationshipEdge.field_id == live_id,
                    RelationshipEdge.is_deleted.is_(False),
                )
                .limit(1)
            )
            is not None
        )
    return False


def _department_has_unmanaged_modules(
    db: Session,
    department_id: UUID,
    module_bindings: dict[str, SandboxBinding],
    desired_module_ids: set[str],
    closed_module_ids: set[str],
) -> bool:
    sandbox_by_live = {
        binding.module_id: sandbox_id
        for sandbox_id, binding in module_bindings.items()
        if binding.module_id is not None
    }
    for module in db.scalars(
        select(Module).where(
            Module.department_id == department_id,
            Module.is_deleted.is_(False),
        )
    ):
        sandbox_id = sandbox_by_live.get(module.id)
        if sandbox_id is None:
            return True
        if sandbox_id in desired_module_ids and sandbox_id not in closed_module_ids:
            return True
    return False


def _module_has_unmanaged_fields(
    db: Session,
    module_id: UUID,
    field_bindings: dict[str, SandboxBinding],
    relationship_bindings: dict[str, SandboxBinding],
) -> bool:
    primitive_by_live = {
        binding.field_id: sandbox_id
        for sandbox_id, binding in field_bindings.items()
        if binding.field_id is not None
    }
    relationship_by_live = {
        binding.field_id: sandbox_id
        for sandbox_id, binding in relationship_bindings.items()
        if binding.field_id is not None
    }
    for field in db.scalars(
        select(Field).where(Field.module_id == module_id, Field.is_deleted.is_(False))
    ):
        if field.type == "relationship":
            sandbox_id = relationship_by_live.get(field.id)
            if sandbox_id is None:
                return True
        else:
            sandbox_id = primitive_by_live.get(field.id)
            if sandbox_id is None:
                return True
    return False


def _field_has_trigger_dependency(
    db: Session,
    field_id: UUID,
    *,
    ignored_trigger_ids: Collection[UUID] = (),
) -> bool:
    definition_filters = [
        RecordTrigger.is_deleted.is_(False),
        RecordTrigger.enabled.is_(True),
        or_(
            RecordTrigger.trigger_field_id == field_id,
            RecordTrigger.trigger_value_field_id == field_id,
        ),
    ]
    child_filters = [
        RecordTrigger.is_deleted.is_(False),
        RecordTrigger.enabled.is_(True),
    ]
    if ignored_trigger_ids:
        ignored_filter = RecordTrigger.id.not_in(ignored_trigger_ids)
        definition_filters.append(ignored_filter)
        child_filters.append(ignored_filter)
    definition = db.scalar(select(RecordTrigger.id).where(*definition_filters).limit(1))
    condition = db.scalar(
        select(RecordTriggerCondition.id)
        .join(
            RecordTrigger,
            RecordTrigger.id == RecordTriggerCondition.trigger_id,
        )
        .where(
            *child_filters,
            RecordTriggerCondition.is_deleted.is_(False),
            or_(
                RecordTriggerCondition.field_id == field_id,
                RecordTriggerCondition.value_field_id == field_id,
            ),
        )
        .limit(1)
    )
    action = db.scalar(
        select(RecordTriggerAction.id)
        .join(
            RecordTrigger,
            RecordTrigger.id == RecordTriggerAction.trigger_id,
        )
        .where(
            *child_filters,
            RecordTriggerAction.is_deleted.is_(False),
            or_(
                RecordTriggerAction.target_field_id == field_id,
                RecordTriggerAction.value_field_id == field_id,
            ),
        )
        .limit(1)
    )
    return definition is not None or condition is not None or action is not None


def lifecycle_closed_relationships(
    db: Session,
    document: SandboxDocument,
    bindings: Mapping[Any, Mapping[str, SandboxBinding]],
) -> set[str]:
    """Relationships whose live field lifecycle closed directly, not through a module.

    A relationship has no closed flag in the design, so publication must keep such a
    field closed; lifecycle reopen owns it. A field closed by a department or module
    cascade shares that ancestor's marker and still follows its modules. Call this
    before applying a publication, while the ancestors' markers are unchanged.
    """
    closed: set[str] = set()
    for relationship in document.design.relationships:
        binding = bindings.get("relationship", {}).get(relationship.id)
        field = db.get(Field, binding.field_id) if binding and binding.field_id else None
        marker = field.lifecycle_close_operation_id if field is not None else None
        if field is None or not field.is_deleted or marker is None:
            continue
        ancestors = (
            db.get(Module, module_id)
            for module_id in (field.module_id, field.relationship_target_module_id)
            if module_id is not None
        )
        if marker not in {module.lifecycle_close_operation_id for module in ancestors if module}:
            closed.add(relationship.id)
    return closed
