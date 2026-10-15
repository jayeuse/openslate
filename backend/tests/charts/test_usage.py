"""Usage read boundaries, visible pagination and retained-reference archive refusal."""

from uuid import UUID

import pytest

from app.core.base_model import utc_now
from app.systems.access.policy.models import Group, GroupMember
from app.systems.boards.models import Board, BoardGroup, BoardWidget
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from tests.charts.chart_route_support import chart_world as chart_world

pytestmark = pytest.mark.integration


def _consumers(world, chart_id):
    # Owned retained references model a post-move foreign Dashboard too. This
    # does not claim B2's public attachment behavior or a sample/live write.
    visible_board = Board(org_id=world.module.org_id, scope="project", name="Visible %_ board")
    private_board = Board(org_id=world.module.org_id, scope="project", name="PRIVATE BOARD CANARY")
    visible_dashboard = Dashboard(
        org_id=world.module.org_id,
        department_id=world.module.department_id, name="Visible dashboard"
    )
    private_dashboard = Dashboard(
        org_id=world.other_module.org_id,
        department_id=world.other_module.department_id,
        name="PRIVATE DASHBOARD CANARY",
        is_deleted=True,
        deleted_at=utc_now(),
    )
    group = Group(org_id=visible_board.org_id, name="Readable Board " + str(chart_id))
    world.db.add_all([visible_board, private_board, visible_dashboard, private_dashboard, group])
    world.db.flush()
    world.db.add_all(
        [
            GroupMember(org_id=group.org_id, group_id=group.id, user_id=world.users[key].id)
            for key in ("manager", "reader")
        ]
    )
    world.db.add(BoardGroup(org_id=visible_board.org_id,
                            board_id=visible_board.id, group_id=group.id, level="read"))
    refs = []
    for board, position, deleted in [
        (visible_board, 0, False),
        (visible_board, 1, True),
        (private_board, 0, False),
    ]:
        row = BoardWidget(
            org_id=board.org_id,
            board_id=board.id,
            module_id=world.module.id,
            name="Reference",
            position=position,
            widget_type="chart",
            chart_id=chart_id,
            config=None,
            is_deleted=deleted,
            deleted_at=utc_now() if deleted else None,
        )
        refs.append(row)
        world.db.add(row)
    for dashboard in (visible_dashboard, private_dashboard):
        row = DashboardWidget(
            org_id=dashboard.org_id,
            dashboard_id=dashboard.id,
            position=0,
            widget_type="chart",
            chart_id=chart_id,
            config=None,
        )
        refs.append(row)
        world.db.add(row)
    world.db.commit()
    return visible_board, private_board, visible_dashboard, private_dashboard, refs


def test_usage_filters_distinct_consumers_before_count_page_and_search(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(created["id"])
        board, hidden_board, dashboard, hidden_dashboard, _ = _consumers(world, chart_id)
        expected = {("board", str(board.id)), ("dashboard", str(dashboard.id))}
        seen = set()
        for offset in (0, 1):
            response = client.get(
                f"/api/charts/{chart_id}/usage", params={"limit": 1, "offset": offset}
            )
            assert response.status_code == 200
            body = response.json()
            seen.add((body["items"][0]["kind"], body["items"][0]["id"]))
            assert body["pagination"] == {
                "limit": 1,
                "offset": offset,
                "count": 1,
                "total": 2,
                "has_more": offset == 0,
            }
            assert body["has_restricted_usage"] is True
            for canary in ("PRIVATE", str(hidden_board.id), str(hidden_dashboard.id)):
                assert canary not in response.text
        assert seen == expected
        searched = client.get(f"/api/charts/{chart_id}/usage", params={"search": "%_"}).json()
        assert [item["id"] for item in searched["items"]] == [str(board.id)]
        assert searched["pagination"]["total"] == 1 and searched["has_restricted_usage"] is True
        empty = client.get(f"/api/charts/{chart_id}/usage", params={"search": "No match"}).json()
        assert empty["items"] == [] and empty["pagination"]["total"] == 0
        assert empty["has_restricted_usage"] is True
    with world.client("admin") as admin:
        response = admin.get(f"/api/charts/{chart_id}/usage")
        assert response.json()["pagination"]["total"] == 4
        assert response.json()["has_restricted_usage"] is False
        assert {item["id"] for item in response.json()["items"]} == {
            str(item.id) for item in (board, hidden_board, dashboard, hidden_dashboard)
        }


def test_inaccessible_and_deleted_references_still_block_archive_without_leaking(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(created["id"])
        board, hidden_board, dashboard, hidden_dashboard, refs = _consumers(world, chart_id)
        blocked = client.delete(f"/api/charts/{chart_id}", params={"revision": 1})
        assert blocked.status_code == 409
        detail = blocked.json()["detail"]
        assert detail["code"] == "chart_in_use"
        assert detail["usage"]["pagination"]["total"] == 2
        assert detail["usage"]["has_restricted_usage"] is True
        for canary in ("PRIVATE", str(hidden_board.id), str(hidden_dashboard.id)):
            assert canary not in blocked.text
        for row in refs:
            visible = (isinstance(row, BoardWidget) and row.board_id == board.id) or (
                isinstance(row, DashboardWidget) and row.dashboard_id == dashboard.id
            )
            if visible:
                world.db.delete(row)
        world.db.commit()
        still_blocked = client.delete(f"/api/charts/{chart_id}", params={"revision": 1})
        assert still_blocked.status_code == 409
        usage = still_blocked.json()["detail"]["usage"]
        assert usage["items"] == [] and usage["pagination"]["total"] == 0
        assert usage["has_restricted_usage"] is True
        for row in refs:
            if (
                isinstance(row, BoardWidget)
                and row.board_id == hidden_board.id
                or (isinstance(row, DashboardWidget) and row.dashboard_id == hidden_dashboard.id)
            ):
                world.db.delete(row)
        world.db.commit()
        assert client.delete(f"/api/charts/{chart_id}", params={"revision": 1}).status_code == 204
        world.db.expire_all()
        assert world.db.get(Chart, chart_id).revision == 2


def test_referenced_chart_can_change_visualization_but_not_widget_category(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(created["id"])
        _consumers(world, chart_id)
        pie = client.patch(f"/api/charts/{chart_id}", json={"revision": 1, "chart_type": "pie"})
        assert pie.status_code == 200 and pie.json()["revision"] == 2
        records = {"module_id": str(world.module.id), "definition": {"columns": [], "filters": []}}
        rejected = client.patch(
            f"/api/charts/{chart_id}",
            json={"revision": 2, "chart_type": "records", "query": records},
        )
        assert rejected.status_code == 409 and "PRIVATE" not in rejected.text
        assert client.get(f"/api/charts/{chart_id}").json()["chart_type"] == "pie"
