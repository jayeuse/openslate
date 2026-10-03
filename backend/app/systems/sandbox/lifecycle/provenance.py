"""Select the rows owned by a close operation without reviving independent closures."""

from typing import Any
from uuid import UUID

from app.systems.sandbox.lifecycle.exceptions import LifecycleClosedAncestorError
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation


def transition_rows(
    scope: LifecycleScope,
    rows: list[tuple[str, Any]],
    root_id: UUID,
    operation: LifecycleOperation,
) -> list[tuple[str, Any]]:
    if operation is LifecycleOperation.CLOSE:
        return [(kind, row) for kind, row in rows if not row.is_deleted]
    root = next(row for _, row in rows if row.id == root_id)
    marker = root.lifecycle_close_operation_id
    selected = [
        (kind, row)
        for kind, row in rows
        if row.is_deleted
        and (
            row.id == root_id or (marker is not None and row.lifecycle_close_operation_id == marker)
        )
    ]
    selected_ids = {row.id for _, row in selected}
    departments = {row.id: row for row in scope.departments}
    modules = {row.id: row for row in scope.modules}
    for kind, row in selected:
        owner = (
            departments[row.department_id]
            if kind == "modules"
            else modules[row.module_id]
            if kind in {"fields", "records"}
            else None
        )
        if owner is not None and owner.is_deleted and owner.id not in selected_ids:
            raise LifecycleClosedAncestorError("Cannot reopen an item beneath a closed owner")
    return selected
