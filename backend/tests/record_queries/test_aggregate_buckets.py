"""Calendar series through PostgreSQL: exact anchors, bounded windows and gaps."""

from datetime import date
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.records.aggregation import aggregate_records
from app.systems.sandbox.records.query_schemas import DateSeriesAggregateQuery
from tests.rbac.support import organization
from tests.record_queries.support import READER, add_values, reference, request_for, setup_rows

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "bucket,week_start,from_date,to_date,expected",
    [
        ("week", "monday", "2026-10-07", "2026-10-13", ["2026-10-05", "2026-10-12"]),
        ("week", "sunday", "2026-10-07", "2026-10-13", ["2026-10-04", "2026-10-11"]),
        ("month", "monday", "2026-12-15", "2027-01-10", ["2026-12-01", "2027-01-01"]),
        (
            "quarter",
            "monday",
            "2026-09-30",
            "2027-01-01",
            ["2026-07-01", "2026-10-01", "2027-01-01"],
        ),
        ("year", "monday", "2026-12-31", "2027-01-01", ["2026-01-01", "2027-01-01"]),
    ],
)
def test_series_uses_calendar_starts_and_preserves_partial_record_window(
    query_db, bucket, week_start, from_date, to_date, expected
):
    profile = query_db.scalar(select(WorkspaceProfile).where(
        WorkspaceProfile.id == organization(query_db).id
    ))
    profile.week_start = week_start
    module, field, _ = setup_rows(query_db, "date", [from_date, to_date, "2020-01-01"])
    result = aggregate_records(
        query_db,
        DateSeriesAggregateQuery(
            module_id=module.id,
            definition=request_for(module, field).definition,
            date_field=reference(field),
            from_date=from_date,
            to_date=to_date,
            bucket=bucket,
        ),
        reader=READER,
    )
    assert [item.key for item in result.items] == expected
    assert sum(item.record_count for item in result.items) == 2
    assert result.pagination.count == result.pagination.total == len(expected)


@pytest.mark.parametrize("metric", ["average", "min", "max", "sum", "distinct", "count"])
def test_empty_bucket_value_is_distinct_from_occupied_null_measure(query_db, metric):
    module, field, rows = setup_rows(query_db, "date", ["2026-10-01", "2026-10-03"])
    measure = add_values(query_db, module, rows, "Amount", "decimal", ["5.00", None])
    result = aggregate_records(
        query_db,
        DateSeriesAggregateQuery(
            module_id=module.id,
            definition=request_for(module, field).definition,
            date_field=reference(field),
            from_date="2026-10-01",
            to_date="2026-10-03",
            aggregation=metric,
            **({"measure": reference(measure)} if metric != "count" else {}),
        ),
        reader=READER,
    )
    assert [item.record_count for item in result.items] == [1, 0, 1]
    assert result.items[1].value == (None if metric in {"average", "min", "max"} else 0)
    assert result.items[2].value == (
        None if metric in {"min", "max"} else 1 if metric == "count" else 0
    )
    if metric in {"average", "min", "max", "sum"}:
        assert result.items[0].value == Decimal("5.00")


def test_weekly_cap_uses_the_actual_workspace_anchor(query_db):
    module, field, _ = setup_rows(query_db, "date", [])
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition={},
        date_field=reference(field),
        bucket="week",
        from_date="2026-01-05",
        to_date="2033-01-09",
    )
    profile = query_db.scalar(select(WorkspaceProfile).where(
        WorkspaceProfile.id == organization(query_db).id
    ))
    profile.week_start = "monday"
    result = aggregate_records(query_db, payload, reader=READER)
    assert len(result.items) == 366
    profile.week_start = "sunday"
    with pytest.raises(HTTPException) as caught:
        aggregate_records(query_db, payload, reader=READER)
    assert caught.value.status_code == 422


@pytest.mark.parametrize("bucket", ["day", "week", "month", "quarter", "year"])
def test_series_max_date_never_constructs_the_next_year(query_db, bucket):
    module, field, _ = setup_rows(query_db, "date", ["9999-12-31"])
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition={},
        date_field=reference(field),
        bucket=bucket,
        from_date=date.max,
        to_date=date.max,
    )
    result = aggregate_records(query_db, payload, reader=READER)
    assert len(result.items) == 1 and result.items[0].record_count == 1


def test_unrepresentable_sunday_week_at_date_min_is_a_safe_422(query_db):
    profile = query_db.scalar(select(WorkspaceProfile).where(
        WorkspaceProfile.id == organization(query_db).id
    ))
    profile.week_start = "sunday"
    module, field, _ = setup_rows(query_db, "date", [])
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition={},
        date_field=reference(field),
        bucket="week",
        from_date=date.min,
        to_date=date.min,
    )
    with pytest.raises(HTTPException) as caught:
        aggregate_records(query_db, payload, reader=READER)
    assert caught.value.status_code == 422
    assert caught.value.detail["code"] == "aggregate_date_range_invalid"


@pytest.mark.parametrize(
    "bucket,from_date,to_date",
    [("month", "2020-01-31", "2050-06-01"), ("year", "2000-03-01", "2365-12-31")],
)
def test_longer_date_ranges_are_legal_when_they_have_366_buckets(
    query_db, bucket, from_date, to_date
):
    module, field, _ = setup_rows(query_db, "date", [])
    payload = DateSeriesAggregateQuery(
        module_id=module.id,
        definition={},
        date_field=reference(field),
        bucket=bucket,
        from_date=from_date,
        to_date=to_date,
    )
    assert len(aggregate_records(query_db, payload, reader=READER).items) == 366


def test_month_bucket_uses_workspace_date_not_session_timezone(query_db):
    query_db.get(WorkspaceProfile, organization(query_db).id).timezone = "Asia/Manila"
    query_db.connection().exec_driver_sql("SET LOCAL TIME ZONE 'America/New_York'")
    module, field, _ = setup_rows(
        query_db, "datetime", ["2026-05-31T15:59:59Z", "2026-05-31T16:00:00Z"]
    )
    result = aggregate_records(
        query_db,
        DateSeriesAggregateQuery(
            module_id=module.id,
            definition={},
            date_field=reference(field),
            bucket="month",
            from_date="2026-05-01",
            to_date="2026-06-30",
        ),
        reader=READER,
    )
    assert [(item.key, item.record_count) for item in result.items] == [
        ("2026-05-01", 1),
        ("2026-06-01", 1),
    ]


@pytest.mark.parametrize(
    "start,end,instants,counts",
    [
        (
            "2026-03-08",
            "2026-03-09",
            [
                "2026-03-08T06:59:59Z",
                "2026-03-08T07:00:00Z",
                "2026-03-09T03:59:59Z",
                "2026-03-09T04:00:00Z",
            ],
            [3, 1],
        ),
        ("2026-11-01", "2026-11-02", ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"], [2, 0]),
    ],
)
def test_dst_transitions_stay_in_their_workspace_calendar_day(
    query_db, start, end, instants, counts
):
    query_db.get(WorkspaceProfile, organization(query_db).id).timezone = "America/New_York"
    module, field, _ = setup_rows(query_db, "datetime", instants)
    result = aggregate_records(
        query_db,
        DateSeriesAggregateQuery(
            module_id=module.id,
            definition={},
            date_field=reference(field),
            bucket="day",
            from_date=start,
            to_date=end,
        ),
        reader=READER,
    )
    assert [item.record_count for item in result.items] == counts
