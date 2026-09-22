"""Safety rules for closing published Sandbox structure."""

from collections.abc import Collection
from typing import Literal
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.automation_comparison import automation_semantics_changed
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.publications.schemas import PublicationBlocker
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

type BindingKind = Literal["department", "module", "field", "relationship", "automation"]


def close_blockers(
    db: Session,
    bindings: dict[BindingKind, dict[str, SandboxBinding]],
    desired_ids: dict[BindingKind, set[str]],
    document: SandboxDocument,
) -> list[PublicationBlocker]:
    blockers: list[PublicationBlocker] = []
    desired_automations = {automation.id: automation for automation in document.automations}
    retiring_automation_ids = frozenset(
        binding.automation_id
        for sandbox_id, binding in bindings["automation"].items()
        if binding.automation_id is not None
        and (
            sandbox_id not in desired_automations
            or automation_semantics_changed(
                db,
                desired_automations[sandbox_id],
                bindings["module"],
                bindings["field"],
                bindings["automation"],
            )
        )
    )
    retiring_relationship_field_ids = frozenset(
        binding.field_id
        for sandbox_id, binding in bindings["relationship"].items()
        if sandbox_id not in desired_ids["relationship"] and binding.field_id is not None
    )
    department_closed = {
        department.id for department in document.design.departments if department.closed
    }
    module_closed = {module.id for module in document.design.modules if module.closed}
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
                    ignored_automation_ids=retiring_automation_ids,
                    ignored_relationship_field_ids=retiring_relationship_field_ids,
                )
                or (
                    kind in {"field", "relationship"}
                    and _field_has_automation_dependency(
                        db,
                        live_id,
                        ignored_automation_ids=retiring_automation_ids,
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
    blockers: list[PublicationBlocker] = []
    for module in document.design.modules:
        if module.closed:
            continue
        binding = bindings["module"].get(module.id)
        if binding is None or binding.module_id is None:
            continue
        unmanaged = db.scalar(
            select(Field.id)
            .where(
                Field.module_id == binding.module_id,
                Field.is_deleted.is_(False),
                Field.id.not_in(bound_field_ids),
            )
            .limit(1)
        )
        if unmanaged is not None:
            blockers.append(
                PublicationBlocker(
                    code="module_has_unmanaged_fields",
                    message="Remove or close fields created outside Sandbox before publishing",
                    target_id=module.id,
                )
            )
    return blockers


def live_relationship_department_blockers(
    db: Session,
    bindings: dict[BindingKind, dict[str, SandboxBinding]],
    document: SandboxDocument,
) -> list[PublicationBlocker]:
    """Protect every live relationship, including links outside Sandbox ownership."""

    desired_modules = {module.id: module for module in document.design.modules}
    desired_departments: dict[UUID, tuple[str, str]] = {}
    sandbox_module_by_live: dict[UUID, str] = {}
    for sandbox_id, binding in bindings["module"].items():
        desired = desired_modules.get(sandbox_id)
        if desired is None or binding.module_id is None:
            continue
        department_binding = bindings["department"].get(desired.department_id)
        token = (
            ("live", str(department_binding.department_id))
            if department_binding is not None and department_binding.department_id is not None
            else ("sandbox", desired.department_id)
        )
        desired_departments[binding.module_id] = token
        sandbox_module_by_live[binding.module_id] = sandbox_id

    live_modules = {
        module.id: module
        for module in db.scalars(select(Module).where(Module.is_deleted.is_(False)))
    }
    blockers: list[PublicationBlocker] = []
    for field in db.scalars(
        select(Field).where(
            Field.type == "relationship",
            Field.is_deleted.is_(False),
            Field.relationship_target_module_id.is_not(None),
        )
    ):
        target_id = field.relationship_target_module_id
        if target_id is None:
            continue
        source = live_modules.get(field.module_id)
        target = live_modules.get(target_id)
        if source is None or target is None:
            continue
        source_department = desired_departments.get(source.id, ("live", str(source.department_id)))
        target_department = desired_departments.get(target.id, ("live", str(target.department_id)))
        if source_department == target_department:
            continue
        affected_module = sandbox_module_by_live.get(source.id) or sandbox_module_by_live.get(
            target.id
        )
        blockers.append(
            PublicationBlocker(
                code="module_move_breaks_live_relationship",
                message="Move connected modules together before publishing",
                target_id=affected_module,
            )
        )
    return blockers


def live_dependencies_exist(
    db: Session,
    kind: BindingKind,
    live_id: UUID,
    *,
    ignored_automation_ids: Collection[UUID] = (),
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
        automation_filters = [
            PublishedAutomationDefinition.module_id == live_id,
            PublishedAutomationDefinition.is_deleted.is_(False),
            PublishedAutomationDefinition.enabled.is_(True),
        ]
        if ignored_automation_ids:
            automation_filters.append(
                PublishedAutomationDefinition.id.not_in(ignored_automation_ids)
            )
        has_automations = (
            db.scalar(select(PublishedAutomationDefinition.id).where(*automation_filters).limit(1))
            is not None
        )
        return has_records or has_relationship_target or has_automations
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


def _field_has_automation_dependency(
    db: Session,
    field_id: UUID,
    *,
    ignored_automation_ids: Collection[UUID] = (),
) -> bool:
    definition_filters = [
        PublishedAutomationDefinition.is_deleted.is_(False),
        PublishedAutomationDefinition.enabled.is_(True),
        or_(
            PublishedAutomationDefinition.trigger_field_id == field_id,
            PublishedAutomationDefinition.trigger_value_field_id == field_id,
        ),
    ]
    child_filters = [
        PublishedAutomationDefinition.is_deleted.is_(False),
        PublishedAutomationDefinition.enabled.is_(True),
    ]
    if ignored_automation_ids:
        ignored_filter = PublishedAutomationDefinition.id.not_in(ignored_automation_ids)
        definition_filters.append(ignored_filter)
        child_filters.append(ignored_filter)
    definition = db.scalar(
        select(PublishedAutomationDefinition.id).where(*definition_filters).limit(1)
    )
    condition = db.scalar(
        select(PublishedAutomationCondition.id)
        .join(
            PublishedAutomationDefinition,
            PublishedAutomationDefinition.id == PublishedAutomationCondition.automation_id,
        )
        .where(
            *child_filters,
            PublishedAutomationCondition.is_deleted.is_(False),
            or_(
                PublishedAutomationCondition.field_id == field_id,
                PublishedAutomationCondition.value_field_id == field_id,
            ),
        )
        .limit(1)
    )
    action = db.scalar(
        select(PublishedAutomationAction.id)
        .join(
            PublishedAutomationDefinition,
            PublishedAutomationDefinition.id == PublishedAutomationAction.automation_id,
        )
        .where(
            *child_filters,
            PublishedAutomationAction.is_deleted.is_(False),
            or_(
                PublishedAutomationAction.target_field_id == field_id,
                PublishedAutomationAction.value_field_id == field_id,
            ),
        )
        .limit(1)
    )
    return definition is not None or condition is not None or action is not None
