"""Deterministic lifecycle scope and impact planning."""

import hashlib
import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleClosedAncestorError,
    LifecycleNotFound,
    LifecyclePurgePreconditionError,
    LifecycleRecordCloseError,
)
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleEdgeState,
    LifecycleExternalImpact,
    LifecycleImpactResponse,
    LifecycleKeyStrip,
    LifecycleOperation,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge


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
            select(Module).where(Module.department_id == department_row.id).order_by(Module.id),
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
            select(RelationshipEdge).where(or_(*edge_conditions)).order_by(RelationshipEdge.id),
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
            "title_field_id",
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


# These names are intentionally public within the lifecycle capability; plan
# construction and preflight validation use them without importing its facade.
edge_state = _edge_state
row_state = _row_state
sorted_scalars = _sorted_scalars
