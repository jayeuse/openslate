"""PostgreSQL regressions for bounded grouped and aggregate record queries."""

from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core.config import get_settings
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.schemas import WorkspaceUpdate
from app.systems.sandbox.fields.validation import validate_field_value
from app.systems.sandbox.records.aggregation import aggregate_records, aggregate_snapshot_records
from app.systems.sandbox.records.grouping import query_grouped_records
from app.systems.sandbox.records.query_schemas import (
    DateSeriesAggregateQuery,
    GroupedAggregateQuery,
    GroupedAggregateSnapshotQuery,
    GroupedRecordQuery,
)
from tests.rbac.support import organization
from tests.record_queries.support import (
    READER,
    add_values,
    option_id,
    reference,
    request_for,
    route_actor,
    route_client,
    setup_rows,
)

pytestmark = pytest.mark.integration


def test_grouped_query_paginates_only_selected_group_members(query_db) -> None:
    module, field, rows = setup_rows(query_db, "select", ["A", "A", "B", None, ..., "Empty"])
    order_field = add_values(
        query_db, module, rows, "Order", "text", ["b", "a", "c", "z", "b", "d"]
    )
    definition = {"columns": [], "sort": [{**reference(order_field), "direction": "asc"}]}
    base = {
        "module_id": module.id,
        "definition": definition,
        "group_by": reference(field),
        "group_limit": 2,
        "group_offset": 2,
    }

    headers = query_grouped_records(query_db, GroupedRecordQuery(**base), reader=READER)
    assert [(group.value, group.label, group.count) for group in headers.groups] == [
        (option_id("B"), "B", 1),
        (None, "Unspecified", 2),
    ]
    assert headers.items == []
    assert headers.pagination is None
    assert headers.group_pagination.total == 4
    assert headers.group_pagination.has_more is False

    selected = query_grouped_records(
        query_db,
        GroupedRecordQuery(
            **base,
            limit=1,
            selected_group={"kind": "value", "value": option_id("B")},
        ),
        reader=READER,
    )
    assert [item.id for item in selected.items] == [rows[2].id]
    assert selected.items[0].data == {}
    assert selected.selected_group is not None
    assert selected.selected_group.kind == "value"
    assert selected.selected_group.value == option_id("B")
    assert selected.pagination is not None
    assert selected.pagination.total == 1

    unspecified = query_grouped_records(
        query_db,
        GroupedRecordQuery(**base, selected_group={"kind": "unspecified"}),
        reader=READER,
    )
    assert [item.id for item in unspecified.items] == [rows[4].id, rows[3].id]
    assert all(item.data == {} for item in unspecified.items)
    assert unspecified.selected_group is not None
    assert unspecified.selected_group.kind == "unspecified"
    assert unspecified.pagination is not None
    assert unspecified.pagination.total == 2

    second_member_page = query_grouped_records(
        query_db,
        GroupedRecordQuery(
            **base,
            limit=1,
            offset=1,
            selected_group={"kind": "unspecified"},
        ),
        reader=READER,
    )
    assert [item.id for item in second_member_page.items] == [rows[3].id]
    assert second_member_page.pagination is not None
    assert second_member_page.pagination.offset == 1
    assert second_member_page.pagination.total == 2

    empty_choice = query_grouped_records(
        query_db,
        GroupedRecordQuery(**base, selected_group={"kind": "value", "value": option_id("Empty")}),
        reader=READER,
    )
    assert [item.id for item in empty_choice.items] == [rows[5].id]
    assert empty_choice.selected_group is not None
    assert empty_choice.selected_group.kind == "value"
    assert empty_choice.selected_group.value == option_id("Empty")


def test_grouped_query_rejects_deleted_or_type_changed_group_field(query_db) -> None:
    module, field, _ = setup_rows(query_db, "select", ["Open"])
    payload = GroupedRecordQuery(
        module_id=module.id,
        definition=request_for(module, field).definition,
        group_by=reference(field),
    )
    field.type = "text"
    query_db.flush()

    with pytest.raises(HTTPException) as error:
        query_grouped_records(query_db, payload, reader=READER)

    assert error.value.status_code == 409
    assert error.value.detail["code"] == "view_invalid"


