"""Deterministic lifecycle scope and impact planning."""

import hashlib
import json
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID

from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app.systems.departments.models import Department
from app.systems.fields.models import Field
from app.systems.lifecycle.exceptions import (
    LifecycleClosedAncestorError,
    LifecycleInvalidTarget,
    LifecycleNotFound,
    LifecyclePurgePreconditionError,
    LifecycleRecordCloseError,
    LifecycleUnsupportedOperation,
)
from app.systems.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleEdgeState,
    LifecycleExternalImpact,
    LifecycleImpactResponse,
    LifecycleKeyStrip,
    LifecycleOperation,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.modules.models import Module
from app.systems.records.models import Record
from app.systems.relationships.models import RelationshipEdge


@dataclass(frozen=True)
class LifecycleScope:
    departments: tuple[Department, ...]
    modules: tuple[Module, ...]
    fields: tuple[Field, ...]
    records: tuple[Record, ...]
    edges: tuple[RelationshipEdge, ...]

    @property
    def ids(self) -> dict[str, tuple[UUID, ...]]:
        return {
            "departments": tuple(sorted(row.id for row in self.departments)),
            "modules": tuple(sorted(row.id for row in self.modules)),
            "fields": tuple(sorted(row.id for row in self.fields)),
            "records": tuple(sorted(row.id for row in self.records)),
            "relationship_edges": tuple(sorted(row.id for row in self.edges)),
        }


@dataclass(frozen=True)
class LifecyclePlan:
    target_type: LifecycleTargetType
    target_id: UUID
    operation: LifecycleOperation
    actor_id: UUID | None
    scope_ids: dict[str, tuple[UUID, ...]]
    rows: tuple[LifecycleRowState, ...]
    edge_states: tuple[LifecycleEdgeState, ...]
    external_impacts: tuple[LifecycleExternalImpact, ...]
    key_strips: tuple[LifecycleKeyStrip, ...]
    blockers: tuple[LifecycleBlocker, ...]
    impact_digest: str

    def response(self) -> LifecycleImpactResponse:
        return LifecycleImpactResponse(
            target_type=self.target_type,
            target_id=self.target_id,
            operation=self.operation,
            actor_id=self.actor_id,
            rows=list(self.rows),
            external_impacts=list(self.external_impacts),
            key_strips=list(self.key_strips),
            blockers=list(self.blockers),
            impact_digest=self.impact_digest,
        )


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def canonical_lifecycle_digest(
    operation: LifecycleOperation,
    target_type: LifecycleTargetType,
    root_id: UUID,
    actor_id: UUID | None,
    rows: tuple[LifecycleRowState, ...] | list[LifecycleRowState],
    edges: tuple[LifecycleEdgeState, ...] | list[LifecycleEdgeState] = (),
    key_strips: tuple[LifecycleKeyStrip, ...] | list[LifecycleKeyStrip] = (),
    blockers: tuple[LifecycleBlocker, ...] | list[LifecycleBlocker] = (),
) -> str:
    """Hash the stable operation/root/actor and sorted current database state."""

    payload = {
        "operation": operation.value,
        "root": {"type": target_type.value, "id": str(root_id)},
        "actor": str(actor_id) if actor_id is not None else None,
        "rows": [
            row.model_dump(mode="json")
            for row in sorted(rows, key=lambda item: (item.entity_type, str(item.entity_id)))
        ],
        "edges": [
            edge.model_dump(mode="json")
            for edge in sorted(edges, key=lambda item: str(item.edge_id))
        ],
        "key_strips": [
            strip.model_dump(mode="json")
            for strip in sorted(
                key_strips,
                key=lambda item: (str(item.record_id), str(item.field_id), item.key),
            )
        ],
        "blockers": [
            blocker.model_dump(mode="json")
            for blocker in sorted(
                blockers,
                key=lambda item: (item.entity_type, str(item.entity_id), str(item.code)),
            )
        ],
    }
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def _target_model(target_type: LifecycleTargetType) -> type[Any]:
    return {
        LifecycleTargetType.DEPARTMENT: Department,
        LifecycleTargetType.MODULE: Module,
        LifecycleTargetType.FIELD: Field,
        LifecycleTargetType.RECORD: Record,
    }[target_type]


def _load_one(db: Session, model: type[Any], object_id: UUID, label: str) -> Any:
    item = db.get(model, object_id)
    if item is None:
        raise LifecycleNotFound(f"{label} not found")
    return item


def _sorted_scalars[ModelT](db: Session, statement: Select[tuple[ModelT]]) -> tuple[ModelT, ...]:
    return tuple(db.scalars(statement).all())


