"""Owner-private, bounded metadata listing for retained Report runs."""

from datetime import datetime
from uuid import UUID

import pytest
from sqlalchemy import event
from uuid6 import uuid7

from tests.reports.test_report_run_routes import _RunFixture

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.reports.test_report_run_routes",)


def test_report_run_list_is_newest_first_paginated_metadata_only(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    created = [
        fixture.client.post(path, headers=fixture.headers(key=uuid7())).json() for _ in range(3)
    ]
    expected = sorted(
        created,
        key=lambda run: (datetime.fromisoformat(run["created_at"]), UUID(run["id"])),
        reverse=True,
    )

    first = fixture.client.get(f"{path}?limit=2&offset=0", headers=fixture.headers())
    second = fixture.client.get(f"{path}?limit=2&offset=2", headers=fixture.headers())

    assert first.status_code == second.status_code == 200
    assert first.headers["cache-control"] == "private, no-store"
    assert [item["id"] for item in first.json()["items"]] == [run["id"] for run in expected[:2]]
    assert [item["id"] for item in second.json()["items"]] == [expected[2]["id"]]
    assert first.json()["pagination"] == {
        "limit": 2,
        "offset": 0,
        "count": 2,
        "total": 3,
        "has_more": True,
    }
    assert second.json()["pagination"] == {
        "limit": 2,
        "offset": 2,
        "count": 1,
        "total": 3,
        "has_more": False,
    }
    assert set(first.json()["items"][0]) == {
        "id",
        "report_id",
        "recipe_revision",
        "row_count",
        "headings",
        "created_at",
    }


def test_report_run_list_does_not_select_saved_recipe(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    statements: list[str] = []

    def record_report_select(
        connection: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        if "FROM reports" in statement:
            statements.append(statement)

    event.listen(fixture.runtime_engine, "before_cursor_execute", record_report_select)
    try:
        response = fixture.client.get(
            f"/api/reports/{fixture.report_id}/runs", headers=fixture.headers()
        )
    finally:
        event.remove(fixture.runtime_engine, "before_cursor_execute", record_report_select)

    assert response.status_code == 200
    assert statements
    assert all("recipe" not in statement.lower() for statement in statements)


def test_report_run_list_shows_runs_to_module_readers_and_respects_archive_state(
    report_run_fixture: _RunFixture,
) -> None:
    fixture = report_run_fixture
    path = f"/api/reports/{fixture.report_id}/runs"
    created = fixture.client.post(path, headers=fixture.headers(key=uuid7()))
    assert created.status_code == 201
    # Every module reader at run time, a guest included, reads the run list.
    for token in (fixture.outsider_token, fixture.guest_token):
        listed = fixture.client.get(path, headers=fixture.headers(token))
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["items"]] == [created.json()["id"]]
    assert fixture.client.get(path).status_code == 401
    archived = fixture.client.delete(
        f"/api/reports/{fixture.report_id}?revision=1", headers=fixture.headers()
    )
    assert archived.status_code == 204
    denied = fixture.client.get(path, headers=fixture.headers())
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "report_archived"


@pytest.mark.parametrize("query", ["limit=101", "sort_order=asc"])
def test_report_run_list_rejects_unbounded_or_ascending_pages(
    report_run_fixture: _RunFixture, query: str
) -> None:
    path = f"/api/reports/{report_run_fixture.report_id}/runs"
    response = report_run_fixture.client.get(
        f"{path}?{query}", headers=report_run_fixture.headers()
    )
    assert response.status_code == 422
