"""Lifecycle impact plan construction."""

from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessDefaultDepartment
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.batch_dependencies import load_purge_dependencies
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidTarget,
    LifecycleUnsupportedOperation,
)
from app.systems.sandbox.lifecycle.planning_preflight import reopen_blockers
from app.systems.sandbox.lifecycle.planning_scope import (
    LifecyclePlan,
    LifecycleScope,
    canonical_lifecycle_digest,
    load_lifecycle_scope,
    row_state,
    sorted_scalars,
)
from app.systems.sandbox.lifecycle.planning_scope import (
    edge_state as lifecycle_edge_state,
)
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleExternalImpact,
    LifecycleImpactResponse,
    LifecycleKeyStrip,
    LifecycleOperation,
    LifecycleTargetType,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


def plan_lifecycle(
    db: Session,
    target_type: LifecycleTargetType | str,
    target_id: UUID,
    operation: LifecycleOperation | str,
    actor_id: UUID | None,
) -> LifecyclePlan:
    try:
        resolved_target = LifecycleTargetType(target_type)
    except ValueError as error:
        raise LifecycleInvalidTarget(f"Unsupported lifecycle target: {target_type}") from error
    try:
        resolved_operation = LifecycleOperation(operation)
    except ValueError as error:
        raise LifecycleUnsupportedOperation(
            f"Unsupported lifecycle operation: {operation}"
        ) from error
    if resolved_target in {LifecycleTargetType.FILE, LifecycleTargetType.BOARD}:
        raise LifecycleInvalidTarget(f"Unsupported lifecycle target: {target_type}")

    scope = load_lifecycle_scope(db, resolved_target, target_id, resolved_operation)
    all_rows: list[tuple[str, object]] = []
    if resolved_target is LifecycleTargetType.DEPARTMENT:
        all_rows.extend(("departments", row) for row in scope.departments)
    if resolved_target in {
        LifecycleTargetType.DEPARTMENT,
        LifecycleTargetType.MODULE,
    }:
        all_rows.extend(("modules", row) for row in scope.modules)
    if resolved_target in {
        LifecycleTargetType.DEPARTMENT,
        LifecycleTargetType.MODULE,
    }:
        all_rows.extend(("fields", row) for row in scope.fields)
        all_rows.extend(("records", row) for row in scope.records)
    if resolved_target is LifecycleTargetType.FIELD:
        all_rows.extend(("fields", row) for row in scope.fields)
    if resolved_target is LifecycleTargetType.RECORD:
        all_rows.extend(("records", row) for row in scope.records)
    if resolved_operation is LifecycleOperation.PURGE:
        rows = tuple(row_state(entity_type, row) for entity_type, row in all_rows)
    else:
        should_be_deleted = resolved_operation is LifecycleOperation.CLOSE
        rows = tuple(
            row_state(entity_type, row)
            for entity_type, row in all_rows
            if cast(Any, row).is_deleted is not should_be_deleted
        )
    transition_ids = {
        "departments": {row.entity_id for row in rows if row.entity_type == "departments"},
        "modules": {row.entity_id for row in rows if row.entity_type == "modules"},
        "fields": {row.entity_id for row in rows if row.entity_type == "fields"},
        "records": {row.entity_id for row in rows if row.entity_type == "records"},
    }
    purge_blockers: list[LifecycleBlocker] = []
    close_blockers: list[LifecycleBlocker] = []
    if resolved_operation is LifecycleOperation.CLOSE and transition_ids["departments"]:
        default_department_ids = db.scalars(
            select(AccessDefaultDepartment.department_id)
            .where(AccessDefaultDepartment.department_id.in_(transition_ids["departments"]))
            .order_by(AccessDefaultDepartment.department_id)
        ).all()
        closing_departments_by_id = {
            department.id: department for department in scope.departments
        }
        for department_id in default_department_ids:
            default_department = closing_departments_by_id[department_id]
            close_blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.DEFAULT_DEPARTMENT_REFERENCE,
                    entity_type="departments",
                    entity_id=department_id,
                    detail=(
                        f"Department {default_department.department_name} is a default "
                        "for new people. "
                        "Change Access defaults before closing it."
                    ),
                    department_id=department_id,
                    department_name=default_department.department_name,
                )
            )
    dependency_ids: dict[str, tuple[UUID, ...]] = {}
    if resolved_operation is LifecycleOperation.PURGE:
        dependencies = load_purge_dependencies(db, scope, resolved_target)
        rows += dependencies.rows
        purge_blockers.extend(dependencies.blockers)
        dependency_ids = dependencies.ids
    # Close plans contain active rows; reopen plans contain closed rows.
    modules_by_id = {module.id: module for module in scope.modules}
    fields_by_id = {field.id: field for field in scope.fields}
    records_by_id = {record.id: record for record in scope.records}
    for edge in scope.edges:
        if edge.field_id not in fields_by_id:
            field = db.get(Field, edge.field_id)
            if field is not None:
                fields_by_id[edge.field_id] = field
        if edge.source_record_id not in records_by_id:
            source = db.get(Record, edge.source_record_id)
            if source is not None:
                records_by_id[edge.source_record_id] = source
        if edge.target_record_id not in records_by_id:
            target = db.get(Record, edge.target_record_id)
            if target is not None:
                records_by_id[edge.target_record_id] = target
    external_modules: set[UUID] = set()
    for record in records_by_id.values():
        if record is not None:
            external_modules.add(record.module_id)
    for field in fields_by_id.values():
        if field is not None:
            external_modules.add(field.module_id)
            if field.relationship_target_module_id is not None:
                external_modules.add(field.relationship_target_module_id)
    for module_id in external_modules.difference(modules_by_id):
        module = db.get(Module, module_id)
        if module is not None:
            modules_by_id[module.id] = module
    department_ids = {module.department_id for module in modules_by_id.values()}
    departments_by_id = {department.id: department for department in scope.departments}
    for department_id in department_ids.difference(departments_by_id):
        department = db.get(Department, department_id)
        if department is not None:
            departments_by_id[department.id] = department

    key_strips: list[LifecycleKeyStrip] = []
    if resolved_operation is LifecycleOperation.PURGE:
        purge_record_ids = {record.id for record in scope.records}
        for field in scope.fields:
            if getattr(field.type, "value", field.type) == "relationship":
                continue
            key = str(field.id)
            surviving_records = db.execute(
                select(Record.id, Record.module_id)
                .where(
                    Record.module_id == field.module_id,
                    Record.id.not_in(purge_record_ids),
                    Record.data.has_key(key),
                )
                .order_by(Record.id),
            ).all()
            key_strips.extend(
                LifecycleKeyStrip(
                    record_id=record_id,
                    module_id=module_id,
                    field_id=field.id,
                    key=key,
                )
                for record_id, module_id in surviving_records
            )

    purge_module_ids = {module.id for module in scope.modules}
    purge_field_ids = {field.id for field in scope.fields}
    if (
        resolved_operation is LifecycleOperation.PURGE
        and purge_module_ids
        and resolved_target
        in {
            LifecycleTargetType.DEPARTMENT,
            LifecycleTargetType.MODULE,
        }
    ):
        incoming_fields = sorted_scalars(
            db,
            select(Field)
            .where(
                Field.relationship_target_module_id.in_(purge_module_ids),
                Field.id.not_in(purge_field_ids),
            )
            .order_by(Field.id),
        )
        for incoming_field in incoming_fields:
            source_module = modules_by_id.get(incoming_field.module_id)
            target_module = (
                modules_by_id.get(incoming_field.relationship_target_module_id)
                if incoming_field.relationship_target_module_id is not None
                else None
            )
            if source_module is None:
                source_module = db.get(Module, incoming_field.module_id)
                if source_module is not None:
                    modules_by_id[source_module.id] = source_module
            if target_module is None and incoming_field.relationship_target_module_id is not None:
                target_module = db.get(Module, incoming_field.relationship_target_module_id)
                if target_module is not None:
                    modules_by_id[target_module.id] = target_module
            if source_module is None or target_module is None:
                continue
            department = departments_by_id.get(source_module.department_id)
            if department is None:
                department = db.get(Department, source_module.department_id)
                if department is not None:
                    departments_by_id[department.id] = department
            if department is None:
                continue
            purge_blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_EXTERNAL_SCHEMA_DEPENDENCY,
                    entity_type="fields",
                    entity_id=incoming_field.id,
                    detail=(
                        f"Field {incoming_field.name} in module {source_module.module_name} "
                        f"in department {department.department_name} targets module "
                        f"{target_module.module_name} being purged"
                    ),
                    conflicting_entity_type="modules",
                    conflicting_entity_id=target_module.id,
                    field_id=incoming_field.id,
                    field_name=incoming_field.name,
                    module_id=source_module.id,
                    module_name=source_module.module_name,
                    department_id=department.id,
                    department_name=department.department_name,
                )
            )

    if resolved_operation is LifecycleOperation.REOPEN:
        blockers = reopen_blockers(db, scope, resolved_target, transition_ids)
    else:
        blockers = tuple(
            sorted(
                (*purge_blockers, *close_blockers),
                key=lambda blocker: (blocker.entity_type, str(blocker.entity_id), blocker.code),
            )
        )

    edge_states = tuple(
        lifecycle_edge_state(edge, fields_by_id, records_by_id, modules_by_id)
        for edge in scope.edges
    )
    structural_record_ids = {record.id for record in scope.records}
    impacts: list[LifecycleExternalImpact] = []
    for edge, edge_state in zip(scope.edges, edge_states, strict=True):
        if not edge_state.available:
            continue
        field = fields_by_id.get(edge.field_id)
        source = records_by_id.get(edge.source_record_id)
        target = records_by_id.get(edge.target_record_id)
        if field is None or source is None or target is None:
            continue
        source_module = modules_by_id.get(source.module_id)
        target_module = modules_by_id.get(target.module_id)
        if source_module is None or target_module is None:
            continue
        impacted = bool(
            edge.field_id in transition_ids["fields"]
            or edge.source_record_id in transition_ids["records"]
            or edge.target_record_id in transition_ids["records"]
            or source_module.id in transition_ids["modules"]
            or target_module.id in transition_ids["modules"]
            or source_module.department_id in transition_ids["departments"]
            or target_module.department_id in transition_ids["departments"]
        )
        if not impacted:
            continue
        external_records = [
            record for record in (source, target) if record.id not in structural_record_ids
        ]
        # A Field owns no records. Therefore both endpoints of a relationship
        # field are external even when they live in its parent Module.
        for external_record in {record.id: record for record in external_records}.values():
            external_module = modules_by_id.get(external_record.module_id)
            if external_module is None:
                continue
            external_department = departments_by_id.get(external_module.department_id)
            if external_department is None:
                continue
            impacts.append(
                LifecycleExternalImpact(
                    edge_id=edge.id,
                    field_id=edge.field_id,
                    external_record_id=external_record.id,
                    external_module_id=external_module.id,
                    external_module_name=external_module.module_name,
                    external_department_id=external_department.id,
                    external_department_name=external_department.department_name,
                )
            )
    impacts.sort(
        key=lambda impact: (
            str(impact.edge_id),
            str(impact.external_record_id),
            str(impact.external_module_id),
        )
    )

    digest = canonical_lifecycle_digest(
        resolved_operation,
        resolved_target,
        target_id,
        actor_id,
        rows,
        edge_states,
        key_strips,
        blockers,
    )
    scope_ids = scope.ids
    scope_ids.update(dependency_ids)
    # Edge dependencies are locked as part of the transaction even when they
    # are outside the structural mutation scope (notably for Field plans).
    scope_ids["fields"] = tuple(sorted(set(scope_ids["fields"]) | set(fields_by_id)))
    scope_ids["records"] = tuple(sorted(set(scope_ids["records"]) | set(records_by_id)))
    scope_ids["modules"] = tuple(sorted(set(scope_ids["modules"]) | set(modules_by_id)))
    scope_ids["departments"] = tuple(sorted(set(scope_ids["departments"]) | set(departments_by_id)))
    scope_ids["fields"] = tuple(
        sorted(
            set(scope_ids["fields"])
            | {blocker.field_id for blocker in blockers if blocker.field_id}
        )
    )
    scope_ids["records"] = tuple(
        sorted(set(scope_ids["records"]) | {strip.record_id for strip in key_strips})
    )
    return LifecyclePlan(
        target_type=resolved_target,
        target_id=target_id,
        operation=resolved_operation,
        actor_id=actor_id,
        scope_ids=scope_ids,
        rows=rows,
        edge_states=edge_states,
        external_impacts=tuple(impacts),
        key_strips=tuple(key_strips),
        blockers=blockers,
        impact_digest=digest,
    )


def impact_response(plan: LifecyclePlan) -> LifecycleImpactResponse:
    return plan.response()


build_lifecycle_plan = plan_lifecycle


__all__ = [
    "LifecyclePlan",
    "LifecycleScope",
    "canonical_lifecycle_digest",
    "build_lifecycle_plan",
    "impact_response",
    "plan_lifecycle",
]