def _load_scope(
    db: Session,
    target_type: LifecycleTargetType,
    target_id: UUID,
    operation: LifecycleOperation,
) -> LifecycleScope:
    target = _load_one(db, _target_model(target_type), target_id, target_type.value.title())
    if operation is LifecycleOperation.PURGE and not target.is_deleted:
        raise LifecyclePurgePreconditionError(
            f"Cannot purge an open {target_type.value}; close it first"
        )

    if target_type is LifecycleTargetType.DEPARTMENT:
        department_row: Department = target
        departments = (department_row,)
        modules: tuple[Module, ...] = _sorted_scalars(
            db,
            select(Module)
            .where(Module.department_id == department_row.id)
            .order_by(Module.id),
        )
        module_ids = [module.id for module in modules]
        fields: tuple[Field, ...] = (
            _sorted_scalars(
                db, select(Field).where(Field.module_id.in_(module_ids)).order_by(Field.id)
            )
            if module_ids
            else tuple()
        )
        records: tuple[Record, ...] = (
            _sorted_scalars(
                db, select(Record).where(Record.module_id.in_(module_ids)).order_by(Record.id)
            )
            if module_ids
            else tuple()
        )
    elif target_type is LifecycleTargetType.MODULE:
        module_row: Module = target
        department_module: Department = _load_one(
            db, Department, module_row.department_id, "Department"
        )
        departments = (department_module,)
        modules = (module_row,)
        fields = _sorted_scalars(
            db, select(Field).where(Field.module_id == module_row.id).order_by(Field.id)
        )
        records = _sorted_scalars(
            db, select(Record).where(Record.module_id == module_row.id).order_by(Record.id)
        )
        if operation is LifecycleOperation.REOPEN and department_module.is_deleted:
            raise LifecycleClosedAncestorError(
                f"Cannot reopen module {module_row.module_name} beneath closed department "
                f"{department_module.department_name}"
            )
    elif target_type is LifecycleTargetType.FIELD:
        field_row: Field = target
        module_field: Module = _load_one(db, Module, field_row.module_id, "Module")
        department_field: Department = _load_one(
            db, Department, module_field.department_id, "Department"
        )
        departments = (department_field,)
        modules = (module_field,)
        fields = (field_row,)
        records = tuple()
        if operation is LifecycleOperation.REOPEN and module_field.is_deleted:
            raise LifecycleClosedAncestorError(
                f"Cannot reopen field {field_row.name} beneath closed module "
                f"{module_field.module_name}"
            )
        if operation is LifecycleOperation.REOPEN and department_field.is_deleted:
            raise LifecycleClosedAncestorError(
                f"Cannot reopen field {field_row.name} beneath closed department "
                f"{department_field.department_name}"
            )
    else:
        record_row: Record = target
        module_record: Module = _load_one(db, Module, record_row.module_id, "Module")
        department_record: Department = _load_one(
            db, Department, module_record.department_id, "Department"
        )
        departments = (department_record,)
        modules = (module_record,)
        fields = tuple()
        records = (record_row,)
        if operation is LifecycleOperation.CLOSE:
            raise LifecycleRecordCloseError("Records cannot be closed by lifecycle operations")

    field_ids = [field.id for field in fields]
    record_ids = [record.id for record in records]
    edge_conditions = []
    if field_ids:
        edge_conditions.append(RelationshipEdge.field_id.in_(field_ids))
    if record_ids:
        edge_conditions.extend(
            (
                RelationshipEdge.source_record_id.in_(record_ids),
                RelationshipEdge.target_record_id.in_(record_ids),
            )
        )
    edges = (
        _sorted_scalars(
            db,
            select(RelationshipEdge)
            .where(or_(*edge_conditions))
            .order_by(RelationshipEdge.id),
        )
        if edge_conditions
        else ()
    )
    return LifecycleScope(departments, modules, fields, records, edges)


def load_lifecycle_scope(
    db: Session,
    target_type: LifecycleTargetType,
    target_id: UUID,
    operation: LifecycleOperation,
) -> LifecycleScope:
    return _load_scope(db, target_type, target_id, operation)


def _row_state(entity_type: str, row: object) -> LifecycleRowState:
    state = {
        key: getattr(row, key)
        for key in (
            "department_id",
            "department_name",
            "module_id",
            "module_name",
            "is_schema_accepted",
            "name",
            "type",
            "required",
            "position",
            "config",
            "relationship_target_module_id",
            "data",
        )
        if hasattr(row, key)
    }
    return LifecycleRowState(
        entity_type=entity_type,
        entity_id=row.id,  # type: ignore[attr-defined]
        is_deleted=row.is_deleted,  # type: ignore[attr-defined]
        deleted_at=row.deleted_at,  # type: ignore[attr-defined]
        updated_at=row.updated_at,  # type: ignore[attr-defined]
        state_fingerprint=hashlib.sha256(_canonical(state).encode("utf-8")).hexdigest(),
    )


