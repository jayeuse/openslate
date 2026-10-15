"""Jobs list query validation, before the handler opens the database (no stack).

``JobsListRequest`` is validated by FastAPI before ``list_jobs`` runs, so these rows need
no PostgreSQL: the session is a mock that must stay untouched. The unknown ``kind`` and
``state`` rows and ``deleted=include`` pass query validation and are refused inside the
handler after the fresh-administrator check, so they stay HTTP rows in
``test_job_routes.py`` with a real administrator.
"""

from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session

from tests.jobs.job_route_support import NOW
from tests.rbac.support import _client, make_user
from tests.route_app_support import route_app


@pytest.mark.parametrize(
    ("params", "location", "error"),
    [
        ({"sort_by": "unsafe"}, ["query", "sort_by"], "enum"),
        (
            {"scheduled_after": "2027-01-01T00:00:00"},
            ["query", "scheduled_after"],
            "timezone_aware",
        ),
        (
            {"scheduled_after": NOW.isoformat(), "scheduled_before": NOW.isoformat()},
            ["query"],
            "value_error",
        ),
        ({"limit": 101}, ["query", "limit"], "less_than_equal"),
    ],
)
def test_jobs_query_validation_refuses_before_the_handler(
    params: dict[str, object], location: list[str], error: str
) -> None:
    database = Mock(spec=Session)
    with _client(route_app(), make_user("jobs-admin"), database) as client:
        response = client.get("/api/jobs", params=params)
    assert response.status_code == 422
    assert [(item["loc"], item["type"]) for item in response.json()["detail"]] == [
        (location, error)
    ]
    assert database.mock_calls == []
