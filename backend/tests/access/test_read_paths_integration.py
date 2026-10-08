"""Every read path takes its filter from the access function (slice 3c).

Each path gets one case for a member in no group, who sees nothing, and one
case for a guest, who can read but never write.
"""

from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.auth.router import auth_router
from app.systems.access.policy.models import AccessLevel, GroupAccess
from app.systems.access.policy.schemas import GroupAccessEntry, GroupCreate
from app.systems.access.policy.service import create_group, group_etag, replace_group_access
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.router import router as workspace_router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.departments.router import router as departments_router
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.fields.router import router as fields_router
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.modules.router import router as modules_router
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_router import router as query_router
from app.systems.sandbox.records.router import router as records_router
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


@dataclass
class _World:
    db: Session
    department: Department
    module: Module
    field: Field
    record: Record
    admin: User
    reader: User
    no_group: User
    guest: User
    actor: list[User]

    def client(self, user: User) -> TestClient:
        self.actor[:] = [user]
        set_audit_actor(self.db, user.id)
        return self._client

    _client: TestClient


@pytest.fixture
def world(integration_owner_db: Session) -> Iterator[_World]:
    db = integration_owner_db
    department = add_department(db)
    module = add_module(db, department)
    field = Field(
        module_id=module.id,
        name="Label",
        type=FieldType.TEXT,
        position=0,
        required=False,
        config={},
    )
    db.add(field)
    db.flush()
    record = Record(module_id=module.id, data={str(field.id): "visible"})
    db.add(record)
    admin = add_user(db, "paths-admin", role=UserRole.ADMIN)
    reader = add_user(db, "paths-reader")
    no_group = add_user(db, "paths-no-group")
    guest = add_user(db, "paths-guest", role=UserRole.GUEST)
    make_group_access(db, [reader], department, module, level=AccessLevel.WRITE)
    # A write row still gives a guest only read.
    make_group_access(db, [guest], department, module, level=AccessLevel.WRITE)
    db.flush()

    actor: list[User] = []
    app = FastAPI()
    for router in (
        records_router,
        query_router,
        departments_router,
        modules_router,
        fields_router,
        workspace_router,
        auth_router,
    ):
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor[0]
    with TestClient(app) as client:
        yield _World(
            db=db,
            department=department,
            module=module,
            field=field,
            record=record,
            admin=admin,
            reader=reader,
            no_group=no_group,
            guest=guest,
            actor=actor,
            _client=client,
        )


def _record_payload(world: _World, value: str) -> dict[str, object]:
    return {"module_id": str(world.module.id), "data": {str(world.field.id): value}}


def _query(world: _World) -> dict[str, object]:
    return {"module_id": str(world.module.id), "definition": {}}


# Records router


def test_records_are_hidden_from_a_member_in_no_group(world: _World) -> None:
    client = world.client(world.no_group)
    listed = client.get("/api/records", params={"module_id": str(world.module.id)})
    assert listed.status_code == 200
    assert listed.json()["pagination"]["total"] == 0
    assert client.get(f"/api/records/{world.record.id}").status_code == 404
    assert client.post("/api/records", json=_record_payload(world, "new")).status_code == 404
    patched = client.patch(
        f"/api/records/{world.record.id}", json={"data": {str(world.field.id): "changed"}}
    )
    assert patched.status_code == 404

    reader = world.client(world.reader)
    assert reader.get(f"/api/records/{world.record.id}").status_code == 200
    assert reader.post("/api/records", json=_record_payload(world, "new")).status_code == 201


def test_a_guest_reads_records_but_cannot_write_them(world: _World) -> None:
    client = world.client(world.guest)
    assert client.get(f"/api/records/{world.record.id}").status_code == 200
    assert client.post("/api/records", json=_record_payload(world, "new")).status_code == 403
    patched = client.patch(
        f"/api/records/{world.record.id}", json={"data": {str(world.field.id): "changed"}}
    )
    assert patched.status_code == 403
    assert client.delete(f"/api/records/{world.record.id}").status_code == 403
    world.db.refresh(world.record)
    assert world.record.data == {str(world.field.id): "visible"}


# Query compiler endpoints


def test_query_endpoints_hide_the_module_from_a_member_in_no_group(world: _World) -> None:
    client = world.client(world.no_group)
    assert client.post("/api/records/query", json=_query(world)).status_code == 404
    reader = world.client(world.reader)
    result = reader.post("/api/records/query", json=_query(world))
    assert result.status_code == 200
    assert [item["id"] for item in result.json()["items"]] == [str(world.record.id)]


def test_a_guest_queries_readable_records(world: _World) -> None:
    client = world.client(world.guest)
    assert client.post("/api/records/query", json=_query(world)).status_code == 200
    # D12 export success/denial uses committed data and real Auth in test_export_http.py.


