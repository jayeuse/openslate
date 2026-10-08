"""New aggregate metrics retain SQL precision, null semantics and typed identity."""

from decimal import Decimal

import pytest
from pydantic import ValidationError
from record_queries.test_analytics_database import add_values, reference
from record_queries.test_database import READER, request_for, setup_rows
from uuid6 import uuid7

from app.systems.sandbox.records.aggregation import aggregate_records
from app.systems.sandbox.records.query_schemas import GroupedAggregateQuery

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("metric", ["min", "max"])
def test_numeric_extrema_keep_exact_values_and_sort_missing_groups_last(query_db, metric):
    module, dimension, rows = setup_rows(
        query_db, "text", ["positive", "positive", "negative", "empty"]
    )
    measure = add_values(
        query_db,
        module,
        rows,
        "Amount",
        "decimal",
        ["1.2345678901234567", "2.0000000000000001", "-3.0000000000000001", None],
    )
    result = aggregate_records(
        query_db,
        GroupedAggregateQuery(
            module_id=module.id,
            definition=request_for(module, dimension).definition,
            dimension=reference(dimension),
            measure=reference(measure),
            aggregation=metric,
        ),
        reader=READER,
    )
    expected = "1.2345678901234567" if metric == "min" else "2.0000000000000001"
    assert [(item.label, item.value, item.record_count) for item in result.items] == [
        ("positive", Decimal(expected), 2),
        ("negative", Decimal("-3.0000000000000001"), 1),
        ("empty", None, 1),
    ]


@pytest.mark.parametrize(
    "kind,values",
    [
        ("text", ["same", "same", "other", None]),
        ("long_text", ["same\nline", "same\nline", "other", None]),
        ("email", ["same@example.test", "same@example.test", "other@example.test", None]),
        ("url", ["https://same.test", "https://same.test", "https://other.test", None]),
        ("number", [1.25, 1.25, 2.5, None]),
        ("int", [1, 1, 2, None]),
        ("decimal", ["1.20", "1.200", "2.00", None]),
        ("boolean", [True, True, False, None]),
        ("date", ["2026-10-01", "2026-10-01", "2026-10-02", None]),
        (
            "datetime",
            ["2026-10-01T00:00:00Z", "2026-10-01T08:00:00+08:00", "2026-10-02T00:00:00Z", None],
        ),
        ("select", ["first", "first", "second", None]),
        (
            "user",
            [
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000002",
                None,
            ],
        ),
    ],
)
def test_distinct_counts_typed_values_and_ignores_nulls(query_db, kind, values):
    module, dimension, rows = setup_rows(query_db, "text", ["group"] * 4)
    measure = add_values(query_db, module, rows, "Measure", kind, values)
    if kind == "select":
        measure.config = {
            "options": [{"id": value, "label": "Same label"} for value in ("first", "second")]
        }
        query_db.flush()
    result = aggregate_records(
        query_db,
        GroupedAggregateQuery(
            module_id=module.id,
            definition=request_for(module, dimension).definition,
            dimension=reference(dimension),
            measure=reference(measure),
            aggregation="distinct",
        ),
        reader=READER,
    )
    assert [(item.value, item.record_count) for item in result.items] == [(2, 4)]


@pytest.mark.parametrize("metric", ["min", "max"])
@pytest.mark.parametrize("kind", ["date", "datetime", "text", "boolean"])
def test_extrema_reject_non_numeric_measures(metric, kind):
    with pytest.raises(ValidationError):
        GroupedAggregateQuery(
            module_id=uuid7(),
            definition={},
            dimension={"field_id": uuid7(), "expected_type": "text"},
            measure={"field_id": uuid7(), "expected_type": kind},
            aggregation=metric,
        )


def test_distinct_requires_a_primitive_measure():
    common = {
        "module_id": uuid7(),
        "definition": {},
        "aggregation": "distinct",
        "dimension": {"field_id": uuid7(), "expected_type": "text"},
    }
    for measure in (None, {"field_id": uuid7(), "expected_type": "relationship"}):
        with pytest.raises(ValidationError):
            GroupedAggregateQuery(**common, measure=measure)
