"""Archive and restore contracts that the OpenView frontend calls.

Every route checks the revision before the archived state, so a repeated archive
or a restore of an active item must send the current revision to reach the
``*_archived`` or ``*_not_archived`` conflict.
"""

from dataclasses import dataclass
from uuid import UUID

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.dashboards.router import router as dashboards_router
from app.systems.openview.reports.router import router as reports_router
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
    db.commit()  # Routes may roll back to the last savepoint on refusal.
    return _Area(department, module, field)


def _member(db: Session, area: _Area, level: str) -> User:
    member = add_user(db, f"ov-life-{level}", role=UserRole.MEMBER)
    make_group_access(db, [member], area.department, level=level)
    db.commit()
    return member


def _client(db: Session, actor: User, *routers: APIRouter) -> TestClient:
    app = FastAPI()
    for router in routers:
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return with_live_session(TestClient(app), db, actor)


def _view_payload(area: _Area, name: str, *, is_default: bool = False) -> dict[str, object]:
    return {
        "module_id": str(area.module.id),
        "name": name,
        "definition": {
            "version": 1,
            "columns": [{"field_id": str(area.field.id), "expected_type": "text"}],
        },
        "is_default": is_default,
    }


def _create_view(client: TestClient, area: _Area, *, is_default: bool = False) -> dict[str, object]:
    created = client.post("/api/views", json=_view_payload(area, "All", is_default=is_default))
    assert created.status_code == 201, created.text
    body: dict[str, object] = created.json()
    assert body["revision"] == 1
    return body


def _conflict_code(response: Response) -> str:
    assert response.status_code == 409, response.text
    code: str = response.json()["detail"]["code"]
    return code


def test_manager_archives_default_view_and_restores_it_as_non_default(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    area = _area(db)
    manager = _member(db, area, AccessLevel.MANAGE)
    set_audit_actor(db, manager.id)
    client = _client(db, manager, views_router)
    view = _create_view(client, area, is_default=True)
    assert view["is_default"] is True
    view_id = UUID(str(view["id"]))

    archived = client.delete(f"/api/views/{view_id}", params={"revision": 1})

    assert archived.status_code == 204, archived.text
    assert archived.content == b""
    listed = client.get("/api/views", params={"module_id": str(area.module.id)})
    assert listed.status_code == 200
    assert listed.json()["items"] == []
    reread = client.get(f"/api/views/{view_id}").json()
    assert reread["is_deleted"] is True
    assert reread["is_default"] is False
    assert reread["revision"] == 2
    defaults = db.scalars(
        select(SavedView.id).where(
            SavedView.module_id == area.module.id, SavedView.is_default.is_(True)
        )
    ).all()
    assert defaults == []

    restored = client.post(f"/api/views/{view_id}/restore", json={"revision": 2})

    assert restored.status_code == 200, restored.text
    body = restored.json()
    assert body["id"] == str(view_id)
    assert body["is_deleted"] is False
    assert body["is_default"] is False
    assert body["revision"] == 3
    listed_again = client.get("/api/views", params={"module_id": str(area.module.id)}).json()
    assert [item["id"] for item in listed_again["items"]] == [str(view_id)]
    audit = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity_type == "saved_views", AuditLog.entity_id == view_id)
        .order_by(AuditLog.created_at, AuditLog.id)
    ).all()
    assert [entry.action for entry in audit] == [
        AuditAction.CREATE,
        AuditAction.DELETE,
        AuditAction.UPDATE,
    ]
    assert all(entry.performed_by == manager.id for entry in audit)


def test_view_archive_and_restore_reject_repeat_and_stale_revisions(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _member(db, area, AccessLevel.MANAGE), views_router)
    view_id = _create_view(client, area)["id"]
    path = f"/api/views/{view_id}"

    not_archived = client.post(f"{path}/restore", json={"revision": 1})
    assert _conflict_code(not_archived) == "view_not_archived"
    stale_archive = client.delete(path, params={"revision": 5})
    assert _conflict_code(stale_archive) == "stale_revision"
    assert stale_archive.json()["detail"]["current_revision"] == 1

    assert client.delete(path, params={"revision": 1}).status_code == 204
    archived_again = client.delete(path, params={"revision": 2})
    assert _conflict_code(archived_again) == "view_archived"
    stale_restore = client.post(f"{path}/restore", json={"revision": 1})
    assert _conflict_code(stale_restore) == "stale_revision"
    assert stale_restore.json()["detail"]["current_revision"] == 2

    reread = client.get(path).json()
    assert reread["is_deleted"] is True
    assert reread["revision"] == 2


def test_dashboard_rejects_repeat_archive_and_restore_of_active_dashboard(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _member(db, area, AccessLevel.MANAGE), dashboards_router)
    created = client.post(
        "/api/dashboards",
        json={"department_id": str(area.department.id), "name": "Stock Overview"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["revision"] == 1
    path = f"/api/dashboards/{created.json()['id']}"

    not_archived = client.post(f"{path}/restore", json={"revision": 1})
    assert _conflict_code(not_archived) == "dashboard_not_archived"

    assert client.delete(path, params={"revision": 1}).status_code == 204
    archived_again = client.delete(path, params={"revision": 2})
    assert _conflict_code(archived_again) == "dashboard_archived"

    reread = client.get(path).json()
    assert reread["is_deleted"] is True
    assert reread["revision"] == 2


def test_report_rejects_restore_of_active_report_and_repeat_archive(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    area = _area(db)
    client = _client(db, _member(db, area, AccessLevel.MANAGE), reports_router)
    created = client.post(
        "/api/reports",
        json={
            "module_id": str(area.module.id),
            "name": "Month-end stock",
            "recipe": {
                "version": 1,
                "fields": [{"field_id": str(area.field.id), "expected_type": "text"}],
            },
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["revision"] == 1
    path = f"/api/reports/{created.json()['id']}"

    not_archived = client.post(f"{path}/restore", json={"revision": 1})
    assert _conflict_code(not_archived) == "report_not_archived"

    assert client.delete(path, params={"revision": 1}).status_code == 204
    archived_again = client.delete(path, params={"revision": 2})
    assert _conflict_code(archived_again) == "report_archived"

    reread = client.get(path).json()
    assert reread["is_deleted"] is True
    assert reread["revision"] == 2


def test_module_reader_cannot_restore_an_archived_view(integration_owner_db: Session) -> None:
    db = integration_owner_db
    area = _area(db)
    manager = _client(db, _member(db, area, AccessLevel.MANAGE), views_router)
    view_id = _create_view(manager, area)["id"]
    assert manager.delete(f"/api/views/{view_id}", params={"revision": 1}).status_code == 204
    reader = _client(db, _member(db, area, AccessLevel.READ), views_router)

    denied = reader.post(f"/api/views/{view_id}/restore", json={"revision": 2})

    assert denied.status_code == 403
    # The access check raises a plain-string detail, not a {code, message} object.
    assert denied.json()["detail"] == "Forbidden"
    reread = manager.get(f"/api/views/{view_id}").json()
    assert reread["is_deleted"] is True
    assert reread["revision"] == 2
