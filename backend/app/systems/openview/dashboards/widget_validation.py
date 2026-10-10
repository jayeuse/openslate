"""Current source admission for inline and referenced Dashboard widget queries."""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.users.models import User
from app.systems.openview.charts import service as charts
from app.systems.openview.dashboards.schemas import DashboardChartConfig, DashboardWidgetSpec


def _invalid_dashboard() -> HTTPException:
    return HTTPException(
        409,
        detail={
            "code": "dashboard_invalid",
            "message": "A Dashboard widget references unavailable or changed fields",
        },
        headers=charts.CACHE,
    )


def validate_dashboard_widgets(
    db: Session, identity: CurrentIdentity, department_id: UUID, widgets: list[DashboardWidgetSpec]
) -> User:
    """Lock sources before the consumer; Chart attachment needs only current READ."""
    inline_ids = {widget.config.query.module_id for widget in widgets if widget.config is not None}
    chart_ids = {widget.chart_id for widget in widgets if widget.chart_id is not None}
    try:
        modules, references, actor = charts.lock_widget_sources(db, identity, inline_ids, chart_ids)
        if any(module.department_id != department_id for module in modules.values()):
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
    return actor
