"""Source admission and grid layout for inline and referenced Dashboard widgets.

A widget reads a module of the Dashboard's department, or a module linked to one of them
by a relationship field in either direction (BE2). The saving manager must read it; every
viewer's read stays checked per request, so no result is shared.
"""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, union
from sqlalchemy.orm import Session

from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.users.models import User
from app.systems.openview.charts import service as charts
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.placement import (
    Placement,
    WidgetKind,
    layout_invalid,
    layout_issues,
    widget_kind,
)
from app.systems.openview.dashboards.schemas import DashboardChartConfig, DashboardWidgetSpec
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module


def _invalid_dashboard() -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": "dashboard_invalid",
            "message": "A Dashboard widget references unavailable or changed fields",
        },
        headers=charts.CACHE,
    )


def dashboard_source_module_ids(db: Session, department_id: UUID) -> set[UUID]:
    """The department's active modules and every module a relationship field links to them."""
    own = select(Module.id).where(
        Module.department_id == department_id, Module.is_deleted.is_(False)
    )
    relationship = (Field.type == FieldType.RELATIONSHIP, Field.is_deleted.is_(False))
    targets = select(Field.relationship_target_module_id).where(
        *relationship, Field.module_id.in_(own)
    )
    sources = select(Field.module_id).where(
        *relationship, Field.relationship_target_module_id.in_(own)
    )
    # A relationship field always names its target module (ck_fields_relationship_metadata).
    linked: set[UUID] = set(db.scalars(union(own, targets, sources)))
    return linked


def _kind(widget: DashboardWidgetSpec, references: dict[UUID, Chart]) -> WidgetKind:
    if widget.chart_id is not None:
        return widget_kind(widget.widget_type, references[widget.chart_id].chart_type)
    config = widget.config
    chart_type = config.chart_type if isinstance(config, DashboardChartConfig) else None
    return widget_kind(widget.widget_type, chart_type)


def validate_dashboard_widgets(
    db: Session, identity: CurrentIdentity, department_id: UUID, widgets: list[DashboardWidgetSpec]
) -> User:
    """Lock sources before the consumer; Chart attachment needs only current READ."""
    inline_ids = {widget.config.query.module_id for widget in widgets if widget.config is not None}
    chart_ids = {widget.chart_id for widget in widgets if widget.chart_id is not None}
    try:
        modules, references, actor = charts.lock_widget_sources(db, identity, inline_ids, chart_ids)
        if modules and not modules.keys() <= dashboard_source_module_ids(db, department_id):
            raise _invalid_dashboard()
        for widget in widgets:
            if widget.chart_id is not None:
                chart = references[widget.chart_id]
                category = (
                    chart.chart_type
                    if chart.chart_type in {"summary", "workload", "records"}
                    else "chart"
                )
                if widget.widget_type != category:
                    raise _invalid_dashboard()
            else:
                config = widget.config
                assert config is not None
                kind = (
                    config.chart_type
                    if isinstance(config, DashboardChartConfig)
                    else widget.widget_type
                )
                charts.validate_query(db, actor, config.query.module_id, kind, config.query)
    except HTTPException as error:
        if error.status_code == 409:
            raise _invalid_dashboard() from error
        raise
    issues = layout_issues(
        [
            (
                _kind(widget, references),
                Placement(widget.grid_column, widget.grid_row, widget.column_span, widget.row_span),
            )
            for widget in widgets
        ]
    )
    if issues:
        raise layout_invalid(issues)
    return actor