def test_long_text_group_header_can_round_trip_to_members(query_db) -> None:
    value = "long group " * 500
    module, field, rows = setup_rows(query_db, "long_text", [value])
    assert validate_field_value(field, value) == value
    payload = GroupedRecordQuery(
        module_id=module.id,
        definition={"columns": []},
        group_by=reference(field),
        selected_group={"kind": "value", "value": value},
    )
    assert len(payload.model_dump_json().encode("utf-8")) < get_settings().request_body_max_bytes

    result = query_grouped_records(query_db, payload, reader=READER)

    assert [(group.value, group.count) for group in result.groups] == [(value, 1)]
    assert [item.id for item in result.items] == [rows[0].id]
    assert result.selected_group is not None
    assert result.selected_group.kind == "value"
    assert result.selected_group.value == value


def test_group_header_over_request_limit_fails_instead_of_becoming_unselectable(query_db) -> None:
    value = "x" * (get_settings().request_body_max_bytes + 128)
    module, field, _ = setup_rows(query_db, "long_text", [value])
    assert validate_field_value(field, value) == value
    payload = GroupedRecordQuery(
        module_id=module.id,
        definition={"columns": []},
        group_by=reference(field),
    )

    with pytest.raises(HTTPException) as error:
        query_grouped_records(query_db, payload, reader=READER)

    assert error.value.status_code == 422
    assert error.value.detail["code"] == "group_value_not_selectable"


def test_grouped_aggregate_sums_and_averages_rank_buckets_server_side(query_db) -> None:
    module, dimension, rows = setup_rows(query_db, "select", ["Open", "Open", "Done", None, ""])
    measure = add_values(
        query_db,
        module,
        rows,
        "Amount",
        "decimal",
        ["2.50", "7.50", None, "10.25", "9.00"],
    )
    definition = request_for(module, dimension).definition
    base = {
        "module_id": module.id,
        "definition": definition,
        "dimension": reference(dimension),
        "measure": reference(measure),
    }

    summed = aggregate_records(
        query_db,
        GroupedAggregateQuery(**base, aggregation="sum", limit=3),
        reader=READER,
    )
    assert [(item.label, item.value, item.record_count) for item in summed.items] == [
        ("Unspecified", Decimal("10.25"), 1),
        ("Open", Decimal("10.00"), 2),
        ("", Decimal("9.00"), 1),
    ]
    assert summed.pagination.total == 4 and summed.pagination.has_more

    averaged = aggregate_records(
        query_db,
        GroupedAggregateQuery(**base, aggregation="average", limit=10),
        reader=READER,
    )
    values = {item.label: item.value for item in averaged.items}
    assert values["Open"] == Decimal("5.00")
    assert values["Done"] == 0


def test_date_series_includes_empty_days_and_uses_utc_for_datetime(query_db) -> None:
    module, date_field, rows = setup_rows(
        query_db,
        "date",
        ["2026-09-01", "2026-09-01", "2026-09-03", None],
    )
    measure = add_values(
        query_db,
        module,
        rows,
        "Amount",
        "decimal",
        ["1.25", "2.25", "8.50", "5.00"],
    )
    query_db.connection().exec_driver_sql("SET LOCAL TIME ZONE 'Asia/Manila'")
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition=request_for(module, date_field).definition,
        date_field=reference(date_field),
        measure=reference(measure),
        aggregation="sum",
        from_date=date(2026, 9, 1),
        to_date=date(2026, 9, 4),
    )

    result = aggregate_records(query_db, payload, reader=READER)

    assert [item.label for item in result.items] == [
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
    ]
    assert [item.value for item in result.items] == [
        Decimal("3.50"),
        Decimal(0),
        Decimal("8.50"),
        Decimal(0),
    ]
    assert [item.record_count for item in result.items] == [2, 0, 1, 0]
    assert result.pagination.has_more is False

    datetime_module, datetime_field, datetime_rows = setup_rows(
        query_db,
        "datetime",
        ["2026-09-01T23:30:00-02:00", "2026-09-02T00:30:00+03:00"],
    )
    datetime_measure = add_values(
        query_db,
        datetime_module,
        datetime_rows,
        "Amount",
        "number",
        [1, 2],
    )
    datetime_payload = DateSeriesAggregateQuery(
        module_id=datetime_module.id,
        definition=request_for(datetime_module, datetime_field).definition,
        date_field=reference(datetime_field),
        measure=reference(datetime_measure),
        aggregation="sum",
        from_date=date(2026, 9, 1),
        to_date=date(2026, 9, 3),
    )
    datetime_result = aggregate_records(query_db, datetime_payload, reader=READER)
    assert [item.value for item in datetime_result.items] == [
        Decimal("2.0000000000"),
        Decimal("1.0000000000"),
        Decimal(0),
    ]