# Department, module and field reads


def test_catalog_reads_hide_departments_modules_and_fields_without_a_group(
    world: _World,
) -> None:
    client = world.client(world.no_group)
    for path, key in (
        (f"/api/departments/{world.department.id}", "departments"),
        (f"/api/modules/{world.module.id}", "modules"),
        (f"/api/fields/{world.field.id}", "fields"),
    ):
        assert client.get(path).status_code == 404, key
    listed = client.get("/api/modules", params={"department_id": str(world.department.id)})
    assert listed.status_code == 200
    assert listed.json()["pagination"]["total"] == 0
    fields = client.get("/api/fields", params={"module_id": str(world.module.id)})
    assert fields.status_code == 200
    assert fields.json()["pagination"]["total"] == 0
    departments = client.get("/api/departments", params={"limit": 100})
    assert str(world.department.id) not in {item["id"] for item in departments.json()["items"]}

    guest = world.client(world.guest)
    assert guest.get(f"/api/departments/{world.department.id}").status_code == 200
    assert guest.get(f"/api/modules/{world.module.id}").status_code == 200
    assert guest.get(f"/api/fields/{world.field.id}").status_code == 200


# /auth/me


def test_auth_me_returns_role_and_compact_access_without_permissions(world: _World) -> None:
    reader = world.client(world.reader).get("/api/auth/me")
    assert reader.status_code == 200
    body = reader.json()
    assert body["role"] == "member"
    assert "permissions" not in body and "role_id" not in body
    assert body["access"] == [
        {
            "department_id": str(world.department.id),
            "module_id": str(world.module.id),
            "level": "write",
        }
    ]
    guest = world.client(world.guest).get("/api/auth/me").json()
    assert guest["role"] == "guest"
    assert [entry["level"] for entry in guest["access"]] == ["read"]
    assert world.client(world.no_group).get("/api/auth/me").json()["access"] == []
    admin = world.client(world.admin).get("/api/auth/me").json()
    assert admin["role"] == "admin" and admin["access"] == []


# Group access replacement


def test_group_access_replacement_checks_the_etag_and_the_department_rule(
    world: _World,
) -> None:
    db = world.db
    group = create_group(db, GroupCreate(name=f"Replace {uuid7().hex}"), world.admin.id)
    other_department = add_department(db)
    entry = GroupAccessEntry(
        department_id=world.department.id, module_id=world.module.id, level=AccessLevel.READ
    )

    with pytest.raises(HTTPException) as missing:
        replace_group_access(db, group.id, [entry], None, world.admin.id)
    assert missing.value.status_code == 428
    with pytest.raises(HTTPException) as stale:
        replace_group_access(db, group.id, [entry], '"stale"', world.admin.id)
    assert stale.value.status_code == 412
    outside = GroupAccessEntry(
        department_id=other_department.id, module_id=world.module.id, level=AccessLevel.READ
    )
    with pytest.raises(HTTPException) as wrong_department:
        replace_group_access(db, group.id, [outside], group_etag(group), world.admin.id)
    assert wrong_department.value.status_code == 409
    with pytest.raises(HTTPException) as duplicate:
        replace_group_access(db, group.id, [entry, entry], group_etag(group), world.admin.id)
    assert duplicate.value.status_code == 422

    revision = group.revision
    replaced = replace_group_access(db, group.id, [entry], group_etag(group), world.admin.id)
    assert replaced.revision == revision + 1
    department_wide = GroupAccessEntry(department_id=world.department.id, level=AccessLevel.WRITE)
    replace_group_access(db, group.id, [department_wide], group_etag(replaced), world.admin.id)
    rows = db.scalars(
        select(GroupAccess).where(
            GroupAccess.group_id == group.id, GroupAccess.is_deleted.is_(False)
        )
    ).all()
    assert [(row.department_id, row.module_id, row.level) for row in rows] == [
        (world.department.id, None, "write")
    ]


# Invitation settings


def test_workspace_invitation_settings_are_administrator_only(world: _World) -> None:
    profile = world.db.scalar(select(WorkspaceProfile))
    assert profile is not None
    payload = {
        "revision": profile.revision,
        "invitation_expiry_days": 14,
        "guest_duration_days": 60,
    }

    assert (
        world.client(world.admin)
        .patch("/api/workspace", json={**payload, "guest_duration_days": 366})
        .status_code
        == 422
    )
    updated = world.client(world.admin).patch("/api/workspace", json=payload)
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert (body["invitation_expiry_days"], body["guest_duration_days"]) == (14, 60)
    # A refusal rolls the test transaction back, so it runs last.
    stale = {**payload, "revision": body["revision"]}
    assert world.client(world.reader).patch("/api/workspace", json=stale).status_code == 403
