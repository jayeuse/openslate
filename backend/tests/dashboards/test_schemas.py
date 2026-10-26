from datetime import date, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.openview.dashboards.schemas import (
    DashboardChartConfig,
    DashboardCreate,
    DashboardListRequest,
    DashboardUpdate,
    DashboardWidgetResponse,
    DashboardWidgetSpec,
)
from app.systems.sandbox.records.query_schemas import (
    DateSeriesAggregateQuery,
    GroupedAggregateSnapshotQuery,
)

DEPARTMENT = uuid7()
PLACED = {"grid_column": 0, "grid_row": 0, "column_span": 2, "row_span": 2}


def _group_widget(*, chart_type: str = "bar") -> dict[str, object]:
    module_id = uuid7()
    dimension_id = uuid7()
    filter_id = uuid7()
    return {
        **PLACED,
        "widget_type": "chart",
        "config": {
            "version": 1,
            "chart_type": chart_type,
            "query": {
                "module_id": str(module_id),
                "definition": {
                    "version": 1,
                    "columns": [],
                    "filters": [
                        {
                            "field_id": str(filter_id),
                            "expected_type": "text",
                            "operator": "contains",
                            "value": "open",
                        }
                    ],
                    "logic": "and",
                    "sort": [],
                    "search_fields": [],
                    "deleted": "exclude",
                    "search": None,
                },
                "mode": "groups",
                "dimension": {
                    "field_id": str(dimension_id),
                    "expected_type": "select",
                },
                "aggregation": "count",
            },
        },
    }


def _date_widget(*, days: int = 366) -> dict[str, object]:
    start = date(2024, 1, 1)
    end = start + timedelta(days=days - 1)
    return {
        **PLACED,
        "widget_type": "chart",
        "config": {
            "version": 1,
            "chart_type": "line",
            "query": {
                "module_id": str(uuid7()),
                "definition": {"version": 1},
                "mode": "date_series",
                "date_field": {"field_id": str(uuid7()), "expected_type": "datetime"},
                "from_date": start.isoformat(),
                "to_date": end.isoformat(),
                "aggregation": "average",
                "measure": {"field_id": str(uuid7()), "expected_type": "decimal"},
            },
        },
    }


def _aggregate_widget(widget_type: str) -> dict[str, object]:
    return {
        **PLACED,
        "widget_type": widget_type,
        "config": {
            "version": 1,
            "query": {
                "module_id": str(uuid7()),
                "definition": {"version": 1},
                "mode": "groups",
                "dimension": {"field_id": str(uuid7()), "expected_type": "text"},
                "aggregation": "count",
            },
        },
    }


def _records_widget() -> dict[str, object]:
    return {
        **PLACED,
        "widget_type": "records",
        "config": {
            "version": 1,
            "query": {
                "module_id": str(uuid7()),
                "definition": {
                    "version": 1,
                    "columns": [
                        {"field_id": str(uuid7()), "expected_type": "text"},
                    ],
                },
            },
        },
    }


def test_chart_widget_uses_typed_snapshot_query_with_uuid_references_and_filters():
    payload = DashboardWidgetSpec.model_validate(_group_widget())

    assert payload.widget_type == "chart"
    assert isinstance(payload.config, DashboardChartConfig)
    assert isinstance(payload.config.query, GroupedAggregateSnapshotQuery)
    assert isinstance(payload.config.query.module_id, UUID)
    assert isinstance(payload.config.query.dimension.field_id, UUID)
    assert payload.config.query.aggregation == "count"
    assert payload.config.query.definition.filters[0].value == "open"


def test_date_series_chart_accepts_explicit_inclusive_366_day_snapshot():
    payload = DashboardWidgetSpec.model_validate(_date_widget())

    assert isinstance(payload.config.query, DateSeriesAggregateQuery)
    assert (payload.config.query.to_date - payload.config.query.from_date).days + 1 == 366
    assert payload.config.query.aggregation == "average"
    assert payload.config.query.measure is not None
    assert payload.config.query.measure.expected_type == "decimal"

    with pytest.raises(ValidationError):
        DashboardWidgetSpec.model_validate(_date_widget(days=367))


@pytest.mark.parametrize(
    ("chart_type", "query"),
    [
        ("bar", _date_widget()["config"]["query"]),
        ("pie", _date_widget()["config"]["query"]),
        ("line", _group_widget()["config"]["query"]),
    ],
)
def test_chart_type_must_match_category_or_date_series_mode(chart_type, query):
    with pytest.raises(ValidationError):
        DashboardChartConfig.model_validate(
            {"version": 1, "chart_type": chart_type, "query": query}
        )


def test_chart_contract_rejects_unbounded_filters_and_non_uuid_references():
    too_many_filters = _group_widget()
    query = too_many_filters["config"]["query"]
    query["definition"]["filters"] = [  # type: ignore[index]
        {
            "field_id": str(uuid7()),
            "expected_type": "text",
            "operator": "contains",
            "value": "open",
        }
        for _ in range(11)
    ]
    with pytest.raises(ValidationError):
        DashboardWidgetSpec.model_validate(too_many_filters)

    invalid_reference = _group_widget()
    invalid_reference["config"]["query"]["dimension"]["field_id"] = "status"  # type: ignore[index]
    with pytest.raises(ValidationError):
        DashboardWidgetSpec.model_validate(invalid_reference)