def test_datetime_series_buckets_by_validated_workspace_timezone(query_db) -> None:
    profile = query_db.scalar(
        select(WorkspaceProfile).where(WorkspaceProfile.id == organization(query_db).id)
    )
    assert profile is not None
    update = WorkspaceUpdate(revision=profile.revision, timezone="Asia/Manila")
    assert update.timezone == "Asia/Manila"
    profile.timezone = update.timezone
    query_db.flush()

    module, date_field, rows = setup_rows(
        query_db,
        "datetime",
        ["2026-09-01T15:30:00Z", "2026-09-01T16:30:00Z"],
    )
    measure = add_values(query_db, module, rows, "Amount", "number", [1, 2])
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition=request_for(module, date_field).definition,
        date_field=reference(date_field),
        measure=reference(measure),
        aggregation="sum",
        from_date=date(2026, 9, 1),
        to_date=date(2026, 9, 2),
    )

    result = aggregate_records(query_db, payload, reader=READER)

    assert [item.label for item in result.items] == ["2026-09-01", "2026-09-02"]
    assert [item.value for item in result.items] == [Decimal("1"), Decimal("2")]


def test_grouped_snapshot_combines_or_filters_with_an_independent_date_window(query_db) -> None:
    module, dimension, rows = setup_rows(query_db, "select", ["Open", "Open", "Closed", "Closed"])
    date_field = add_values(
        query_db,
        module,
        rows,
        "Occurred on",
        "date",
        ["2026-09-01", "2026-09-05", "2026-09-03", "2026-09-08"],
    )
    payload = GroupedAggregateSnapshotQuery(
        module_id=module.id,
        definition={
            "version": 1,
            "logic": "or",
            "columns": [],
            "filters": [
                {
                    **reference(dimension),
                    "operator": "eq",
                    "value": option_id("Open"),
                },
                {
                    **reference(dimension),
                    "operator": "eq",
                    "value": option_id("Closed"),
                },
            ],
        },
        dimension=reference(dimension),
        date_field=reference(date_field),
        from_date=date(2026, 9, 1),
        to_date=date(2026, 9, 5),
        aggregation="count",
    )

    result = aggregate_snapshot_records(query_db, payload, reader=READER)

    assert {item.label: item.record_count for item in result.items} == {
        "Open": 2,
        "Closed": 1,
    }


def test_grouped_snapshot_date_window_uses_workspace_day_bounds_for_datetime(query_db) -> None:
    profile = query_db.scalar(
        select(WorkspaceProfile).where(WorkspaceProfile.id == organization(query_db).id)
    )
    assert profile is not None
    profile.timezone = "Asia/Manila"
    query_db.flush()
    module, dimension, rows = setup_rows(
        query_db, "select", ["Before", "Included", "Included", "After"]
    )
    date_field = add_values(
        query_db,
        module,
        rows,
        "Occurred at",
        "datetime",
        [
            "2026-08-31T15:59:59Z",
            "2026-08-31T16:00:00Z",
            "2026-09-01T15:59:59Z",
            "2026-09-01T16:00:00Z",
        ],
    )
    payload = GroupedAggregateSnapshotQuery(
        module_id=module.id,
        definition={"columns": []},
        dimension=reference(dimension),
        date_field=reference(date_field),
        from_date=date(2026, 9, 1),
        to_date=date(2026, 9, 1),
        aggregation="count",
    )

    result = aggregate_snapshot_records(query_db, payload, reader=READER)

    assert [(item.label, item.record_count) for item in result.items] == [("Included", 2)]


@pytest.mark.parametrize("day_count", [101, 366])
def test_date_series_route_returns_the_complete_bounded_window(query_db, day_count: int) -> None:
    module, date_field, _ = setup_rows(query_db, "date", [])
    from_date = date(2026, 1, 1)
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition=request_for(module, date_field).definition,
        date_field=reference(date_field),
        from_date=from_date,
        to_date=from_date + timedelta(days=day_count - 1),
    )
    actor = route_actor(query_db)
    with route_client(query_db, actor, raise_server_exceptions=False) as client:
        response = client.post("/api/records/aggregate-query", json=payload.model_dump(mode="json"))

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["items"]) == day_count
    assert body["items"][0]["label"] == from_date.isoformat()
    assert body["items"][-1]["label"] == (from_date + timedelta(days=day_count - 1)).isoformat()
    assert body["pagination"] == {
        "limit": day_count,
        "offset": 0,
        "count": day_count,
        "total": day_count,
        "has_more": False,
    }
