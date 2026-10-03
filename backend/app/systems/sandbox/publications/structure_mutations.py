"""Small structural mutation helpers used by the publication transaction."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.department_boards import sync_department_board
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.rules import _field_key


def stage_bound_names_and_positions(
    db: Session, document: Any, bindings: Any, actor_id: UUID
) -> dict[tuple[str, str], tuple[str, int | None]]:
    """Free active unique names and positions before applying swaps or reorders."""

    desired = {
        "department": {item.id for item in document.design.departments},
        "module": {item.id for item in document.design.modules},
        "field": {
            _field_key(module.id, field.id)
            for module in document.design.modules
            for field in module.fields
        },
        "relationship": {item.id for item in document.design.relationships},
    }
    staged = "__sandbox_publish_"
    retired: dict[tuple[str, str], tuple[str, int | None]] = {}
    for binding in bindings["department"].values():
        department = db.get(Department, binding.department_id)
        if department is not None and not department.is_deleted:
            if binding.sandbox_id not in desired["department"]:
                retired[("department", binding.sandbox_id)] = (department.department_name, None)
            department.department_name = f"{staged}{department.id}"
            department.performed_by = actor_id
    for binding in bindings["module"].values():
        module = db.get(Module, binding.module_id)
        if module is not None and not module.is_deleted:
            if binding.sandbox_id not in desired["module"]:
                retired[("module", binding.sandbox_id)] = (module.module_name, None)
            module.module_name = f"{staged}{module.id}"
            module.performed_by = actor_id
    for kind in ("field", "relationship"):
        for binding in bindings[kind].values():
            field = db.get(Field, binding.field_id)
            if field is not None and not field.is_deleted:
                if binding.sandbox_id not in desired[kind]:
                    retired[(kind, binding.sandbox_id)] = (field.name, field.position)
                field.name = f"{staged}{field.id}"
                field.position += 10_000_000
                field.performed_by = actor_id
    db.flush()
    return retired


def close_removed_structure(
    db: Session,
    document: Any,
    bindings: Any,
    actor_id: UUID,
    retired: dict[tuple[str, str], tuple[str, int | None]],
) -> None:
    desired = {
        "department": {item.id for item in document.design.departments},
        "module": {item.id for item in document.design.modules},
        "field": {
            _field_key(module.id, field.id)
            for module in document.design.modules
            for field in module.fields
        },
        "relationship": {item.id for item in document.design.relationships},
    }
    for kind in ("department", "module", "field", "relationship"):
        for sandbox_id, binding in bindings[kind].items():
            if sandbox_id in desired[kind]:
                continue
            original = retired.get((kind, sandbox_id))
            if kind == "department":
                department = db.get(Department, binding.department_id)
                if department is not None:
                    _close(department, actor_id)
                    if original is not None:
                        department.department_name = original[0]
            elif kind == "module":
                module = db.get(Module, binding.module_id)
                if module is not None:
                    _close(module, actor_id)
                    if original is not None:
                        module.module_name = original[0]
            else:
                field = db.get(Field, binding.field_id)
                if field is not None:
                    _close(field, actor_id)
                    if original is not None:
                        field.name = original[0]
                        if original[1] is not None:
                            field.position = original[1]


def sync_department_boards(db: Session, actor_id: UUID) -> None:
    """Give every department its Board after a publish, and follow closes and reopens."""

    for department in db.scalars(select(Department).order_by(Department.id)):
        sync_department_board(db, department, actor_id=actor_id)
    db.flush()


def _close(row: Department | Module | Field, actor_id: UUID) -> None:
    row.lifecycle_close_operation_id = None
    row.is_deleted = True
    row.deleted_at = datetime.now(UTC)
    row.performed_by = actor_id
