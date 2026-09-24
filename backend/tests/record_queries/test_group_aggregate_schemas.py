from datetime import date

import pytest
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.sandbox.records.query_schemas import (
    DateSeriesAggregateQuery,
    GroupedAggregateQuery,
    GroupedRecordQuery,
)


def reference(kind: str) -> dict[str, object]:
    return {"field_id": uuid7(), "expected_type": kind}


def test_grouped_record_query_has_separate_bounded_group_pagination() -> None:
    payload = GroupedRecordQuery(
        module_id=uuid7(),
        definition={},
        group_by=reference("select"),
        group_limit=100,
        group_offset=100,
    )

    assert payload.limit == 25
    assert payload.group_limit == 100
    assert payload.group_offset == 100

    with pytest.raises(ValidationError):
        GroupedRecordQuery(
            module_id=uuid7(),
            definition={},
            group_by=reference("select"),
            group_limit=101,
        )


def test_group_aggregate_accepts_only_numeric_sum_or_average() -> None:
    common = {
        "module_id": uuid7(),
        "definition": {},
        "dimension": reference("select"),
        "aggregation": "average",
    }
    valid = GroupedAggregateQuery(**common, measure=reference("decimal"))
    assert valid.limit == 12

    with pytest.raises(ValidationError):
        GroupedAggregateQuery(**common, measure=reference("text"))

    with pytest.raises(ValidationError):
        GroupedAggregateQuery(
            module_id=uuid7(),
            definition={},
            dimension=reference("select"),
            aggregation="sum",
        )


def test_date_series_requires_date_axis_and_caps_inclusive_window_at_366_days() -> None:
    common = {
        "module_id": uuid7(),
        "definition": {},
        "date_field": reference("date"),
        "measure": reference("number"),
        "aggregation": "sum",
        "from_date": date(2026, 1, 1),
    }
    valid = DateSeriesAggregateQuery(**common, to_date=date(2027, 1, 1))
    assert valid.to_date == date(2027, 1, 1)

    with pytest.raises(ValidationError):
        DateSeriesAggregateQuery(**common, to_date=date(2027, 1, 2))

    with pytest.raises(ValidationError):
        DateSeriesAggregateQuery(
            **{**common, "date_field": reference("text")},
            to_date=date(2026, 1, 2),
        )
