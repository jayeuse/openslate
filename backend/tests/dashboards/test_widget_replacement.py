"""Department Dashboard route behavior on the runner-owned PostgreSQL database."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from tests.dashboards.dashboard_route_support import (
    _actor,
    _chart,
    _chart_config,
    _client,
    _dashboard_audit_rows,
    _department,
    _module,
)
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration


def test_dashboard_list_uses_bounded_offset_pagination(integration_owner_db: Session) -> None:
    db = integration_owner_db
    owner = _actor(db, level=AccessLevel.READ)
    department = _department(db)
    set_audit_actor(db, owner.id)
    db.add_all(
        [
            Dashboard(org_id=department.org_id,
                      department_id=department.id, name=name, position=position)
            for name, position in (("Charlie", 0), ("Alpha", 2), ("Bravo", 1))
        ]
    )
    db.flush()

    with _client(db, owner) as client:
        first_page = client.get("/api/dashboards?limit=2&offset=0&sort_by=name")
        second_page = client.get("/api/dashboards?limit=2&offset=2&sort_by=name")
        by_position = client.get("/api/dashboards")

    assert [item["name"] for item in by_position.json()["items"]] == [
        "Charlie",
        "Bravo",
        "Alpha",
    ]

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
    owner = _actor(db)
    module, active_dimension = _module(db, name="Atomic dashboard")
    deleted_dimension = Field(
        org_id=module.org_id,
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
    dashboard = Dashboard(org_id=module.org_id,
                          department_id=module.department_id, name="Saved dashboard")
    db.add(dashboard)
    db.flush()
    existing = DashboardWidget(
        org_id=dashboard.org_id,
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
    audit_ids_before = {row.id for row in _dashboard_audit_rows(db, dashboard.id)}

    replacement = _chart(module, active_dimension)
    invalid = _chart(module, deleted_dimension, (2, 0, 2, 2))
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
    create_document(db, organization(db))
    owner = _actor(db)
    module_a, dimension_a = _module(db, name="Widget source A")
    department = db.get(Department, module_a.department_id)
    module_b, dimension_b = _module(db, name="Widget source B", department=department)
    set_audit_actor(db, owner.id)
    dashboard = Dashboard(org_id=module_a.org_id,
                          department_id=module_a.department_id, name="Module-owned charts")
    db.add(dashboard)
    db.flush()
    untouched = DashboardWidget(
        org_id=dashboard.org_id,
        dashboard_id=dashboard.id,
        position=0,
        widget_type="chart",
        config=_chart_config(module_b, dimension_b),
        grid_column=0,
        grid_row=0,
        column_span=2,
        row_span=2,
    )
    removed = DashboardWidget(
        org_id=dashboard.org_id,
        dashboard_id=dashboard.id,
        position=1,
        widget_type="chart",
        config=_chart_config(module_a, dimension_a),
        grid_column=2,
        grid_row=0,
        column_span=2,
        row_span=2,
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
