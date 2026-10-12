"""Saved Chart queries remain field-purge dependencies through real HTTP/PG journeys."""

from uuid import UUID

import pytest

from app.systems.openview.charts.models import Chart
from app.systems.sandbox.fields.models import Field
from tests.charts.chart_route_support import chart_world as chart_world
from tests.lifecycle_integration.lifecycle_integration_support import (
    close_field,
    patch_password_boundary,
)

pytestmark = pytest.mark.integration


def _reference(field):
    return {"field_id": str(field.id), "expected_type": getattr(field.type, "value", field.type)}


def test_retained_chart_filter_reference_blocks_field_purge(chart_world, monkeypatch):
    world = chart_world
    patch_password_boundary(monkeypatch, lambda: world.users["admin"].id, purge_enabled=True)
    kind, field = "records", world.label
    reference = {**_reference(field), "operator": "eq", "value": "owned matching value"}
    query = {
        "module_id": str(world.module.id),
        "definition": {"version": 1, "filters": [reference]},
    }
    with world.client("admin") as client:
        created = client.post("/api/charts", json=world.body(kind=kind, query=query))
        assert created.status_code == 201, created.text
        chart = created.json()
        close_field(client, field)
        preview = client.post(f"/api/fields/{field.id}/purge/preview")
        assert preview.status_code == 200, preview.text
        impact = preview.json()["impact"]
        blockers = [item for item in impact["blockers"] if item["code"] == "purge_chart_dependency"]
        assert {item["entity_id"] for item in blockers} == {chart["id"]}
        assert blockers[0]["field_id"] == str(field.id)
        assert blockers[0]["module_id"] == str(world.module.id)
        # The blocker names the Chart and the Field it conflicts with, and where they live.
        assert blockers[0]["entity_type"] == "charts"
        assert blockers[0]["conflicting_entity_type"] == "fields"
        assert blockers[0]["conflicting_entity_id"] == str(field.id)
        assert blockers[0]["field_name"] == field.name
        assert blockers[0]["module_name"] == world.module.module_name
        assert blockers[0]["department_id"] == str(world.module.department_id)
        assert any(
            row["entity_type"] == "charts" and row["entity_id"] == chart["id"]
            for row in impact["rows"]
        )
        before_audits = len(world.audit_rows(UUID(chart["id"])))
        refused = client.post(
            f"/api/fields/{field.id}/purge",
            json={
                "token": preview.json()["token"],
                "confirmation_name": field.name,
                "password": "owned chart lifecycle password",
            },
        )
        assert refused.status_code == 409 and refused.json()["detail"]["code"] == "preflight_failed"
        world.db.expire_all()
        assert world.db.get(Field, field.id) is not None
        assert world.db.get(Chart, UUID(chart["id"])) is not None
        assert len(world.audit_rows(UUID(chart["id"]))) == before_audits


def test_archived_query_still_blocks_then_restore_and_repair_preserve_chart(
    chart_world, monkeypatch
):
    world = chart_world
    patch_password_boundary(monkeypatch, lambda: world.users["admin"].id, purge_enabled=True)
    with world.client("admin") as client:
        created = client.post("/api/charts", json=world.body())
        assert created.status_code == 201, created.text
        chart = created.json()
        archived = client.delete(f"/api/charts/{chart['id']}?revision={chart['revision']}")
        assert archived.status_code == 204
        close_field(client, world.label)
        preview = client.post(f"/api/fields/{world.label.id}/purge/preview")
        assert preview.status_code == 200
        assert any(
            item["code"] == "purge_chart_dependency"
            for item in preview.json()["impact"]["blockers"]
        )
        current = client.get(f"/api/charts/{chart['id']}").json()
        restored = client.post(
            f"/api/charts/{chart['id']}/restore", json={"revision": current["revision"]}
        )
        assert restored.status_code == 200, restored.text
        replacement = world.grouped()
        replacement["dimension"] = _reference(world.person)
        repaired = client.patch(
            f"/api/charts/{chart['id']}",
            json={"revision": restored.json()["revision"], "query": replacement},
        )
        assert repaired.status_code == 200, repaired.text
        fresh = client.post(f"/api/fields/{world.label.id}/purge/preview")
        assert fresh.status_code == 200 and not fresh.json()["impact"]["blockers"]
        purged = client.post(
            f"/api/fields/{world.label.id}/purge",
            json={
                "token": fresh.json()["token"],
                "confirmation_name": world.label.name,
                "password": "owned chart lifecycle password",
            },
        )
        assert purged.status_code == 200, purged.text
        assert client.get(f"/api/charts/{chart['id']}").json()["query"]["dimension"][
            "field_id"
        ] == str(world.person.id)
