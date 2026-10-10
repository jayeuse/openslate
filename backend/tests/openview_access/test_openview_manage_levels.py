"""OpenView content belongs to departments: readers read it, managers change it.

These route tests close the interim widening from the access slice: a member with
no group, with ``read`` or with ``write``, and a guest in a ``manage`` group, can
never create, change or delete Dashboards, Views, Reports or schedules.
"""

from dataclasses import dataclass
from uuid import UUID

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.openview.dashboards.router import router as dashboards_router
from app.systems.openview.reports.router import router as reports_router
from app.systems.openview.reports.schedule_router import router as schedule_router
from app.systems.openview.views.models import SavedView
from app.systems.openview.views.router import router as views_router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.live_session_support import with_live_session
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


@dataclass(frozen=True)
class _Area:
    department: Department
    module: Module
    field: Field


def _area(db: Session) -> _Area:
    department = add_department(db)
    module = add_module(db, department)
    field = Field(
        module_id=module.id,
        name="Status",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    db.add(field)
    db.flush()
    return _Area(department, module, field)


def _actor(db: Session, area: _Area, kind: str) -> User:
    """Build one actor: ``none`` has no group; a level name gets that department level."""

    if kind == "admin":
        return add_user(db, "ov-admin", role=UserRole.ADMIN)
    if kind == "guest-manage":
        guest = add_user(db, "ov-guest", role=UserRole.GUEST)
        make_group_access(db, [guest], area.department, level=AccessLevel.MANAGE)
        return guest
    member = add_user(db, f"ov-{kind}", role=UserRole.MEMBER)
    if kind != "none":
        make_group_access(db, [member], area.department, level=kind)
    return member


def _client(db: Session, actor: User, *routers: APIRouter) -> TestClient:
    app = FastAPI()
    for router in routers:
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return with_live_session(TestClient(app), db, actor)


def _reference(field: Field) -> dict[str, str]:
    return {"field_id": str(field.id), "expected_type": "text"}


def _chart_widget(module: Module, field: Field) -> dict[str, object]:
    return {
        "widget_type": "chart",
        "config": {
            "version": 1,
            "chart_type": "bar",
            "query": {
                "module_id": str(module.id),
                "definition": {"version": 1, "columns": []},
                "mode": "groups",
                "dimension": _reference(field),
                "aggregation": "count",
            },
        },
    }


def _report_payload(area: _Area) -> dict[str, object]:
    return {
        "module_id": str(area.module.id),
        "name": "Month-end stock",
        "recipe": {"version": 1, "fields": [_reference(area.field)]},
    }


def _view_payload(area: _Area, name: str, *, is_default: bool = False) -> dict[str, object]:
    return {
        "module_id": str(area.module.id),
        "name": name,
        "definition": {"version": 1, "columns": [_reference(area.field)]},
        "is_default": is_default,
    }


DENIED = [("none", 404), ("read", 403), ("write", 403), ("guest-manage", 403)]
ALLOWED = ["manage", "admin"]


@pytest.mark.parametrize(("kind", "expected"), DENIED)
def test_only_department_managers_create_dashboards(
    integration_owner_db: Session, kind: str, expected: int
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, kind), dashboards_router)

    response = client.post(
        "/api/dashboards",
        json={"department_id": str(area.department.id), "name": "Stock Overview"},
    )

    assert response.status_code == expected


