"""Live source validation for saved Dashboard widget configurations."""

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import User
from app.systems.openview.dashboards.schemas import (
    DashboardAggregateConfig,
    DashboardChartConfig,
    DashboardRecordsConfig,
    DashboardRecordsQuery,
    DashboardWidgetSpec,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.query import validate_definition
from app.systems.sandbox.records.query_schemas import (
    DateSeriesAggregateQuery,
    FieldReference,
    GroupedAggregateSnapshotQuery,
)


def _invalid_dashboard() -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT,
        detail={
            "code": "dashboard_invalid",
            "message": "A Dashboard widget references unavailable or changed fields",
        },
    )


def validate_dashboard_widgets(
    db: Session, user: User, department_id: UUID, widgets: list[DashboardWidgetSpec]
) -> None:
    """Reject stale field references and modules that are inactive or in another department."""
    module_ids = {widget.config.query.module_id for widget in widgets}
    if not module_ids:
        return
    active_module_ids = set(
        db.scalars(
            select(Module.id)
            .where(
                Module.id.in_(module_ids),
                Module.department_id == department_id,
                Module.is_deleted.is_(False),
            )
            .order_by(Module.id)
            .with_for_update()
        ).all()
    )
    if active_module_ids != module_ids:
        raise _invalid_dashboard()

    for widget in widgets:
        config = widget.config
        query: DashboardRecordsQuery | GroupedAggregateSnapshotQuery | DateSeriesAggregateQuery
        if isinstance(config, DashboardRecordsConfig):
            query = config.query
            additional_references: tuple[FieldReference | None, ...] = ()
        elif isinstance(config, DashboardAggregateConfig):
            query = config.query
            additional_references = (query.dimension, query.measure)
        else:
            assert isinstance(config, DashboardChartConfig)
            query = config.query
            if isinstance(query, GroupedAggregateSnapshotQuery):
                additional_references = (query.dimension, query.measure)
            else:
                additional_references = (query.date_field, query.measure)
        references = tuple(
            reference for reference in additional_references if reference is not None
        )
        try:
            fields = validate_definition(
                db,
                query.module_id,
                query.definition,
                extra_references=references,
                reader=user,
            )
        except HTTPException as error:
            if error.status_code == status.HTTP_409_CONFLICT:
                raise _invalid_dashboard() from error
            raise
        field_ids = {
            reference.field_id
            for reference in (
                *query.definition.columns,
                *query.definition.filters,
                *query.definition.sort,
                *query.definition.search_fields,
                *references,
            )
        }
        if any(fields[field_id].is_deleted for field_id in field_ids):
            raise _invalid_dashboard()