def _edge_state(
    edge: RelationshipEdge,
    fields: dict[UUID, Field],
    records: dict[UUID, Record],
    modules: dict[UUID, Module],
) -> LifecycleEdgeState:
    field = fields.get(edge.field_id)
    source = records.get(edge.source_record_id)
    target = records.get(edge.target_record_id)
    source_module = modules.get(source.module_id) if source is not None else None
    target_module = modules.get(target.module_id) if target is not None else None
    available = bool(
        not edge.is_deleted
        and field is not None
        and not field.is_deleted
        and source is not None
        and not source.is_deleted
        and target is not None
        and not target.is_deleted
        and source_module is not None
        and not source_module.is_deleted
        and target_module is not None
        and not target_module.is_deleted
    )
    return LifecycleEdgeState(
        edge_id=edge.id,
        field_id=edge.field_id,
        source_record_id=edge.source_record_id,
        target_record_id=edge.target_record_id,
        is_deleted=edge.is_deleted,
        deleted_at=edge.deleted_at,
        updated_at=edge.updated_at,
        available=available,
        state_fingerprint=hashlib.sha256(
            _canonical(
                {
                    "edge_deleted": edge.is_deleted,
                    "field_deleted": field.is_deleted if field is not None else None,
                    "field_name": field.name if field is not None else None,
                    "source_deleted": source.is_deleted if source is not None else None,
                    "target_deleted": target.is_deleted if target is not None else None,
                    "source_module": (
                        source_module.module_name if source_module is not None else None
                    ),
                    "target_module": (
                        target_module.module_name if target_module is not None else None
                    ),
                }
            ).encode("utf-8")
        ).hexdigest(),
    )


