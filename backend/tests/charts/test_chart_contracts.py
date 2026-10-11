"""Saved Chart request rules and the authentication gate, without PostgreSQL.

``test_sources.py`` keeps one HTTP case for the 422 response and the unsaved Chart.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.openview.charts.schemas import ChartCreate
from tests.route_app_support import route_app


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/charts"),
        ("POST", "/api/charts"),
        ("GET", "/api/charts/11111111-1111-4111-8111-111111111111"),
        ("PATCH", "/api/charts/11111111-1111-4111-8111-111111111111"),
        ("DELETE", "/api/charts/11111111-1111-4111-8111-111111111111?revision=1"),
        ("POST", "/api/charts/11111111-1111-4111-8111-111111111111/restore"),
        ("GET", "/api/charts/11111111-1111-4111-8111-111111111111/usage"),
    ],
)
def test_chart_list_is_mounted_and_requires_authentication(method, path):
    with TestClient(route_app()) as client:
        assert (
            client.request(
                method, path, json={} if method in {"POST", "PATCH"} else None
            ).status_code
            == 401
        )


def _body() -> dict[str, Any]:
    module_id = str(uuid7())
    return {
        "module_id": module_id,
        "name": "Reviewed Chart",
        "chart_type": "bar",
        "query": {
            "module_id": module_id,
            "definition": {"version": 1, "columns": [], "filters": []},
            "mode": "groups",
            "dimension": {"field_id": str(uuid7()), "expected_type": "text"},
            "aggregation": "count",
        },
    }


def test_a_grouped_bar_chart_for_its_own_module_is_accepted() -> None:
    body = _body()

    chart = ChartCreate.model_validate(body)

    assert str(chart.module_id) == body["module_id"]
    assert chart.chart_type == "bar" and chart.name == "Reviewed Chart"


@pytest.mark.parametrize(
    "defect", ["family", "module", "measure", "relationship", "extra-owner", "limit"]
)
def test_invalid_chart_definitions_are_refused(defect: str) -> None:
    body = _body()
    if defect == "family":
        body["chart_type"] = "line"
    elif defect == "module":
        body["query"]["module_id"] = str(uuid7())
    elif defect == "measure":
        body["query"].update(
            {
                "aggregation": "min",
                "measure": {"field_id": str(uuid7()), "expected_type": "date"},
            }
        )
    elif defect == "relationship":
        body["query"]["dimension"]["expected_type"] = "relationship"
    elif defect == "extra-owner":
        body["department_id"] = str(uuid7())
    else:
        body["name"] = "N" * 121

    with pytest.raises(ValidationError):
        ChartCreate.model_validate(body)
