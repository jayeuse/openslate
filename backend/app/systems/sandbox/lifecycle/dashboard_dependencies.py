"""Dashboard dependencies for physical source purges.

A department purge removes the department's Dashboards and their widgets, as it
removes the saved views of its modules. A widget whose saved query reads a purged
module or field from another department's Dashboard blocks the purge.
"""

from collections.abc import Callable, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)
from app.systems.sandbox.modules.models import Module


def _widget_references_field(config: dict[str, object], field_ids: set[str]) -> bool:
    query = config.get("query")
    if not isinstance(query, dict):
        return False
    references: list[object] = [query.get(key) for key in ("dimension", "date_field", "measure")]
    definition = query.get("definition")
    if isinstance(definition, dict):
        for key in ("columns", "filters", "sort", "search_fields"):
            entries = definition.get(key)
            if isinstance(entries, list):
                references.extend(entries)
    return any(
        isinstance(reference, dict)
        and isinstance(reference.get("field_id"), str)
        and reference["field_id"] in field_ids
        for reference in references
    )


def _widgets_reading(
    db: Session, module_ids: Sequence[UUID], field_ids: Sequence[UUID]
) -> list[DashboardWidget]:
    if not module_ids:
        return []
    widgets = list(
        db.scalars(
            select(DashboardWidget)
            .where(
                DashboardWidget.config["query"]["module_id"]
                .as_string()
                .in_([str(module_id) for module_id in module_ids])
            )
            .order_by(DashboardWidget.id)
        ).all()
    )
    if not field_ids:
        return widgets
    field_ids_as_text = {str(field_id) for field_id in field_ids}
    return [
        widget for widget in widgets if _widget_references_field(widget.config, field_ids_as_text)
    ]


def load_dashboard_purge_dependencies(
    db: Session,
    department_ids: Sequence[UUID],
    widget_module_ids: Sequence[UUID],
    field_ids: Sequence[UUID],
    target_field: Field | None,
    modules: Sequence[Module],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]]]:
    """Return the Dashboard rows of a purge, and a blocker for each foreign widget.

    ``field_ids`` is empty unless the purge target is a field.
    """

    owned = (
        list(
            db.scalars(
                select(Dashboard)
                .where(Dashboard.department_id.in_(department_ids))
                .order_by(Dashboard.id)
            )
        )
        if department_ids
        else []
    )
    owned_ids = {dashboard.id for dashboard in owned}
    owned_widgets = (
        list(
            db.scalars(
                select(DashboardWidget)
                .where(DashboardWidget.dashboard_id.in_(owned_ids))
                .order_by(DashboardWidget.id)
            )
        )
        if owned_ids
        else []
    )
    blocking = [
        widget
        for widget in _widgets_reading(db, widget_module_ids, field_ids)
        if widget.dashboard_id not in owned_ids
    ]
    blocking_ids = sorted({widget.dashboard_id for widget in blocking})
    foreign = (
        list(
            db.scalars(
                select(Dashboard).where(Dashboard.id.in_(blocking_ids)).order_by(Dashboard.id)
            ).all()
        )
        if blocking_ids
        else []
    )
    dashboards = owned + foreign
    widgets = owned_widgets + blocking

    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for dashboard in dashboards:
        state = row_state("dashboards", dashboard)
        state.state_fingerprint = fingerprint(
            {
                "department_id": dashboard.department_id,
                "position": dashboard.position,
                "name": dashboard.name,
                "revision": dashboard.revision,
            }
        )
        rows.append(state)
    dashboards_by_id = {dashboard.id: dashboard for dashboard in dashboards}
    modules_by_id = {str(module.id): module for module in modules}
    source_label = f"Field {target_field.name!r}" if target_field is not None else "the Module"
    for widget in widgets:
        state = row_state("dashboard_widgets", widget)
        state.state_fingerprint = fingerprint(
            {
                "dashboard_id": widget.dashboard_id,
                "position": widget.position,
                "widget_type": widget.widget_type,
                "config": widget.config,
            }
        )
        rows.append(state)
        if widget.dashboard_id in owned_ids:
            continue
        widget_dashboard = dashboards_by_id.get(widget.dashboard_id)
        query_config = widget.config.get("query")
        module_id = query_config.get("module_id") if isinstance(query_config, dict) else None
        module = modules_by_id.get(module_id) if isinstance(module_id, str) else None
        dashboard_name = widget_dashboard.name if widget_dashboard is not None else ""
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_DASHBOARD_DEPENDENCY,
                entity_type="dashboard_widgets",
                entity_id=widget.id,
                detail=(
                    f"Remove or update the saved query in Dashboard {dashboard_name!r} before "
                    f"purging {source_label}; purge will not delete the Dashboard or its "
                    "other widgets"
                ),
                conflicting_entity_type="dashboards",
                conflicting_entity_id=widget.dashboard_id,
                field_id=target_field.id if target_field is not None else None,
                field_name=target_field.name if target_field is not None else None,
                module_id=module.id if module is not None else None,
                module_name=module.module_name if module is not None else None,
            )
        )
    ids = {
        "dashboards": tuple(dashboard.id for dashboard in dashboards),
        "dashboard_widgets": tuple(widget.id for widget in widgets),
    }
    return rows, blockers, ids