def test_dashboard_contract_belongs_to_a_department_and_is_bounded_and_revisioned():
    widget = _group_widget()
    dashboard = DashboardCreate.model_validate(
        {"department_id": DEPARTMENT, "name": "Operations", "widgets": [widget]}
    )
    assert dashboard.name == "Operations"
    assert len(dashboard.widgets) == 1
    assert DashboardCreate(department_id=DEPARTMENT, name="Empty").widgets == []

    with pytest.raises(ValidationError):
        DashboardCreate.model_validate({"name": "No department"})
    with pytest.raises(ValidationError):
        DashboardCreate.model_validate(
            {"department_id": DEPARTMENT, "name": "Shared", "audience": {"kind": "everyone"}}
        )
    with pytest.raises(ValidationError):
        DashboardCreate.model_validate(
            {"department_id": DEPARTMENT, "name": "Negative", "position": -1}
        )
    with pytest.raises(ValidationError):
        DashboardWidgetSpec.model_validate({**widget, "widget_type": "text"})
    with pytest.raises(ValidationError):
        DashboardCreate.model_validate(
            {
                "department_id": DEPARTMENT,
                "name": "Unknown widget",
                "widgets": [{"widget_type": "table", "config": {}}],
            }
        )
    with pytest.raises(ValidationError):
        DashboardWidgetSpec.model_validate(
            {
                **widget,
                "config": {**widget["config"], "result_snapshot": {"items": []}},
            }
        )
    with pytest.raises(ValidationError):
        DashboardCreate.model_validate(
            {"department_id": DEPARTMENT, "name": "Too many", "widgets": [widget] * 21}
        )

    assert DashboardUpdate.model_validate({"revision": 2, "widgets": []}).widgets == []
    with pytest.raises(ValidationError):
        DashboardUpdate.model_validate({"revision": 0, "name": "Stale"})
    with pytest.raises(ValidationError):
        DashboardUpdate.model_validate({"revision": 2})


def test_dashboard_supports_all_live_widget_types_and_persisted_refresh_cadence():
    widgets = [
        _aggregate_widget("summary"),
        _aggregate_widget("workload"),
        _records_widget(),
        _group_widget(),
    ]
    dashboard = DashboardCreate.model_validate(
        {
            "department_id": DEPARTMENT,
            "name": "Operations",
            "refresh_cadence": "one-minute",
            "widgets": widgets,
        }
    )

    assert [widget.widget_type for widget in dashboard.widgets] == [
        "summary",
        "workload",
        "records",
        "chart",
    ]
    assert dashboard.refresh_cadence == "one-minute"
    assert DashboardCreate(department_id=DEPARTMENT, name="Manual").refresh_cadence == "manual"
    assert (
        DashboardUpdate.model_validate(
            {"revision": 1, "refresh_cadence": "five-minutes"}
        ).refresh_cadence
        == "five-minutes"
    )

    with pytest.raises(ValidationError):
        DashboardCreate.model_validate(
            {"department_id": DEPARTMENT, "name": "Unknown cadence", "refresh_cadence": "hourly"}
        )


def test_widget_placement_is_required_whole_cells_inside_the_grid_and_replaces_size():
    widget = _aggregate_widget("workload")
    placed = DashboardWidgetSpec.model_validate(
        {**widget, "grid_column": 2, "grid_row": 3, "column_span": 2, "row_span": 2}
    )
    assert (placed.grid_column, placed.grid_row, placed.column_span, placed.row_span) == (
        2,
        3,
        2,
        2,
    )
    assert DashboardWidgetSpec.model_validate(
        {**widget, "grid_column": 3, "grid_row": 4, "column_span": 4, "row_span": 5}
    ).row_span == 5

    for missing in PLACED:
        with pytest.raises(ValidationError):
            DashboardWidgetSpec.model_validate(
                {key: value for key, value in widget.items() if key != missing}
            )
    for field, value in (
        ("grid_column", -1),
        ("grid_column", 4),
        ("grid_row", 5),
        ("column_span", 0),
        ("column_span", 5),
        ("row_span", 0),
        ("row_span", 6),
        ("grid_row", None),
    ):
        with pytest.raises(ValidationError):
            DashboardWidgetSpec.model_validate({**widget, field: value})
    with pytest.raises(ValidationError):
        DashboardWidgetSpec.model_validate({**widget, "size": "M"})

    twenty = DashboardCreate.model_validate(
        {"department_id": DEPARTMENT, "name": "Full grid", "widgets": [widget] * 20}
    )
    assert len(twenty.widgets) == 20


def test_widget_response_placement_is_all_or_nothing_and_home_filter_parses():
    common = {
        "id": uuid7(),
        "position": 19,
        "widget_type": "summary",
        "chart_id": uuid7(),
        "config": None,
        "created_at": "2026-10-26T00:00:00Z",
        "updated_at": "2026-10-26T00:00:00Z",
    }
    unplaced = DashboardWidgetResponse.model_validate(
        {**common, "grid_column": None, "grid_row": None, "column_span": None, "row_span": None}
    )
    assert unplaced.grid_column is None and unplaced.row_span is None
    with pytest.raises(ValidationError):
        DashboardWidgetResponse.model_validate(
            {**common, "grid_column": 0, "grid_row": None, "column_span": 1, "row_span": 1}
        )

    assert DashboardListRequest.model_validate({"home": "true"}).home is True
    assert DashboardListRequest.model_validate({}).home is None
