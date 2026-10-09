"""Retained saved sources and foreign consumers participate in PostgreSQL purge plans."""

from copy import deepcopy
from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.boards.models import BoardStatus, BoardWidget
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.lifecycle.exceptions import LifecyclePlanDriftError
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from tests.charts.chart_route_support import chart_world as chart_world
from tests.charts.widget_reference_support import managed_board
from tests.lifecycle_integration.lifecycle_integration_support import _close_rows
from tests.lifecycle_integration.test_chart_lifecycle_api import _close, _password_boundary

pytestmark = pytest.mark.integration


def _consumers(world, client, chart_id, kind):
    spec = {"widget_type": "chart", "chart_id": chart_id, "config": None, "size": "S"}
    if kind == "board":
        parent = managed_board(world, "admin")
        response = client.post(
            f"/api/boards/{parent.id}/widgets",
            json={
                "revision": parent.revision,
                "widget": {
                    **spec,
                    "name": "Owned reference",
                    "module_id": str(world.module.id),
                    "pinned": True,
                },
            },
        )
        assert response.status_code == 201, response.text
        widget = world.db.scalar(select(BoardWidget).where(BoardWidget.board_id == parent.id))
    else:
        response = client.post(
            "/api/dashboards",
            json={
                "department_id": str(world.module.department_id),
                "name": "Owned reference",
                "widgets": [spec],
            },
        )
        assert response.status_code == 201, response.text
        parent = world.db.get(Dashboard, UUID(response.json()["id"]))
        widget = world.db.scalar(
            select(DashboardWidget).where(DashboardWidget.dashboard_id == parent.id)
        )
    assert widget is not None and widget.chart_id == UUID(chart_id) and widget.config is None
    return parent, widget


@pytest.mark.parametrize("kind", ["board", "dashboard"])
@pytest.mark.parametrize("state", ["active", "archived_parent", "deleted_widget"])
def test_saved_consumers_block_field_purge_with_null_config(chart_world, monkeypatch, kind, state):
    world = chart_world
    _password_boundary(world, monkeypatch)
    with world.client("admin") as client:
        created = client.post("/api/charts", json=world.body())
        assert created.status_code == 201, created.text
        chart_id = created.json()["id"]
        parent, widget = _consumers(world, client, chart_id, kind)
        if state == "archived_parent":
            if kind == "board":
                parent.status = BoardStatus.ARCHIVED
            else:
                _close_rows(parent)
        elif state == "deleted_widget":
            _close_rows(widget)
        world.db.commit()
        _close(client, world.label)
        response = client.post(f"/api/fields/{world.label.id}/purge/preview")
        assert response.status_code == 200, response.text
        impact = response.json()["impact"]
        code = f"purge_{kind}_dependency"
        consumer = [item for item in impact["blockers"] if item["code"] == code]
        assert {item["entity_id"] for item in consumer} == {str(widget.id)}
        assert consumer[0]["conflicting_entity_id"] == str(parent.id)
        assert consumer[0]["field_id"] == str(world.label.id)
        assert any(
            item["code"] == "purge_chart_dependency" and item["entity_id"] == chart_id
            for item in impact["blockers"]
        )


@pytest.mark.parametrize("target", ["module", "department"])
def test_parent_scope_inventories_all_charts_and_retained_foreign_consumers(chart_world, target):
    world = chart_world
    with world.client("admin") as client:
        chart_id = client.post("/api/charts", json=world.body()).json()["id"]
        board, board_widget = _consumers(world, client, chart_id, "board")
        dashboard, dashboard_widget = _consumers(world, client, chart_id, "dashboard")
        archived = client.post("/api/charts", json=world.body("Unused archived")).json()
        assert client.delete(f"/api/charts/{archived['id']}?revision=1").status_code == 204
        # A Module move leaves the existing Dashboard in its original Department.
        world.module.department_id = world.other_module.department_id
        dashboard.is_deleted = True
        dashboard.deleted_at = datetime.now(UTC)
        board.status = BoardStatus.ARCHIVED
        _close_rows(
            board_widget,
            dashboard_widget,
            world.module,
            world.label,
            world.amount,
            world.date,
            world.person,
        )
        world.db.commit()
        target_id = world.module.id if target == "module" else world.module.department_id
        if target == "department":
            from app.systems.sandbox.departments.models import Department

            _close_rows(world.db.get(Department, target_id))
            world.db.commit()
        plan = plan_lifecycle(world.db, target, target_id, "purge", world.users["admin"].id)
        assert set(plan.scope_ids["charts"]) == {UUID(chart_id), UUID(archived["id"])}
        assert set(plan.scope_ids["board_widgets"]) == {board_widget.id}
        assert set(plan.scope_ids["dashboard_widgets"]) == {dashboard_widget.id}
        assert {
            item.entity_id for item in plan.blockers if item.code.value == "purge_board_dependency"
        } == {board_widget.id}
        assert {
            item.entity_id
            for item in plan.blockers
            if item.code.value == "purge_dashboard_dependency"
        } == {dashboard_widget.id}
        assert not any(item.code.value == "purge_chart_dependency" for item in plan.blockers)


@pytest.mark.parametrize(
    "entity,change",
    [
        ("chart", "query"),
        ("chart", "chart_type"),
        ("chart", "module_id"),
        ("chart", "department_id"),
        ("chart", "revision"),
        ("board", "chart_id"),
        ("board", "size"),
        ("board", "pinned"),
        ("dashboard", "chart_id"),
        ("dashboard", "size"),
    ],
)
def test_saved_source_and_presentation_fingerprints_reject_old_preview(chart_world, entity, change):
    world = chart_world
    with world.client("admin") as client:
        first = client.post("/api/charts", json=world.body("First")).json()
        second = client.post("/api/charts", json=world.body("Second")).json()
        _, board_widget = _consumers(world, client, first["id"], "board")
        _, dashboard_widget = _consumers(world, client, first["id"], "dashboard")
        chart = world.db.get(Chart, UUID(first["id"]))
        _close_rows(world.module, world.label, world.amount, world.date, world.person)
        world.db.commit()
        old = plan_lifecycle(world.db, "module", world.module.id, "purge", world.users["admin"].id)
        row = {"chart": chart, "board": board_widget, "dashboard": dashboard_widget}[entity]
        original = next(item.state_fingerprint for item in old.rows if item.entity_id == row.id)
        if change == "query":
            query = deepcopy(chart.query)
            query["definition"]["search"] = "changed retained query"
            row.query = query
        else:
            value = {
                "chart_type": "pie",
                "module_id": world.other_module.id,
                "department_id": world.other_module.department_id,
                "revision": 2,
                "chart_id": UUID(second["id"]),
                "size": "L",
                "pinned": False,
            }[change]
            setattr(row, change, value)
        world.db.commit()
        fresh = plan_lifecycle(
            world.db, "module", world.module.id, "purge", world.users["admin"].id
        )
        fresh_rows = [item for item in fresh.rows if item.entity_id == row.id]
        assert not fresh_rows or fresh_rows[0].state_fingerprint != original
        with pytest.raises(LifecyclePlanDriftError):
            execute_lifecycle(world.db, old)