def _reopen_blockers(
    db: Session,
    scope: LifecycleScope,
    _target_type: LifecycleTargetType,
    transition_ids: dict[str, set[UUID]],
) -> tuple[LifecycleBlocker, ...]:
    """Return deterministic preflight blockers without changing ORM state."""

    blockers: list[LifecycleBlocker] = []
    department_ids = [department.id for department in scope.departments]
    all_department_modules = (
        list(
            db.scalars(
                select(Module)
                .where(Module.department_id.in_(department_ids))
                .order_by(Module.id)
            ).all()
        )
        if department_ids
        else []
    )
    active_modules = [module for module in all_department_modules if not module.is_deleted]
    reopening_modules = [
        module for module in all_department_modules if module.id in transition_ids["modules"]
    ]
    module_keys: dict[tuple[UUID, str], UUID] = {}
    for module in reopening_modules:
        conflicts = [
            other
            for other in active_modules
            if other.id not in transition_ids["modules"]
            and other.department_id == module.department_id
            and other.module_name == module.module_name
        ]
        if conflicts:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.MODULE_NAME_CONFLICT,
                    entity_type="modules",
                    entity_id=module.id,
                    detail=f"Module name is already active: {module.module_name}",
                    conflicting_entity_type="modules",
                    conflicting_entity_id=conflicts[0].id,
                )
            )
        key = (module.department_id, module.module_name)
        if key in module_keys:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.MODULE_NAME_CONFLICT,
                    entity_type="modules",
                    entity_id=module.id,
                    detail=f"Reopened modules share an active name: {module.module_name}",
                    conflicting_entity_type="modules",
                    conflicting_entity_id=module_keys[key],
                )
            )
        module_keys[key] = module.id

    module_ids = [module.id for module in scope.modules]
    all_module_fields = (
        list(
            db.scalars(
                select(Field).where(Field.module_id.in_(module_ids)).order_by(Field.id)
            ).all()
        )
        if module_ids
        else []
    )
    all_module_records = (
        list(
            db.scalars(
                select(Record).where(Record.module_id.in_(module_ids)).order_by(Record.id)
            ).all()
        )
        if module_ids
        else []
    )
    active_fields = [field for field in all_module_fields if not field.is_deleted]
    reopening_fields = [
        field for field in all_module_fields if field.id in transition_ids["fields"]
    ]
    field_name_keys: dict[tuple[UUID, str], UUID] = {}
    field_position_keys: dict[tuple[UUID, int], UUID] = {}
    for field in reopening_fields:
        name_conflict = any(
            other.id not in transition_ids["fields"]
            and other.module_id == field.module_id
            and other.name == field.name
            for other in active_fields
        )
        position_conflict = any(
            other.id not in transition_ids["fields"]
            and other.module_id == field.module_id
            and other.position == field.position
            for other in active_fields
        )
        if name_conflict:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_NAME_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Field name is already active: {field.name}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=next(
                        other.id
                        for other in active_fields
                        if other.id not in transition_ids["fields"]
                        and other.module_id == field.module_id
                        and other.name == field.name
                    ),
                )
            )
        if position_conflict:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_POSITION_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Field position is already active: {field.position}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=next(
                        other.id
                        for other in active_fields
                        if other.id not in transition_ids["fields"]
                        and other.module_id == field.module_id
                        and other.position == field.position
                    ),
                )
            )
        name_key = (field.module_id, field.name)
        if name_key in field_name_keys:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_NAME_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Reopened fields share an active name: {field.name}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=field_name_keys[name_key],
                )
            )
        field_name_keys[name_key] = field.id
        position_key = (field.module_id, field.position)
        if position_key in field_position_keys:
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.FIELD_POSITION_CONFLICT,
                    entity_type="fields",
                    entity_id=field.id,
                    detail=f"Reopened fields share an active position: {field.position}",
                    conflicting_entity_type="fields",
                    conflicting_entity_id=field_position_keys[position_key],
                )
            )
        field_position_keys[position_key] = field.id

    effective_fields_by_module: dict[UUID, list[Field]] = {}
    for field in all_module_fields:
        if not field.is_deleted or field.id in transition_ids["fields"]:
            effective_fields_by_module.setdefault(field.module_id, []).append(field)
    for module in scope.modules:
        fields = effective_fields_by_module.get(module.id, [])
        module_records = [
            record
            for record in all_module_records
            if record.module_id == module.id
            and (not record.is_deleted or record.id in transition_ids["records"])
        ]
        reopening_records = any(
            record.id in transition_ids["records"] for record in module_records
        )
        if module.id in transition_ids["modules"] or any(
            field.id in transition_ids["fields"] for field in fields
        ) or reopening_records:
            try:
                from app.systems.fields.validation import validate_module_schema

                validate_module_schema(fields)
            except ValueError as error:
                blockers.append(
                    LifecycleBlocker(
                        code=LifecycleBlockerCode.SCHEMA_INVALID,
                        entity_type="modules",
                        entity_id=module.id,
                        detail=f"Module schema is invalid: {error}",
                    )
                )
        if module.id in transition_ids["modules"] or module_records:
            for record in module_records:
                try:
                    from app.systems.fields.validation import validate_record_data

                    validate_record_data(record.data, fields)
                except ValueError as error:
                    blockers.append(
                        LifecycleBlocker(
                            code=LifecycleBlockerCode.RECORD_DATA_INVALID,
                            entity_type="records",
                            entity_id=record.id,
                            detail=f"Record data is incompatible with the module schema: {error}",
                        )
                    )

    return tuple(
        sorted(
            blockers,
            key=lambda blocker: (blocker.entity_type, str(blocker.entity_id), blocker.code),
        )
    )


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

    scope = _load_scope(db, resolved_target, target_id, resolved_operation)
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
        rows = tuple(_row_state(entity_type, row) for entity_type, row in all_rows)
    else:
        should_be_deleted = resolved_operation is LifecycleOperation.CLOSE
        rows = tuple(
            _row_state(entity_type, row)
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
            surviving_records = _sorted_scalars(
                db,
                select(Record)
                .where(
                    Record.module_id == field.module_id,
                    Record.id.not_in(purge_record_ids),
                )
                .order_by(Record.id),
            )
            key = str(field.id)
            key_strips.extend(
                LifecycleKeyStrip(
                    record_id=record.id,
                    module_id=record.module_id,
                    field_id=field.id,
                    key=key,
                )
                for record in surviving_records
                if key in record.data
            )

    purge_module_ids = {module.id for module in scope.modules}
    purge_field_ids = {field.id for field in scope.fields}
    if resolved_operation is LifecycleOperation.PURGE and purge_module_ids and resolved_target in {
        LifecycleTargetType.DEPARTMENT,
        LifecycleTargetType.MODULE,
    }:
        incoming_fields = _sorted_scalars(
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
        blockers = _reopen_blockers(db, scope, resolved_target, transition_ids)
    else:
        blockers = tuple(
            sorted(
                purge_blockers,
                key=lambda blocker: (blocker.entity_type, str(blocker.entity_id), blocker.code),
            )
        )

    edge_states = tuple(
        _edge_state(edge, fields_by_id, records_by_id, modules_by_id) for edge in scope.edges
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
            record
            for record in (source, target)
            if record.id not in structural_record_ids
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
    # Edge dependencies are locked as part of the transaction even when they
    # are outside the structural mutation scope (notably for Field plans).
    scope_ids["fields"] = tuple(sorted(set(scope_ids["fields"]) | set(fields_by_id)))
    scope_ids["records"] = tuple(sorted(set(scope_ids["records"]) | set(records_by_id)))
    scope_ids["modules"] = tuple(sorted(set(scope_ids["modules"]) | set(modules_by_id)))
    scope_ids["departments"] = tuple(
        sorted(set(scope_ids["departments"]) | set(departments_by_id))
    )
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
    "load_lifecycle_scope",
    "plan_lifecycle",
]
