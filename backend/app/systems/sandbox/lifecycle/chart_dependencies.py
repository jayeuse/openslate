"""Retained Chart inventory and typed query references shared by purge collectors."""

from collections.abc import Callable, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.openview.charts.models import Chart
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)
from app.systems.sandbox.modules.models import Module


def query_references_fields(query: object, field_ids: set[str]) -> bool:
    """Inspect retained metadata without validating away stale or archived queries."""
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


def load_chart_purge_dependencies(
    db: Session,
    module_ids: Sequence[UUID],
    target_field: Field | None,
    modules: Sequence[Module],
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[UUID, Chart]]:
    charts = (
        list(db.scalars(select(Chart).where(Chart.module_id.in_(module_ids)).order_by(Chart.id)))
        if module_ids
        else []
    )
    if target_field is not None:
        charts = [
            chart
            for chart in charts
            if query_references_fields(chart.query, {str(target_field.id)})
        ]
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    modules_by_id = {module.id: module for module in modules}
    for chart in charts:
        state = row_state("charts", chart)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(chart, key)
                for key in ("module_id", "department_id", "revision", "name", "chart_type", "query")
            }
        )
        rows.append(state)
        if target_field is not None:
            module = modules_by_id.get(chart.module_id)
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_CHART_DEPENDENCY,
                    entity_type="charts",
                    entity_id=chart.id,
                    detail=(
                        f"Repair the retained saved Chart {chart.name!r} query before permanently "
                        f"deleting Field {target_field.name!r}; archiving the Chart keeps its query"
                    ),
                    conflicting_entity_type="fields",
                    conflicting_entity_id=target_field.id,
                    field_id=target_field.id,
                    field_name=target_field.name,
                    module_id=chart.module_id,
                    module_name=module.module_name if module is not None else None,
                    department_id=module.department_id
                    if module is not None
                    else chart.department_id,
                )
            )
    return rows, blockers, {chart.id: chart for chart in charts}
