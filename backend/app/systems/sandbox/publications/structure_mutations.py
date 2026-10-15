"""Small structural mutation helpers used by the publication transaction."""

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import Group, GroupAccess
from app.systems.boards.department_boards import sync_department_board
from app.systems.openview.charts.models import Chart
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.rules import _field_key


def sync_module_chart_departments(
    db: Session, modules: Mapping[str, Module], actor_id: UUID
) -> None:
    """Propagate locked Module ownership to all retained Charts without committing."""
    by_id = {module.id: module for module in modules.values()}
    if not by_id:
        return
    charts = db.scalars(
        select(Chart)
        .where(Chart.module_id.in_(by_id))
        .order_by(Chart.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    for chart in charts:
        department_id = by_id[chart.module_id].department_id
        if chart.department_id != department_id:
            chart.department_id = department_id
            chart.revision += 1
            chart.performed_by = actor_id


def lock_module_access(db: Session) -> None:
    """Lock the live groups FOR SHARE, then the live module access rows FOR UPDATE.

    This runs before any structure lock, in the order of every group writer and of
    ``_lock_authority``: a member's fresh access check waits here and holds nothing
    that the publish needs, so the publish never waits on it while holding a module.
    """

    db.execute(
        select(Group.id)
        .where(Group.is_deleted.is_(False))
        .order_by(Group.id)
        .with_for_update(read=True)
    ).all()
    db.execute(
        select(GroupAccess.id)
        .where(GroupAccess.module_id.is_not(None), GroupAccess.is_deleted.is_(False))
        .order_by(GroupAccess.id)
        .with_for_update()
    ).all()


def sync_module_access_departments(db: Session, actor_id: UUID) -> None:
    """Move each live module access row to its module's department without committing.

    It covers every module, closed ones too, so a row left behind by a move before
    grants followed their module is repaired. Such a row can share its group and
    module with a newer row in another department. The most recently written row
    is the administrator's latest intent: it stays, and the older rows go.
    """

    db.flush()
    grants = (
        db.execute(
            select(GroupAccess, Module.department_id)
            .join(Module, Module.id == GroupAccess.module_id)
            .where(GroupAccess.is_deleted.is_(False))
            .order_by(GroupAccess.id)
            .execution_options(populate_existing=True)
        )
        .tuples()
        .all()
    )
    latest: dict[tuple[UUID, UUID | None], tuple[GroupAccess, UUID]] = {}
    for grant, department_id in sorted(grants, key=lambda row: (row[0].updated_at, row[0].id)):
        latest[(grant.group_id, grant.module_id)] = (grant, department_id)
    kept = {id(grant) for grant, _ in latest.values()}
    for grant, _ in grants:
        if id(grant) not in kept:
            db.delete(grant)
    db.flush()
    for grant, department_id in latest.values():
        if grant.department_id != department_id:
            grant.department_id = department_id
            grant.performed_by = actor_id


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
