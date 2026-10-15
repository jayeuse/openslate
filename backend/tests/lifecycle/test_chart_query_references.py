"""Which retained Chart queries block a field purge (``query_references_fields``).

The rows are the stored ``chart.query`` values that ``POST /api/charts`` saved for each
typed reference location (captured from a real create on the disposable stack, with the
generated ids replaced by fixed ones). The HTTP journeys that map a blocking Chart to the
409 purge refusal stay in ``tests/lifecycle_integration/test_chart_lifecycle_api.py``.
"""

import pytest

from app.systems.sandbox.lifecycle.chart_dependencies import query_references_fields

MODULE = "01990000-0000-7000-8000-000000000001"
LABEL = "01990000-0000-7000-8000-0000000000a1"
AMOUNT = "01990000-0000-7000-8000-0000000000a2"
PERSON = "01990000-0000-7000-8000-0000000000a3"
DATE = "01990000-0000-7000-8000-0000000000a4"
UNRELATED = "01990000-0000-7000-8000-0000000000ff"


def _definition(**entries: list[dict[str, object]]) -> dict[str, object]:
    return {
        "columns": [],
        "deleted": "exclude",
        "filters": [],
        "logic": "and",
        "search": None,
        "search_fields": [],
        "sort": [],
        "version": 1,
        **entries,
    }


def _reference(field_id: str, expected_type: str) -> dict[str, object]:
    return {"expected_type": expected_type, "field_id": field_id}


def _grouped(**values: object) -> dict[str, object]:
    return {
        "aggregation": "count",
        "date_field": None,
        "definition": _definition(),
        "dimension": _reference(PERSON, "user"),
        "from_date": None,
        "measure": None,
        "mode": "groups",
        "module_id": MODULE,
        "to_date": None,
        **values,
    }


STORED = [
    pytest.param(_grouped(dimension=_reference(LABEL, "text")), LABEL, id="dimension"),
    pytest.param(
        _grouped(aggregation="sum", measure=_reference(AMOUNT, "number")), AMOUNT, id="measure"
    ),
    pytest.param(
        {
            "aggregation": "count",
            "bucket": "day",
            "date_field": _reference(DATE, "date"),
            "definition": _definition(),
            "from_date": "2026-01-01",
            "measure": None,
            "mode": "date_series",
            "module_id": MODULE,
            "to_date": "2026-01-31",
        },
        DATE,
        id="date_series",
    ),
    pytest.param(
        _grouped(date_field=_reference(DATE, "date"), from_date="2026-01-01", to_date="2026-01-31"),
        DATE,
        id="grouped_date",
    ),
    pytest.param(
        {"definition": _definition(columns=[_reference(LABEL, "text")]), "module_id": MODULE},
        LABEL,
        id="columns",
    ),
    pytest.param(
        {
            "definition": _definition(
                filters=[
                    {**_reference(LABEL, "text"), "operator": "eq", "value": "owned matching value"}
                ]
            ),
            "module_id": MODULE,
        },
        LABEL,
        id="filters",
    ),
    pytest.param(
        {
            "definition": _definition(sort=[{**_reference(LABEL, "text"), "direction": "asc"}]),
            "module_id": MODULE,
        },
        LABEL,
        id="sort",
    ),
    pytest.param(
        {"definition": _definition(search_fields=[_reference(LABEL, "text")]), "module_id": MODULE},
        LABEL,
        id="search_fields",
    ),
]


@pytest.mark.parametrize(("query", "field_id"), STORED)
def test_every_typed_reference_location_blocks_only_its_field(
    query: dict[str, object], field_id: str
) -> None:
    assert query_references_fields(query, {field_id}) is True
    assert query_references_fields(query, {UNRELATED, field_id}) is True
    assert query_references_fields(query, {UNRELATED}) is False
    assert query_references_fields(query, set()) is False


@pytest.mark.parametrize(
    "query",
    [
        pytest.param(None, id="no-query"),
        pytest.param([_reference(LABEL, "text")], id="list-query"),
        pytest.param(LABEL, id="text-query"),
        pytest.param({"definition": [_reference(LABEL, "text")]}, id="definition-not-object"),
        pytest.param(
            {"definition": {"columns": {"field_id": LABEL}}}, id="definition-entries-not-list"
        ),
        pytest.param({"dimension": LABEL}, id="reference-not-object"),
        pytest.param({"measure": {"field_id": None}}, id="reference-without-text-id"),
        pytest.param({"group_by": _reference(LABEL, "text")}, id="unknown-location"),
        pytest.param(
            {"definition": {"group_by": [_reference(LABEL, "text")]}},
            id="unknown-definition-location",
        ),
    ],
)
def test_malformed_or_unknown_locations_never_block(query: object) -> None:
    assert query_references_fields(query, {LABEL}) is False
