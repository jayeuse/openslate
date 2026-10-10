"""Dashboard dependencies for physical source purges.

A department purge removes the department's Dashboards and their widgets, as it
removes the saved views of its modules. A widget whose saved query reads a purged
module or field from another department's Dashboard blocks the purge.
"""

from collections.abc import Callable, Mapping, Sequence
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.chart_dependencies import query_references_fields
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)
from app.systems.sandbox.modules.models import Module


def _widgets_reading(
    db: Session, module_ids: Sequence[UUID], field_ids: Sequence[UUID], charts: Mapping[UUID, Chart]
) -> list[DashboardWidget]:
    if not module_ids:
        return []
    widgets = list(
        db.scalars(
            select(DashboardWidget)
            .where(
                or_(
                    DashboardWidget.config["query"]["module_id"]
                    .as_string()
                    .in_([str(module_id) for module_id in module_ids]),
                    DashboardWidget.chart_id.in_(charts),
                )
            )
            .order_by(DashboardWidget.id)
        ).all()
    )
    if not field_ids:
        return widgets
    field_ids_as_text = {str(field_id) for field_id in field_ids}
    return [
        widget
        for widget in widgets
        if widget.chart_id in charts
        or (
            widget.config is not None
            and query_references_fields(widget.config.get("query"), field_ids_as_text)
        )
    ]


def load_dashboard_purge_dependencies(
    db: Session,
    department_ids: Sequence[UUID],
    widget_module_ids: Sequence[UUID],
    field_ids: Sequence[UUID],
    target_field: Field | None,
    modules: Sequence[Module],
    fingerprint: Callable[[object], str],
    charts: Mapping[UUID, Chart] | None = None,
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
    retained_charts = charts or {}
    blocking = [
        widget
        for widget in _widgets_reading(db, widget_module_ids, field_ids, retained_charts)
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
                "chart_id": widget.chart_id,
                "size": widget.size,
            }
        )
        rows.append(state)
        if widget.dashboard_id in owned_ids:
            continue
        widget_dashboard = dashboards_by_id.get(widget.dashboard_id)
        chart = retained_charts.get(widget.chart_id) if widget.chart_id is not None else None
        query_config = widget.config.get("query") if widget.config is not None else None
        module_id = (
            str(chart.module_id)
            if chart is not None
            else (query_config.get("module_id") if isinstance(query_config, dict) else None)
        )
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
