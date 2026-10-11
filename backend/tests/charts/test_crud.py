"""Saved Chart HTTP journeys against the guarded PostgreSQL application schema."""

from uuid import UUID

import pytest
from sqlalchemy import func, select

from app.systems.manage.audit.snapshots import REDACTED
from app.systems.openview.charts.models import Chart
from tests.charts.chart_route_support import chart_world as chart_world

pytestmark = pytest.mark.integration


def test_department_manager_creates_reads_pages_edits_archives_and_restores(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body("  Shared summary  "))
        assert created.status_code == 201
        resource = created.json()
        identifier = resource["id"]
        assert created.headers["location"] == f"/api/charts/{identifier}"
        assert created.headers["cache-control"] == "private, no-store"
        assert resource["name"] == "Shared summary"
        assert resource["department_id"] == str(world.module.department_id)
        assert resource["module_id"] == str(world.module.id)
        assert resource["revision"] == 1 and resource["is_deleted"] is False
        assert "results" not in resource and "owner_id" not in resource
        listed = client.get("/api/charts", params={"module_id": str(world.module.id), "limit": 1})
        assert listed.status_code == 200
        assert [row["id"] for row in listed.json()["items"]] == [identifier]
        assert listed.json()["pagination"]["total"] == 1
        assert client.get(f"/api/charts/{identifier}").json() == resource
        before_audit = len(world.audit_rows(UUID(identifier)))
        noop = client.patch(
            f"/api/charts/{identifier}", json={"revision": 1, "name": "Shared summary"}
        )
        assert noop.status_code == 200 and noop.json()["revision"] == 1
        assert noop.json()["updated_at"] == resource["updated_at"]
        assert len(world.audit_rows(UUID(identifier))) == before_audit
        changed = client.patch(f"/api/charts/{identifier}", json={"revision": 1, "name": "Changed"})
        assert changed.status_code == 200 and changed.json()["revision"] == 2
        stale = client.patch(
            f"/api/charts/{identifier}", json={"revision": 1, "name": "Lost update"}
        )
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"
        archived = client.delete(f"/api/charts/{identifier}", params={"revision": 2})
        assert archived.status_code == 204 and archived.content == b""
        assert (
            client.get("/api/charts", params={"module_id": str(world.module.id)}).json()["items"]
            == []
        )
        saved = client.get(f"/api/charts/{identifier}").json()
        assert saved["is_deleted"] is True and saved["revision"] == 3
        assert (
            client.patch(
                f"/api/charts/{identifier}", json={"revision": 3, "name": "Archived edit"}
            ).status_code
            == 409
        )
        restored = client.post(f"/api/charts/{identifier}/restore", json={"revision": 3})
        assert restored.status_code == 200 and restored.json()["revision"] == 4
        assert restored.json()["is_deleted"] is False
        assert (
            client.post(f"/api/charts/{identifier}/restore", json={"revision": 4}).status_code
            == 409
        )
    audits = world.audit_rows(UUID(identifier))
    assert len(audits) == 4
    assert all(row.performed_by == world.users["manager"].id for row in audits)
    assert audits[0].after["query"] == REDACTED
    assert all(
        snapshot.get("query", REDACTED) == REDACTED
        for row in audits
        for snapshot in (row.before or {}, row.after or {})
    )


@pytest.mark.parametrize("actor", ["reader", "module_manager", "guest"])
def test_module_read_allows_metadata_but_not_department_mutations(chart_world, actor):
    world = chart_world
    with world.client("manager") as writer:
        resource = writer.post("/api/charts", json=world.body()).json()
    with world.client(actor) as client:
        identifier = resource["id"]
        assert client.get(f"/api/charts/{identifier}").status_code == 200
        assert client.get("/api/charts").json()["pagination"]["total"] == 1
        assert client.post("/api/charts", json=world.body()).status_code == 403
        assert (
            client.patch(
                f"/api/charts/{identifier}", json={"revision": 1, "name": "Forbidden"}
            ).status_code
            == 403
        )
        assert client.delete(f"/api/charts/{identifier}", params={"revision": 1}).status_code == 403
    world.db.expire_all()
    assert world.db.scalar(select(func.count()).select_from(Chart)) == 1
    assert world.db.get(Chart, UUID(resource["id"])).revision == 1


def test_hidden_chart_names_queries_ids_and_totals_do_not_escape(chart_world):
    world = chart_world
    with world.client("manager") as writer:
        resource = writer.post("/api/charts", json=world.body("Hidden Chart Canary")).json()
    with world.client("stranger") as client:
        assert client.get("/api/charts").json()["pagination"]["total"] == 0
        for method, path, kwargs in [
            ("GET", f"/api/charts/{resource['id']}", {}),
            ("GET", f"/api/charts/{resource['id']}/usage", {}),
            (
                "PATCH",
                f"/api/charts/{resource['id']}",
                {"json": {"revision": 1, "name": "Forbidden"}},
            ),
        ]:
            response = client.request(method, path, **kwargs)
            assert response.status_code == 404
            assert "Hidden Chart Canary" not in response.text
            assert resource["id"] not in response.text


def test_chart_filters_literal_search_and_ties_are_applied_before_paging(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = [
            client.post("/api/charts", json=world.body(name)).json()
            for name in ("A %_ chart", "A %_ chart", "Z plain chart")
        ]
        identifiers = []
        for offset in (0, 1, 2):
            page = client.get(
                "/api/charts",
                params={
                    "module_id": str(world.module.id),
                    "department_id": str(world.module.department_id),
                    "limit": 1,
                    "offset": offset,
                },
            ).json()
            identifiers.append(page["items"][0]["id"])
            assert page["pagination"]["total"] == 3
            assert page["pagination"]["has_more"] is (offset < 2)
        assert identifiers == [row["id"] for row in created]
        searched = client.get("/api/charts", params={"search": "%_", "limit": 1}).json()
        assert searched["pagination"]["total"] == 2
        assert (
            client.get(
                "/api/charts", params={"department_id": str(world.other_module.department_id)}
            ).json()["pagination"]["total"]
            == 0
        )
        assert (
            client.delete(f"/api/charts/{created[0]['id']}", params={"revision": 1}).status_code
            == 204
        )
        assert (
            client.get("/api/charts", params={"deleted": "only"}).json()["items"][0]["id"]
            == created[0]["id"]
        )


@pytest.mark.parametrize("params", [{"limit": 101}, {"sort_by": "unsafe"}, {"deleted": "unknown"}])
def test_invalid_list_parameters_remain_422(chart_world, params):
    with chart_world.client("reader") as client:
        assert client.get("/api/charts", params=params).status_code == 422