@pytest.mark.parametrize("kind", ALLOWED)
def test_managers_create_dashboards_in_their_department(
    integration_owner_db: Session, kind: str
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, kind), dashboards_router)

    response = client.post(
        "/api/dashboards",
        json={
            "department_id": str(area.department.id),
            "name": "Stock Overview",
            "position": 2,
            "widgets": [_chart_widget(area.module, area.field)],
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["department_id"] == str(area.department.id)
    assert body["position"] == 2
    assert "owner_id" not in body


def test_department_reader_sees_dashboards_and_cannot_change_them(
    integration_owner_db: Session,
) -> None:
    """S4-1 for Dashboards."""

    db = integration_owner_db
    area = _area(db)
    manager = _client(db, _actor(db, area, "manage"), dashboards_router)
    created = manager.post(
        "/api/dashboards",
        json={"department_id": str(area.department.id), "name": "Stock Overview"},
    ).json()
    reader = _client(db, _actor(db, area, "read"), dashboards_router)
    outsider = _client(db, _actor(db, _area(db), "manage"), dashboards_router)

    listed = reader.get("/api/dashboards", params={"department_id": str(area.department.id)})
    assert [item["id"] for item in listed.json()["items"]] == [created["id"]]
    assert reader.get(f"/api/dashboards/{created['id']}").status_code == 200
    changed = reader.patch(
        f"/api/dashboards/{created['id']}", json={"revision": 1, "name": "Changed"}
    )
    assert changed.status_code == 403
    archived = reader.delete(f"/api/dashboards/{created['id']}", params={"revision": 1})
    assert archived.status_code == 403
    assert outsider.get(f"/api/dashboards/{created['id']}").status_code == 404
    assert outsider.get("/api/dashboards").json()["items"] == []


def test_dashboard_widget_on_another_department_module_is_refused(
    integration_owner_db: Session,
) -> None:
    """S4-2: a manager of Inventory cannot place a Finance module on an Inventory Dashboard."""

    db = integration_owner_db
    inventory = _area(db)
    finance = _area(db)
    manager = _actor(db, inventory, "manage")
    make_group_access(db, [manager], finance.department, level=AccessLevel.MANAGE)
    client = _client(db, manager, dashboards_router)

    response = client.post(
        "/api/dashboards",
        json={
            "department_id": str(inventory.department.id),
            "name": "Mixed",
            "widgets": [_chart_widget(finance.module, finance.field)],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "dashboard_invalid"


def test_removed_dashboard_default_route_is_gone(integration_owner_db: Session) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, "admin"), dashboards_router)

    assert client.put("/api/dashboards/default", json={"dashboard_id": None}).status_code in {
        404,
        405,
        422,
    }


@pytest.mark.parametrize(("kind", "expected"), DENIED)
def test_only_module_managers_create_views(
    integration_owner_db: Session, kind: str, expected: int
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, kind), views_router)

    response = client.post("/api/views", json=_view_payload(area, "Low stock"))

    assert response.status_code == expected


def test_module_reader_sees_views_and_cannot_change_them(integration_owner_db: Session) -> None:
    """S4-1 for Views."""

    db = integration_owner_db
    area = _area(db)
    manager = _client(db, _actor(db, area, "manage"), views_router)
    created = manager.post("/api/views", json=_view_payload(area, "Low stock"))
    assert created.status_code == 201, created.text
    view = created.json()
    assert view["can_edit"] is True
    assert not {"owner_id", "visibility", "audience"} & set(view)
    reader = _client(db, _actor(db, area, "read"), views_router)

    listed = reader.get("/api/views", params={"module_id": str(area.module.id)}).json()
    assert [(item["id"], item["can_edit"]) for item in listed["items"]] == [(view["id"], False)]
    changed = reader.patch(f"/api/views/{view['id']}", json={"revision": 1, "name": "Mine"})
    assert changed.status_code == 403
    archived = reader.delete(f"/api/views/{view['id']}", params={"revision": 1})
    assert archived.status_code == 403


def test_making_a_view_the_default_clears_the_previous_default(
    integration_owner_db: Session,
) -> None:
    """S4-3."""

    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, "manage"), views_router)
    first = client.post("/api/views", json=_view_payload(area, "All", is_default=True)).json()
    second = client.post("/api/views", json=_view_payload(area, "Low stock")).json()
    assert first["is_default"] is True
    assert second["is_default"] is False

    promoted = client.patch(
        f"/api/views/{second['id']}", json={"revision": second["revision"], "is_default": True}
    )

    assert promoted.status_code == 200, promoted.text
    assert promoted.json()["is_default"] is True
    defaults = db.scalars(
        select(SavedView.id).where(
            SavedView.module_id == area.module.id, SavedView.is_default.is_(True)
        )
    ).all()
    assert defaults == [UUID(second["id"])]
    reread = client.get(f"/api/views/{first['id']}").json()
    assert reread["is_default"] is False
    assert reread["revision"] == first["revision"] + 1


def test_removed_view_audience_and_default_routes_are_gone(integration_owner_db: Session) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, "admin"), views_router)

    assert client.get("/api/views/audience-options", params={"kind": "user"}).status_code in {
        404,
        422,
    }
    assert client.get("/api/views/defaults").status_code in {404, 422}
    assert client.put(
        f"/api/views/defaults/{area.module.id}", json={"view_id": str(area.module.id)}
    ).status_code in {404, 405, 422}


@pytest.mark.parametrize(("kind", "expected"), DENIED)
def test_only_module_managers_create_reports(
    integration_owner_db: Session, kind: str, expected: int
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, kind), reports_router)

    response = client.post("/api/reports", json=_report_payload(area))

    assert response.status_code == expected


def test_module_reader_sees_reports_and_cannot_change_or_schedule_them(
    integration_owner_db: Session,
) -> None:
    """S4-1 for Reports and schedules."""

    db = integration_owner_db
    area = _area(db)
    manager = _client(db, _actor(db, area, "manage"), reports_router, schedule_router)
    created = manager.post("/api/reports", json=_report_payload(area))
    assert created.status_code == 201, created.text
    report = created.json()
    assert not {"owner_id", "audience"} & set(report)
    schedule = {"enabled": True, "cadence": "daily", "timezone_name": "UTC", "local_time": "06:00"}
    reader = _client(db, _actor(db, area, "read"), reports_router, schedule_router)
    writer = _client(db, _actor(db, area, "write"), reports_router, schedule_router)

    listed = reader.get("/api/reports", params={"module_id": str(area.module.id)}).json()
    assert [item["id"] for item in listed["items"]] == [report["id"]]
    for client in (reader, writer):
        changed = client.patch(
            f"/api/reports/{report['id']}", json={"revision": 1, "name": "Changed"}
        )
        assert changed.status_code == 403
        archived = client.delete(f"/api/reports/{report['id']}", params={"revision": 1})
        assert archived.status_code == 403
        denied = client.post(f"/api/reports/{report['id']}/schedule", json=schedule)
        assert denied.status_code == 403

    scheduled = manager.post(f"/api/reports/{report['id']}/schedule", json=schedule)
    assert scheduled.status_code == 201, scheduled.text
    assert reader.get(f"/api/reports/{report['id']}/schedule").status_code == 200
    disabled = writer.patch(
        f"/api/reports/{report['id']}/schedule", json={"revision": 1, "enabled": False}
    )
    assert disabled.status_code == 403


def test_removed_report_audience_route_is_gone(integration_owner_db: Session) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _actor(db, area, "admin"), reports_router)

    # The path now matches /api/reports/{report_id}, which rejects a non-UUID id.
    assert client.get("/api/reports/audience-users").status_code in {404, 422}
