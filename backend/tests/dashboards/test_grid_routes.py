"""The 4 x 5 Dashboard grid, linked sources and the department home through the routes."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.audit.context import set_audit_actor
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.dashboards.dashboard_route_support import (
    _actor,
    _aggregate_widget,
    _chart,
    _client,
    _department,
    _module,
    _records_widget,
)

pytestmark = pytest.mark.integration


def _link(db: Session, source: Module, target: Module, *, deleted: bool = False) -> Field:
    taken = db.scalars(select(Field.position).where(Field.module_id == source.id)).all()
    field = Field(
        org_id=source.org_id,
        module_id=source.id,
        name=f"Link {uuid7().hex}",
        type=FieldType.RELATIONSHIP,
        required=False,
        position=max(taken, default=0) + 1,
        config={},
        relationship_target_module_id=target.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
        is_deleted=deleted,
        deleted_at=datetime.now(UTC) if deleted else None,
    )
    db.add(field)
    db.flush()
    return field


def _widgets(db: Session, dashboard_id: UUID) -> list[DashboardWidget]:
    db.expire_all()
    return list(
        db.scalars(
            select(DashboardWidget)
            .where(DashboardWidget.dashboard_id == dashboard_id)
            .order_by(DashboardWidget.position)
        ).all()
    )


def test_grid_placement_is_saved_and_each_broken_rule_is_refused_without_saving(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    module, dimension = _module(db, name="Grid rules")
    set_audit_actor(db, owner.id)
    layout = [
        _chart(module, dimension, (0, 0, 2, 2)),
        _records_widget(module, dimension, (2, 0, 2, 3)),
    ]

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={
                "department_id": str(module.department_id),
                "name": "Grid",
                "widgets": layout,
            },
        )
        assert created.status_code == 201, created.text
        dashboard_id = created.json()["id"]
        assert [
            (
                widget["position"],
                widget["grid_column"],
                widget["grid_row"],
                widget["column_span"],
                widget["row_span"],
            )
            for widget in created.json()["widgets"]
        ] == [(0, 0, 0, 2, 2), (1, 2, 0, 2, 3)]
        assert "size" not in created.json()["widgets"][0]

        refusals = {
            "overlap": [
                _chart(module, dimension, (0, 0, 2, 2)),
                _records_widget(module, dimension, (1, 1, 2, 2)),
            ],
            "outside_grid": [_records_widget(module, dimension, (3, 0, 2, 2))],
            "size_not_allowed": [_chart(module, dimension, (0, 0, 4, 2), chart_type="pie")],
            "number_size": [_aggregate_widget("summary", module, dimension, (0, 0, 2, 2))],
        }
        responses = {
            name: client.patch(
                f"/api/dashboards/{dashboard_id}", json={"revision": 1, "widgets": widgets}
            )
            for name, widgets in refusals.items()
        }

    assert {name: response.status_code for name, response in responses.items()} == {
        "overlap": 422,
        "outside_grid": 422,
        "size_not_allowed": 422,
        "number_size": 422,
    }
    assert responses["overlap"].json()["detail"] == {
        "code": "dashboard_layout_invalid",
        "message": "The dashboard layout does not fit the grid",
        "errors": [{"index": 1, "code": "overlap", "message": "This widget overlaps widget 1"}],
    }
    assert responses["outside_grid"].json()["detail"]["errors"] == [
        {
            "index": 0,
            "code": "outside_grid",
            "message": "This widget does not fit inside the 4 × 5 grid",
        }
    ]
    assert responses["size_not_allowed"].json()["detail"]["errors"] == [
        {
            "index": 0,
            "code": "size_not_allowed",
            "message": "A pie chart must be 2 × 2 to 3 × 3 (columns × rows)",
        }
    ]
    assert responses["number_size"].json()["detail"]["errors"] == [
        {
            "index": 0,
            "code": "size_not_allowed",
            "message": "A number must be 1 × 1 to 2 × 1 (columns × rows)",
        }
    ]
    persisted = db.get(Dashboard, UUID(dashboard_id))
    assert persisted is not None and persisted.revision == 1
    assert [
        (row.grid_column, row.grid_row, row.column_span, row.row_span)
        for row in _widgets(db, UUID(dashboard_id))
    ] == [(0, 0, 2, 2), (2, 0, 2, 3)]


def test_a_full_grid_holds_twenty_widgets_past_the_old_twelve_widget_limit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    module, dimension = _module(db, name="Full grid")
    set_audit_actor(db, owner.id)
    numbers = [
        _aggregate_widget("summary", module, dimension, (column, row, 1, 1))
        for row in range(5)
        for column in range(4)
    ]

    with _client(db, owner) as client:
        created = client.post(
            "/api/dashboards",
            json={"department_id": str(module.department_id), "name": "Numbers", "widgets": []},
        )
        filled = client.patch(
            f"/api/dashboards/{created.json()['id']}", json={"revision": 1, "widgets": numbers}
        )

    assert filled.status_code == 200, filled.text
    assert len(filled.json()["widgets"]) == 20
    assert filled.json()["widgets"][19]["position"] == 19
    assert len(_widgets(db, UUID(created.json()["id"]))) == 20


def test_widgets_read_linked_modules_in_either_direction_and_the_manager_must_read_them(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager = _actor(db)
    home, home_field = _module(db, name="Sales orders")
    outgoing, outgoing_field = _module(db, name="Finance invoices")
    incoming, incoming_field = _module(db, name="Support tickets")
    unlinked, unlinked_field = _module(db, name="Unlinked stock")
    hidden_department = Department(
        org_id=home.org_id, department_name=f"Hidden {uuid7().hex}"
    )
    db.add(hidden_department)
    db.flush()
    hidden, hidden_field = _module(db, name="Hidden payroll", department=hidden_department)
    _link(db, home, outgoing)
    _link(db, incoming, home)
    _link(db, home, unlinked, deleted=True)
    _link(db, home, hidden)
    set_audit_actor(db, manager.id)
    department_id = str(home.department_id)

    with _client(db, manager) as client:
        allowed = client.post(
            "/api/dashboards",
            json={
                "department_id": department_id,
                "name": "Sales",
                "widgets": [
                    _chart(home, home_field, (0, 0, 2, 2)),
                    _chart(outgoing, outgoing_field, (2, 0, 2, 2)),
                    _records_widget(incoming, incoming_field, (0, 2, 4, 3)),
                ],
            },
        )
        unlinked_refusal = client.post(
            "/api/dashboards",
            json={
                "department_id": department_id,
                "name": "Unlinked",
                "widgets": [_chart(unlinked, unlinked_field)],
            },
        )
        hidden_refusal = client.post(
            "/api/dashboards",
            json={
                "department_id": department_id,
                "name": "Hidden",
                "widgets": [_chart(hidden, hidden_field)],
            },
        )

    assert allowed.status_code == 201, allowed.text
    assert [
        widget["config"]["query"]["module_id"] for widget in allowed.json()["widgets"]
    ] == [str(home.id), str(outgoing.id), str(incoming.id)]
    assert unlinked_refusal.status_code == 409
    assert unlinked_refusal.json()["detail"]["code"] == "dashboard_invalid"
    assert hidden_refusal.status_code == 404
    names = set(
        db.scalars(select(Dashboard.name).where(Dashboard.department_id == home.department_id))
    )
    assert names == {"Sales"}


def test_one_active_home_per_department_moves_to_the_next_dashboard_on_archive(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db)
    department = _department(db, "Home rules")
    set_audit_actor(db, owner.id)

    def body(name: str, position: int) -> dict[str, object]:
        return {"department_id": str(department.id), "name": name, "position": position}

    with _client(db, owner) as client:
        first = client.post("/api/dashboards", json=body("First", 0)).json()
        third = client.post("/api/dashboards", json=body("Third", 2)).json()
        second = client.post("/api/dashboards", json=body("Second", 1)).json()
        assert [first["is_home"], third["is_home"], second["is_home"]] == [True, False, False]

        listed = {
            flag: [
                item["name"]
                for item in client.get(
                    "/api/dashboards",
                    params={"department_id": str(department.id), "home": flag},
                ).json()["items"]
            ]
            for flag in ("true", "false")
        }
        assert listed == {"true": ["First"], "false": ["Second", "Third"]}

        assert client.delete(f"/api/dashboards/{first['id']}?revision=1").status_code == 204
        promoted = client.get(f"/api/dashboards/{second['id']}").json()
        archived = client.get(f"/api/dashboards/{first['id']}").json()
        assert (promoted["is_home"], promoted["revision"]) == (True, 1)
        assert (archived["is_home"], archived["is_deleted"]) == (False, True)

        restored = client.post(f"/api/dashboards/{first['id']}/restore", json={"revision": 2})
        assert restored.status_code == 200
        assert restored.json()["is_home"] is False

        for dashboard, revision in ((second, 1), (third, 1), (first, 3)):
            archive = client.delete(f"/api/dashboards/{dashboard['id']}?revision={revision}")
            assert archive.status_code == 204
        homes = client.get(
            "/api/dashboards",
            params={"department_id": str(department.id), "home": "true", "deleted": "include"},
        ).json()["items"]
        assert homes == []

        back = client.post(f"/api/dashboards/{third['id']}/restore", json={"revision": 2})
        assert back.status_code == 200
        assert back.json()["is_home"] is True

    db.expire_all()
    homes_by_name = {
        row.name: row.is_home
        for row in db.scalars(select(Dashboard).where(Dashboard.department_id == department.id))
    }
    assert homes_by_name == {"First": False, "Second": False, "Third": True}


def test_the_database_refuses_a_second_active_home_in_one_department(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = _department(db, "Home index")
    db.add_all(
        [
            Dashboard(
                org_id=department.org_id, department_id=department.id, name="Archived home",
                is_home=True, is_deleted=True, deleted_at=datetime.now(UTC),
            ),
            Dashboard(
                org_id=department.org_id, department_id=department.id, name="Home", is_home=True
            ),
        ]
    )
    db.flush()

    savepoint = db.begin_nested()
    db.add(
        Dashboard(
            org_id=department.org_id, department_id=department.id, name="Rival", is_home=True
        )
    )
    with pytest.raises(IntegrityError) as caught:
        db.flush()
    savepoint.rollback()
    assert caught.value.orig.diag.constraint_name == "uq_dashboards_department_home"
