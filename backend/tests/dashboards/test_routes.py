"""Private Dashboard route behavior on the runner-owned PostgreSQL database."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.openview.dashboards.router import router
from app.systems.openview.dashboards.schemas import DashboardChartConfig
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from app.systems.sandbox.modules.models import Module
from tests.rbac.support import capability_actor, grant_capability_actors

pytestmark = pytest.mark.integration


def _actor(
    db: Session,
    *,
    capabilities: dict[str, bool] | None = None,
    role: str | None = None,
) -> User:
    return capability_actor(db, "dash", capabilities, role=role)


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _module(db: Session, *, name: str = "Dashboard records") -> tuple[Module, Field]:
    department = Department(department_name=f"{name} {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=name,
    )
    db.add(module)
    db.flush()
    grant_capability_actors(db, department, module)
    dimension = Field(
        module_id=module.id,
        name="Status",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(dimension)
    db.flush()
    return module, dimension


def _chart_config(module: Module, dimension: Field) -> dict[str, object]:
    return DashboardChartConfig.model_validate(
        {
            "version": 1,
            "chart_type": "bar",
            "query": {
                "module_id": str(module.id),
                "definition": {"version": 1, "columns": []},
                "mode": "groups",
                "dimension": {"field_id": str(dimension.id), "expected_type": "text"},
                "aggregation": "count",
            },
        }
    ).model_dump(mode="json")


def _chart(module: Module, dimension: Field) -> dict[str, object]:
    return {"widget_type": "chart", "config": _chart_config(module, dimension)}


def _aggregate_widget(
    widget_type: str, module: Module, dimension: Field
) -> dict[str, object]:
    return {
        "widget_type": widget_type,
        "config": {
            "version": 1,
            "query": {
                "module_id": str(module.id),
                "definition": {"version": 1, "columns": []},
                "mode": "groups",
                "dimension": {"field_id": str(dimension.id), "expected_type": "text"},
                "aggregation": "count",
            },
        },
    }


def _records_widget(module: Module, field: Field) -> dict[str, object]:
    return {
        "widget_type": "records",
        "config": {
            "version": 1,
            "query": {
                "module_id": str(module.id),
                "definition": {
                    "version": 1,
                    "columns": [
                        {"field_id": str(field.id), "expected_type": "text"},
                    ],
                },
            },
        },
    }


def _dashboard_audit_rows(db: Session, dashboard_id: UUID) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.entity_type == "dashboards", AuditLog.entity_id == dashboard_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


def test_owner_can_create_page_revision_update_archive_and_restore_dashboard_draft(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    module, dimension = _module(db)
    set_audit_actor(db, owner.id)

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={"name": "  Operations  ", "widgets": [_chart(module, dimension)]},
        )
        assert created.status_code == 201
        assert created.headers["cache-control"] == "private, no-store"
        dashboard_id = UUID(created.json()["id"])
        assert created.headers["location"] == f"/api/dashboards/{dashboard_id}"
        assert created.json()["name"] == "Operations"
        assert created.json()["refresh_cadence"] == "manual"
        assert created.json()["owner_id"] == str(owner.id)
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
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    module, dimension = _module(db, name="Live Dashboard widgets")
    set_audit_actor(db, owner.id)
    widgets = [
        _aggregate_widget("summary", module, dimension),
        _aggregate_widget("workload", module, dimension),
        _records_widget(module, dimension),
        _chart(module, dimension),
    ]

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={
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
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    module, dimension = _module(db, name="Dashboard widget type change")
    set_audit_actor(db, owner.id)
    summary = _aggregate_widget("summary", module, dimension)
    workload = _aggregate_widget("workload", module, dimension)

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={"name": "Operations", "widgets": [summary]},
        )
        assert created.status_code == 201, created.text
        dashboard_id = UUID(created.json()["id"])
        changed = client.patch(
            f"/api/dashboards/{dashboard_id}",
            json={"revision": 1, "widgets": [workload]},
        )

    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 2
    assert [widget["widget_type"] for widget in changed.json()["widgets"]] == [
        "workload"
    ]


def test_dashboard_rejects_stale_record_widget_fields_without_saving(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    module, _ = _module(db, name="Dashboard records query")
    deleted_field = Field(
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
                "name": "Invalid list",
                "widgets": [_records_widget(module, deleted_field)],
            },
        )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dashboard_invalid"
    assert db.scalar(select(Dashboard).where(Dashboard.owner_id == owner.id)) is None


def test_dashboard_rejects_unknown_widget_type_and_refresh_cadence(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    set_audit_actor(db, owner.id)
    with _client(db, owner) as client:
        invalid_widget = client.post(
            "/api/dashboards",
            json={
                "name": "Unknown widget",
                "widgets": [{"widget_type": "table", "config": {}}],
            },
        )
        invalid_cadence = client.post(
            "/api/dashboards",
            json={"name": "Unknown cadence", "refresh_cadence": "hourly"},
        )
        assert invalid_widget.status_code == 422
        assert invalid_cadence.status_code == 422
    assert db.scalar(select(Dashboard).where(Dashboard.owner_id == owner.id)) is None


def test_dashboard_owner_scope_hides_foreign_artifacts_from_users_and_admins(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    permissions = {"records.read": True, "records.write": True}
    owner = _actor(db, capabilities=permissions)
    dashboard = Dashboard(owner_id=owner.id, name="Private dashboard")
    db.add(dashboard)
    db.flush()

    outsider = _actor(db, capabilities=permissions)
    admin = _actor(db, role="admin")

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
        assert client.get(f"/api/dashboards/{dashboard.id}").status_code == 404
        assert client.get("/api/dashboards").json()["pagination"]["total"] == 0

    persisted = db.get(Dashboard, dashboard.id)
    assert persisted is not None and persisted.name == "Private dashboard"


def test_dashboard_routes_let_a_guest_read_but_not_write(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    reader = _actor(db, capabilities={"records.read": True})
    writer = _actor(db, capabilities={"records.write": True})
    set_audit_actor(db, reader.id)

    with _client(db, reader) as read_client, _client(db, writer) as write_client:
        assert read_client.get("/api/dashboards").status_code == 200
        assert read_client.post("/api/dashboards", json={"name": "Denied"}).status_code == 403
        assert write_client.get("/api/dashboards").status_code == 200

        set_audit_actor(db, writer.id)
        created = write_client.post("/api/dashboards", json={"name": "Writer dashboard"})
        assert created.status_code == 201
        assert created.json()["owner_id"] == str(writer.id)


def test_dashboard_list_uses_bounded_offset_pagination(integration_owner_db: Session) -> None:
    db = integration_owner_db
    owner = _actor(db, capabilities={"records.read": True})
    set_audit_actor(db, owner.id)
    db.add_all(
        [
            Dashboard(owner_id=owner.id, name=name)
            for name in ("Charlie", "Alpha", "Bravo")
        ]
    )
    db.flush()

    with _client(db, owner) as client:
        first_page = client.get("/api/dashboards?limit=2&offset=0")
        second_page = client.get("/api/dashboards?limit=2&offset=2")

    assert [item["name"] for item in first_page.json()["items"]] == ["Alpha", "Bravo"]
    assert first_page.json()["pagination"]["has_more"] is True
    assert [item["name"] for item in second_page.json()["items"]] == ["Charlie"]
    assert second_page.json()["pagination"] == {
        "limit": 2,
        "offset": 2,
        "count": 1,
        "total": 3,
        "has_more": False,
    }


def test_invalid_field_reference_rejects_full_widget_replacement_without_partial_changes(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    module, active_dimension = _module(db, name="Atomic dashboard")
    deleted_dimension = Field(
        module_id=module.id,
        name="Deleted status",
        type=FieldType.TEXT,
        required=False,
        position=1,
        config={},
    )
    db.add(deleted_dimension)
    db.flush()
    deleted_dimension.is_deleted = True
    deleted_dimension.deleted_at = datetime.now(UTC)
    dashboard = Dashboard(owner_id=owner.id, name="Saved dashboard")
    db.add(dashboard)
    db.flush()
    existing = DashboardWidget(
        dashboard_id=dashboard.id,
        position=0,
        widget_type="chart",
        config={
            "version": 1,
            "chart_type": "bar",
            "query": {
                "module_id": str(module.id),
                "definition": {"version": 1, "columns": []},
                "mode": "groups",
                "dimension": {"field_id": str(active_dimension.id), "expected_type": "text"},
                "aggregation": "count",
            },
        },
    )
    db.add(existing)
    db.flush()
    set_audit_actor(db, owner.id)
    audit_ids_before = {
        row.id for row in _dashboard_audit_rows(db, dashboard.id)
    }

    replacement = _chart(module, active_dimension)
    invalid = _chart(module, deleted_dimension)
    with _client(db, owner) as client:
        response = client.patch(
            f"/api/dashboards/{dashboard.id}",
            json={"revision": 1, "widgets": [replacement, invalid]},
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dashboard_invalid"
    persisted = db.get(Dashboard, dashboard.id)
    assert persisted is not None and persisted.revision == 1
    assert {row.id for row in _dashboard_audit_rows(db, dashboard.id)} == audit_ids_before
    active_widgets = list(
        db.scalars(
            select(DashboardWidget).where(
                DashboardWidget.dashboard_id == dashboard.id,
                DashboardWidget.is_deleted.is_(False),
            )
        ).all()
    )
    assert [widget.id for widget in active_widgets] == [existing.id]


def test_replacing_dashboard_widget_removes_module_purge_blocker_and_preserves_other_widget(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, capabilities={"records.read": True, "records.write": True})
    module_a, dimension_a = _module(db, name="Widget source A")
    module_b, dimension_b = _module(db, name="Widget source B")
    set_audit_actor(db, owner.id)
    dashboard = Dashboard(owner_id=owner.id, name="Module-owned charts")
    db.add(dashboard)
    db.flush()
    untouched = DashboardWidget(
        dashboard_id=dashboard.id,
        position=0,
        widget_type="chart",
        config=_chart_config(module_b, dimension_b),
    )
    removed = DashboardWidget(
        dashboard_id=dashboard.id,
        position=1,
        widget_type="chart",
        config=_chart_config(module_a, dimension_a),
    )
    db.add_all([untouched, removed])
    db.flush()
    closed_at = datetime.now(UTC)
    module_a.is_deleted = True
    module_a.deleted_at = closed_at
    dimension_a.is_deleted = True
    dimension_a.deleted_at = closed_at
    db.flush()

    before = plan_lifecycle(db, LifecycleTargetType.MODULE, module_a.id, "purge", None)
    assert any(
        blocker.code is LifecycleBlockerCode.PURGE_DASHBOARD_DEPENDENCY
        and blocker.entity_id == removed.id
        for blocker in before.blockers
    )

    with _client(db, owner) as client:
        response = client.patch(
            f"/api/dashboards/{dashboard.id}",
            json={"revision": 1, "widgets": [_chart(module_b, dimension_b)]},
        )

    assert response.status_code == 200
    assert response.json()["revision"] == 2
    remaining_rows = list(db.scalars(select(DashboardWidget)).all())
    module_a_rows = [
        widget
        for widget in remaining_rows
        if widget.config["query"]["module_id"] == str(module_a.id)
    ]
    assert module_a_rows == []
    assert len(remaining_rows) == 1
    assert remaining_rows[0].id == untouched.id
    assert remaining_rows[0].config["query"]["module_id"] == str(module_b.id)

    deleted_audit = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "dashboard_widgets",
            AuditLog.entity_id == removed.id,
            AuditLog.action == AuditAction.DELETE,
        )
    )
    assert deleted_audit is not None
    assert deleted_audit.performed_by == owner.id

    after = plan_lifecycle(db, LifecycleTargetType.MODULE, module_a.id, "purge", None)
    assert not any(
        blocker.code is LifecycleBlockerCode.PURGE_DASHBOARD_DEPENDENCY
        for blocker in after.blockers
    )
