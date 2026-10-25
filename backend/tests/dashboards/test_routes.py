"""Department Dashboard route behavior on the runner-owned PostgreSQL database."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.fields.models import Field, FieldType
from tests.dashboards.dashboard_route_support import (
    _actor,
    _aggregate_widget,
    _chart,
    _client,
    _dashboard_audit_rows,
    _department,
    _module,
    _records_widget,
)
from tests.rbac.support import add_user, make_group_access

pytestmark = pytest.mark.integration


def test_owner_can_create_page_revision_update_archive_and_restore_dashboard_draft(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    module, dimension = _module(db)
    set_audit_actor(db, owner.id)

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={
                "department_id": str(module.department_id),
                "name": "  Operations  ",
                "widgets": [_chart(module, dimension)],
            },
        )
        assert created.status_code == 201
        assert created.headers["cache-control"] == "private, no-store"
        dashboard_id = UUID(created.json()["id"])
        assert created.headers["location"] == f"/api/dashboards/{dashboard_id}"
        assert created.json()["name"] == "Operations"
        assert created.json()["refresh_cadence"] == "manual"
        assert created.json()["department_id"] == str(module.department_id)
        assert created.json()["position"] == 0
        assert created.json()["revision"] == 1
        assert created.json()["widgets"][0]["position"] == 0
        assert created.json()["widgets"][0]["config"]["query"]["module_id"] == str(module.id)
        assert "result_snapshot" not in created.json()["widgets"][0]["config"]

        paged = client.get("/api/dashboards?limit=1&offset=0")
        assert paged.status_code == 200
        assert paged.headers["cache-control"] == "private, no-store"
        assert [item["id"] for item in paged.json()["items"]] == [str(dashboard_id)]
        assert paged.json()["pagination"] == {
            "limit": 1,
            "offset": 0,
            "count": 1,
            "total": 1,
            "has_more": False,
        }

        renamed = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={
                "revision": 1,
                "name": "Operations team",
                "refresh_cadence": "one-minute",
            },
        )
        assert renamed.status_code == 200
        assert renamed.json()["revision"] == 2
        assert renamed.json()["refresh_cadence"] == "one-minute"
        assert renamed.json()["widgets"] == created.json()["widgets"]

        stale = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 1, "widgets": []},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "stale_revision"
        assert stale.json()["detail"]["current_revision"] == 2

        archived = client.delete(f"/api/dashboards/{dashboard_id}?revision=2")
        assert archived.status_code == 204
        archived_read = client.get(f"/api/dashboards/{dashboard_id}")
        assert archived_read.status_code == 200
        assert archived_read.json()["is_deleted"] is True
        assert len(archived_read.json()["widgets"]) == 1

        restored = client.post(
            f"/api/dashboards/{dashboard_id}/restore",
            json={"revision": 3},
        )
        assert restored.status_code == 200
        assert restored.json()["revision"] == 4
        assert restored.json()["is_deleted"] is False
        assert len(restored.json()["widgets"]) == 1

        replaced = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 4, "widgets": []},
        )
        assert replaced.status_code == 200
        assert replaced.json()["revision"] == 5
        assert replaced.json()["widgets"] == []

    audit_rows = _dashboard_audit_rows(db, dashboard_id)
    assert [row.action for row in audit_rows] == [
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
        AuditAction.UPDATE,
        AuditAction.UPDATE,
    ]
    assert all(row.performed_by == owner.id for row in audit_rows)
    widget_rows = list(
        db.scalars(
            select(DashboardWidget).where(
                DashboardWidget.dashboard_id == dashboard_id,
                DashboardWidget.is_deleted.is_(False),
            )
        ).all()
    )
    assert widget_rows == []


def test_dashboard_persists_summary_workload_record_and_chart_widgets(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    module, dimension = _module(db, name="Live Dashboard widgets")
    set_audit_actor(db, owner.id)
    widgets = [
        _aggregate_widget("summary", module, dimension, (0, 0, 2, 1)),
        _aggregate_widget("workload", module, dimension, (2, 0, 2, 2)),
        _records_widget(module, dimension, (0, 1, 2, 2)),
        _chart(module, dimension, (2, 2, 2, 2)),
    ]

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={
                "department_id": str(module.department_id),
                "name": "Operations",
                "refresh_cadence": "one-minute",
                "widgets": widgets,
            },
        )
        assert created.status_code == 201, created.text
        dashboard_id = UUID(created.json()["id"])
        assert created.json()["refresh_cadence"] == "one-minute"
        assert [widget["widget_type"] for widget in created.json()["widgets"]] == [
            "summary",
            "workload",
            "records",
            "chart",
        ]
        db.expire_all()
        persisted = db.get(Dashboard, dashboard_id)
        assert persisted is not None
        assert persisted.refresh_cadence == "one-minute"
        persisted_widgets = list(
            db.scalars(
                select(DashboardWidget)
                .where(
                    DashboardWidget.dashboard_id == dashboard_id,
                    DashboardWidget.is_deleted.is_(False),
                )
                .order_by(DashboardWidget.position)
            ).all()
        )
        assert [widget.widget_type for widget in persisted_widgets] == [
            "summary",
            "workload",
            "records",
            "chart",
        ]
        assert [widget.position for widget in persisted_widgets] == [0, 1, 2, 3]
        assert [widget.config for widget in persisted_widgets] == [
            widget["config"] for widget in created.json()["widgets"]
        ]
        updated = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 1, "refresh_cadence": "five-minutes"},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["revision"] == 2
        assert updated.json()["refresh_cadence"] == "five-minutes"
        db.expire_all()
        persisted = db.get(Dashboard, dashboard_id)
        assert persisted is not None
        assert persisted.refresh_cadence == "five-minutes"


def test_dashboard_widget_type_change_is_persisted_when_config_is_unchanged(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    module, dimension = _module(db, name="Dashboard widget type change")
    set_audit_actor(db, owner.id)
    summary = _aggregate_widget("summary", module, dimension, (0, 0, 2, 1))
    workload = _aggregate_widget("workload", module, dimension, (0, 0, 2, 2))

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={
                "department_id": str(module.department_id),
                "name": "Operations",
                "widgets": [summary],
            },
        )
        assert created.status_code == 201, created.text
        dashboard_id = UUID(created.json()["id"])
        changed = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 1, "widgets": [workload]},
        )

    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 2
    assert [widget["widget_type"] for widget in changed.json()["widgets"]] == ["workload"]


def test_dashboard_rejects_stale_record_widget_fields_without_saving(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    module, _ = _module(db, name="Dashboard records query")
    deleted_field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Deleted field",
        type=FieldType.TEXT,
        required=False,
        position=1,
        config={},
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add(deleted_field)
    db.flush()
    set_audit_actor(db, owner.id)
    with _client(db, owner) as client:
        response = client.post(
            "/api/dashboards",
            json={
                "department_id": str(module.department_id),
                "name": "Invalid list",
                "widgets": [_records_widget(module, deleted_field)],
            },
        )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dashboard_invalid"
    assert (
        db.scalar(select(Dashboard).where(Dashboard.department_id == module.department_id)) is None
    )


def test_dashboards_are_hidden_outside_departments_the_user_can_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = _department(db, "Hidden dashboards")
    dashboard = Dashboard(org_id=department.org_id,
                          department_id=department.id, name="Department dashboard")
    db.add(dashboard)
    db.flush()
    outsider = add_user(db, "dash-outsider")
    admin = add_user(db, "dash-admin", role="admin")

    set_audit_actor(db, outsider.id)
    with _client(db, outsider) as client:
        assert client.get(f"/api/dashboards/{dashboard.id}").status_code == 404
        assert client.get("/api/dashboards").json()["pagination"]["total"] == 0
        forbidden_patch = client.patch(
            f"/api/dashboards/{dashboard.id}",
            json={"revision": 1, "name": "Overwritten"},
        )
        assert forbidden_patch.status_code == 404

    set_audit_actor(db, admin.id)
    with _client(db, admin) as client:
        assert client.get(f"/api/dashboards/{dashboard.id}").status_code == 200
        listed = client.get("/api/dashboards", params={"department_id": str(department.id)})
        assert [item["id"] for item in listed.json()["items"]] == [str(dashboard.id)]

    persisted = db.get(Dashboard, dashboard.id)
    assert persisted is not None and persisted.name == "Department dashboard"


def test_dashboard_routes_let_a_department_reader_read_but_not_write(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader = _actor(db, level=AccessLevel.READ)
    department = _department(db)
    manager = add_user(db, "dash-manager")
    make_group_access(db, [manager], department, level=AccessLevel.MANAGE)
    set_audit_actor(db, reader.id)
    payload = {"department_id": str(department.id), "name": "Denied"}

    with _client(db, reader) as read_client, _client(db, manager) as write_client:
        assert read_client.get("/api/dashboards").status_code == 200
        assert read_client.post("/api/dashboards", json=payload).status_code == 403

        set_audit_actor(db, manager.id)
        created = write_client.post(
            "/api/dashboards", json={**payload, "name": "Manager dashboard"}
        )
        assert created.status_code == 201
        assert created.json()["department_id"] == str(department.id)
        listed = read_client.get("/api/dashboards").json()["items"]
        assert [item["id"] for item in listed] == [created.json()["id"]]
