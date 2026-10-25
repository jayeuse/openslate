"""Dashboard reference journeys through the real Chart and Dashboard HTTP commands."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import AccessLevel
from app.systems.manage.audit.models import AuditLog
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.departments.models import Department
from tests.charts.chart_route_support import chart_world as chart_world
from tests.rbac.support import make_group_access

pytestmark = pytest.mark.integration

SMALL = {"grid_column": 0, "grid_row": 0, "column_span": 2, "row_span": 2}
LARGE = {"grid_column": 0, "grid_row": 0, "column_span": 4, "row_span": 3}


def test_dashboard_reference_preserves_size_identity_and_usage_until_removed(chart_world):
    world = chart_world
    with world.client("manager") as client:
        chart = client.post("/api/charts", json=world.body()).json()
        spec = {"widget_type": "chart", **SMALL, "chart_id": chart["id"], "config": None}
        created = client.post(
            "/api/dashboards",
            json={
                "department_id": str(world.module.department_id),
                "name": "Reference Dashboard",
                "widgets": [spec],
            },
        )
        assert created.status_code == 201
        saved = created.json()
        dashboard_id = saved["id"]
        widget = saved["widgets"][0]
        assert widget["chart_id"] == chart["id"] and widget["config"] is None
        assert {key: widget[key] for key in SMALL} == SMALL
        row = world.db.get(DashboardWidget, UUID(widget["id"]))
        assert row.chart_id == UUID(chart["id"]) and row.config is None
        assert (row.grid_column, row.grid_row, row.column_span, row.row_span) == (0, 0, 2, 2)
        audit_ids = set(
            world.db.scalars(
                select(AuditLog.id).where(AuditLog.entity_id.in_([UUID(dashboard_id), row.id]))
            ).all()
        )
        unchanged = client.patch(
            f"/api/dashboards/{dashboard_id}", json={"revision": 1, "widgets": [spec]}
        )
        assert unchanged.status_code == 200 and unchanged.json()["revision"] == 1
        assert unchanged.json()["widgets"] == saved["widgets"]
        assert (
            set(
                world.db.scalars(
                    select(AuditLog.id).where(AuditLog.entity_id.in_([UUID(dashboard_id), row.id]))
                ).all()
            )
            == audit_ids
        )
        changed = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 1, "widgets": [{**spec, **LARGE}]},
        )
        assert changed.status_code == 200 and changed.json()["revision"] == 2
        assert {key: changed.json()["widgets"][0][key] for key in LARGE} == LARGE
        assert changed.json()["widgets"][0]["chart_id"] == chart["id"]
        shown = client.get(f"/api/dashboards/{dashboard_id}")
        assert shown.status_code == 200 and shown.json()["widgets"] == changed.json()["widgets"]
        usage = client.get(f"/api/charts/{chart['id']}/usage").json()
        assert [(item["kind"], item["id"]) for item in usage["items"]] == [
            ("dashboard", dashboard_id)
        ]
        assert client.delete(f"/api/charts/{chart['id']}?revision=1").status_code == 409
        removed = client.patch(
            f"/api/dashboards/{dashboard_id}", json={"revision": 2, "widgets": []}
        )
        assert removed.status_code == 200 and removed.json()["revision"] == 3
        assert removed.json()["widgets"] == []
        assert client.delete(f"/api/charts/{chart['id']}?revision=1").status_code == 204


def test_dashboard_reference_request_and_authority_failures_leave_no_dashboard(chart_world):
    world = chart_world
    with world.client("manager") as owner:
        chart = owner.post("/api/charts", json=world.body()).json()
    spec = {"widget_type": "chart", **SMALL, "chart_id": chart["id"], "config": None}
    body = {
        "department_id": str(world.module.department_id),
        "name": "Denied Dashboard",
        "widgets": [spec],
    }
    for actor in ("reader", "module_manager", "guest"):
        with world.client(actor) as client:
            assert client.post("/api/dashboards", json=body).status_code == 403
    with world.client("manager") as client:
        for invalid in (
            {**spec, "chart_id": None},
            {**spec, "config": {"chart_type": "bar", "query": world.grouped()}},
            {**spec, "column_span": 0},
            {**spec, "chart_id": "display-name"},
        ):
            assert (
                client.post("/api/dashboards", json={**body, "widgets": [invalid]}).status_code
                == 422
            )
        mismatched = client.post(
            "/api/dashboards", json={**body, "widgets": [{**spec, "widget_type": "summary"}]}
        )
        assert (
            mismatched.status_code == 409
            and mismatched.json()["detail"]["code"] == "dashboard_invalid"
        )
        # The size rule follows the saved chart's own type (bar) for a referenced widget.
        too_small = client.post(
            "/api/dashboards",
            json={**body, "widgets": [{**spec, "column_span": 2, "row_span": 1}]},
        )
        assert too_small.status_code == 422
        assert too_small.json()["detail"]["errors"] == [
            {
                "index": 0,
                "code": "size_not_allowed",
                "message": "A bar chart must be 2 × 2 to 4 × 3 (columns × rows)",
            }
        ]
    assert world.db.scalars(select(Dashboard).where(Dashboard.name == body["name"])).all() == []


def test_dashboard_replacement_refusal_and_failed_flush_commit_preserve_prior_state(
    chart_world, monkeypatch
):
    world = chart_world
    with world.client("manager") as client:
        chart = client.post("/api/charts", json=world.body()).json()
        spec = {"widget_type": "chart", **SMALL, "chart_id": chart["id"], "config": None}
        saved = client.post(
            "/api/dashboards",
            json={
                "department_id": str(world.module.department_id),
                "name": "Atomic references",
                "widgets": [spec],
            },
        ).json()
        dashboard_id = UUID(saved["id"])
        widget_id = UUID(saved["widgets"][0]["id"])
        before = set(world.db.scalars(select(AuditLog.id)).all())
        invalid_query = world.grouped()
        invalid_query["dimension"] = {
            "field_id": str(world.other_module.id),
            "expected_type": "text",
        }
        invalid = {
            "widget_type": "chart",
            **SMALL,
            "grid_row": 3,
            "config": {"chart_type": "bar", "query": invalid_query},
        }
        refused = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 1, "widgets": [{**spec, **LARGE}, invalid]},
        )
        assert refused.status_code == 409

        def failed_commit():
            world.db.flush()
            raise IntegrityError("COMMIT", {}, RuntimeError("owned injected commit failure"))

        with monkeypatch.context() as patch:
            patch.setattr(world.db, "commit", failed_commit)
            failed = client.patch(
                f"/api/dashboards/{dashboard_id}",
                json={"revision": 1, "widgets": [{**spec, **LARGE}]},
            )
        assert failed.status_code == 409
        with Session(
            bind=world.db.get_bind(), join_transaction_mode="create_savepoint"
        ) as observer:
            assert observer.get(Dashboard, dashboard_id).revision == 1
            rows = observer.scalars(
                select(DashboardWidget).where(DashboardWidget.dashboard_id == dashboard_id)
            ).all()
            assert [(row.id, row.column_span, row.chart_id, row.config) for row in rows] == [
                (widget_id, 2, UUID(chart["id"]), None)
            ]
            assert set(observer.scalars(select(AuditLog.id)).all()) == before


def test_dashboard_reference_uses_current_module_department_not_stored_chart_owner(chart_world):
    world = chart_world
    with world.client("manager") as client:
        chart = client.post("/api/charts", json=world.body()).json()
        saved = client.post(
            "/api/dashboards",
            json={
                "department_id": str(world.module.department_id),
                "name": "Moved source",
                "widgets": [],
            },
        ).json()
        other_department = world.db.get(Department, world.other_module.department_id)
        make_group_access(
            world.db, [world.users["manager"]], other_department, level=AccessLevel.READ
        )
        world.module.department_id = other_department.id
        world.db.commit()  # Owned current-source fixture; C owns publication synchronization.
        refused = client.patch(
            f"/api/dashboards/{saved['id']}",
            json={
                "revision": 1,
                "widgets": [
                    {"widget_type": "chart", **SMALL, "chart_id": chart["id"], "config": None}
                ],
            },
        )
        assert (
            refused.status_code == 409 and refused.json()["detail"]["code"] == "dashboard_invalid"
        )
        shown = client.get(f"/api/dashboards/{saved['id']}").json()
        assert shown["revision"] == 1 and shown["widgets"] == []


def test_revoked_real_session_cannot_attach_a_dashboard_reference(chart_world):
    world = chart_world
    with world.client("manager") as client:
        chart = client.post("/api/charts", json=world.body()).json()
        session = world.db.scalar(
            select(IdentitySession)
            .where(IdentitySession.user_id == world.users["manager"].id)
            .order_by(IdentitySession.created_at.desc())
        )
        session.revoked_at = utc_now()
        world.db.commit()
        denied = client.post(
            "/api/dashboards",
            json={
                "department_id": str(world.module.department_id),
                "name": "Revoked attachment",
                "widgets": [
                    {"widget_type": "chart", **SMALL, "chart_id": chart["id"], "config": None}
                ],
            },
        )
        assert denied.status_code == 403
        assert (
            world.db.scalars(select(Dashboard).where(Dashboard.name == "Revoked attachment")).all()
            == []
        )
