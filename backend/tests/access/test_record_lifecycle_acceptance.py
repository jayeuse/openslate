"""Record delete, restore, links, and history under real access (OpenView record controls).

The catalog tests cover delete and restore state through an admin bypass. These
cases cover the same actions for each account role, the links that touch a
deleted record, the deleted-record query options, and record history.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.router import router as audit_router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_router import router as query_router
from app.systems.sandbox.records.router import router as records_router
from app.systems.sandbox.relationships.models import RelationshipEdge
from app.systems.sandbox.relationships.router import router as relationships_router
from tests.organization_scope_support import scoped_override
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


@dataclass
class _World:
    db: Session
    department: Department
    module: Module
    target_module: Module
    label: Field
    link: Field
    record: Record
    target: Record
    admin: User
    writer: User
    reader: User
    manager: User
    no_group: User
    guest: User
    actor: list[User]
    _client: TestClient

    def client(self, user: User) -> TestClient:
        self.actor[:] = [user]
        set_audit_actor(self.db, user.id)
        return self._client


@pytest.fixture
def world(integration_owner_db: Session) -> Iterator[_World]:
    db = integration_owner_db
    department = add_department(db)
    module = add_module(db, department)
    target_module = add_module(db, department)
    label = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Label",
        type=FieldType.TEXT,
        position=0,
        required=False,
        config={},
    )
    target_label = Field(
        org_id=target_module.org_id,
        module_id=target_module.id,
        name="Label",
        type=FieldType.TEXT,
        position=0,
        required=False,
        config={},
    )
    link = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Related",
        type=FieldType.RELATIONSHIP,
        position=1,
        required=False,
        config={},
        relationship_target_module_id=target_module.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    db.add_all([label, target_label, link])
    db.flush()
    record = Record(org_id=module.org_id, module_id=module.id, data={str(label.id): "source"})
    target = Record(org_id=target_module.org_id,
                    module_id=target_module.id, data={str(target_label.id): "target"})
    db.add_all([record, target])
    admin = add_user(db, "lifecycle-admin", role=UserRole.ADMIN)
    writer = add_user(db, "lifecycle-writer")
    reader = add_user(db, "lifecycle-reader")
    manager = add_user(db, "lifecycle-manager")
    no_group = add_user(db, "lifecycle-no-group")
    guest = add_user(db, "lifecycle-guest", role=UserRole.GUEST)
    make_group_access(db, [writer], department, level=AccessLevel.WRITE)
    make_group_access(db, [reader], department, level=AccessLevel.READ)
    make_group_access(db, [manager], department, level=AccessLevel.MANAGE)
    # A write row still gives a guest only read.
    make_group_access(db, [guest], department, level=AccessLevel.WRITE)
    db.flush()

    actor: list[User] = []
    app = FastAPI()
    for router in (records_router, query_router, relationships_router, audit_router):
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: actor[0])
    with TestClient(app) as client:
        yield _World(
            db=db,
            department=department,
            module=module,
            target_module=target_module,
            label=label,
            link=link,
            record=record,
            target=target,
            admin=admin,
            writer=writer,
            reader=reader,
            manager=manager,
            no_group=no_group,
            guest=guest,
            actor=actor,
            _client=client,
        )


def _delete(world: _World, user: User, record: Record) -> Any:
    return world.client(user).delete(f"/api/records/{record.id}")


def _restore(world: _World, user: User, record: Record) -> Any:
    return world.client(user).post(f"/api/records/{record.id}/restore")


def _link(world: _World, user: User) -> Any:
    return world.client(user).post(
        "/api/relationships",
        json={
            "field_id": str(world.link.id),
            "source_record_id": str(world.record.id),
            "target_record_id": str(world.target.id),
        },
    )


def _visible_links(world: _World, user: User, availability: str = "available") -> list[str]:
    response = world.client(user).get(
        "/api/relationships",
        params={"incident_record_id": str(world.record.id), "availability": availability},
    )
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


def _query_ids(world: _World, user: User, deleted: str) -> set[str]:
    response = world.client(user).post(
        "/api/records/query",
        json={"module_id": str(world.module.id), "definition": {"deleted": deleted}},
    )
    assert response.status_code == 200, response.text
    return {item["id"] for item in response.json()["items"]}


# G1: delete and restore for each account role.


def test_writer_deletes_and_restores_a_record(world: _World) -> None:
    assert _delete(world, world.writer, world.record).status_code == 204
    shown = world.client(world.writer).get(f"/api/records/{world.record.id}")
    assert shown.status_code == 200
    assert shown.json()["is_deleted"] is True

    restored = _restore(world, world.writer, world.record)
    assert restored.status_code == 200, restored.text
    assert restored.json()["is_deleted"] is False


@pytest.mark.parametrize("role", ["reader", "guest"])
def test_read_only_users_cannot_delete_or_restore(world: _World, role: str) -> None:
    user = getattr(world, role)
    assert _delete(world, user, world.record).status_code == 403
    assert _delete(world, world.writer, world.record).status_code == 204
    assert _restore(world, user, world.record).status_code == 403
    world.db.refresh(world.record)
    assert world.record.is_deleted is True


def test_user_without_access_sees_a_missing_record(world: _World) -> None:
    assert _delete(world, world.no_group, world.record).status_code == 404
    assert _delete(world, world.writer, world.record).status_code == 204
    assert _restore(world, world.no_group, world.record).status_code == 404
    world.db.refresh(world.record)
    assert world.record.is_deleted is True


# G2: links that touch a deleted record.


def test_a_deleted_record_hides_its_links_until_restore(world: _World) -> None:
    created = _link(world, world.writer)
    assert created.status_code == 201, created.text
    edge_id = created.json()["id"]

    assert _delete(world, world.writer, world.record).status_code == 204
    assert _visible_links(world, world.writer) == []
    assert _visible_links(world, world.writer, "hidden") == [edge_id]
    assert world.client(world.writer).get(f"/api/relationships/{edge_id}").json()[
        "hidden_reasons"
    ] == ["source_record_archived"]

    assert _restore(world, world.writer, world.record).status_code == 200
    assert _visible_links(world, world.writer) == [edge_id]
    edge = world.db.get(RelationshipEdge, edge_id)
    assert edge is not None and edge.is_deleted is False


def test_links_cannot_start_from_or_point_to_a_deleted_record(world: _World) -> None:
    assert _delete(world, world.writer, world.record).status_code == 204
    from_deleted = _link(world, world.writer)
    assert from_deleted.status_code == 409, from_deleted.text

    assert _restore(world, world.writer, world.record).status_code == 200
    assert _delete(world, world.writer, world.target).status_code == 204
    to_deleted = _link(world, world.writer)
    assert to_deleted.status_code == 409, to_deleted.text
    assert (
        world.db.scalar(
            select(RelationshipEdge).where(RelationshipEdge.source_record_id == world.record.id)
        )
        is None
    )


def test_unlink_works_when_the_target_is_deleted_but_not_the_source(world: _World) -> None:
    edge_id = _link(world, world.writer).json()["id"]
    assert _delete(world, world.writer, world.target).status_code == 204
    unlinked = world.client(world.writer).delete(f"/api/relationships/{edge_id}")
    assert unlinked.status_code == 204, unlinked.text

    second = world.client(world.admin).post(f"/api/records/{world.target.id}/restore")
    assert second.status_code == 200
    edge_id = _link(world, world.writer).json()["id"]
    assert _delete(world, world.writer, world.record).status_code == 204
    refused = world.client(world.writer).delete(f"/api/relationships/{edge_id}")
    assert refused.status_code == 409, refused.text


def test_assign_replaces_a_link_and_clears_it(world: _World) -> None:
    # Assignment needs a single-target field.
    single = Field(
        org_id=world.module.org_id,
        module_id=world.module.id,
        name="Owner",
        type=FieldType.RELATIONSHIP,
        position=2,
        required=False,
        config={},
        relationship_target_module_id=world.target_module.id,
        relationship_multiple_targets=False,
        relationship_multiple_sources=True,
    )
    other = Record(org_id=world.target_module.org_id, module_id=world.target_module.id, data={})
    world.db.add_all([single, other])
    world.db.flush()
    path = f"/api/relationships/fields/{single.id}/sources/{world.record.id}"
    first = world.client(world.writer).put(path, json={"target_record_id": str(world.target.id)})
    assert first.status_code == 200, first.text
    replaced = world.client(world.writer).put(path, json={"target_record_id": str(other.id)})
    assert replaced.status_code == 200, replaced.text
    targets = {
        item["target_record_id"]
        for item in world.client(world.writer)
        .get("/api/relationships", params={"source_record_id": str(world.record.id)})
        .json()["items"]
    }
    assert targets == {str(other.id)}
    cleared = world.client(world.writer).put(path, json={"target_record_id": None})
    assert cleared.status_code in (200, 204), cleared.text
    assert _visible_links(world, world.writer) == []
    assert (
        world.client(world.reader)
        .put(path, json={"target_record_id": str(world.target.id)})
        .status_code
        == 403
    )


# G3: one audit row each for delete and restore, naming the actor.


def test_delete_and_restore_each_write_one_audit_row_for_the_actor(world: _World) -> None:
    assert _delete(world, world.writer, world.record).status_code == 204
    assert _restore(world, world.writer, world.record).status_code == 200
    rows = list(
        world.db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "records",
                AuditLog.entity_id == world.record.id,
                AuditLog.action != AuditAction.CREATE,
            )
            .order_by(AuditLog.created_at, AuditLog.id)
        )
    )
    assert [row.action for row in rows] == [AuditAction.DELETE, AuditAction.UPDATE]
    assert {row.performed_by for row in rows} == {world.writer.id}
    assert rows[0].after is not None and rows[0].after["is_deleted"] is True
    assert rows[1].after is not None and rows[1].after["is_deleted"] is False
    assert {row.department_id for row in rows} == {world.department.id}


# G4: the record query's deleted options.


def test_record_query_deleted_options(world: _World) -> None:
    kept = Record(org_id=world.module.org_id,
                  module_id=world.module.id, data={str(world.label.id): "kept"})
    world.db.add(kept)
    world.db.flush()
    assert _delete(world, world.writer, world.record).status_code == 204
    deleted, live = str(world.record.id), str(kept.id)

    for user in (world.writer, world.reader, world.guest):
        assert _query_ids(world, user, "exclude") == {live}
        assert _query_ids(world, user, "only") == {deleted}
        assert _query_ids(world, user, "include") == {deleted, live}
    refused = world.client(world.no_group).post(
        "/api/records/query",
        json={"module_id": str(world.module.id), "definition": {"deleted": "only"}},
    )
    assert refused.status_code == 404


# G5: record history.


def test_record_history_is_for_admins_and_department_managers(world: _World) -> None:
    writer = world.client(world.writer)
    opened = writer.get(f"/api/records/{world.record.id}").json()
    patched = writer.patch(
        f"/api/records/{world.record.id}",
        json={"data": {str(world.label.id): "edited"}},
        headers={"If-Match": f'"{opened["updated_at"]}"'},
    )
    assert patched.status_code == 200, patched.text
    params = {"entity_id": str(world.record.id)}
    scoped = {**params, "department_id": str(world.department.id)}

    as_admin = world.client(world.admin).get("/api/audit-logs", params=params)
    assert as_admin.status_code == 200, as_admin.text
    # Newest first; the fixture's insert is the create row.
    assert [item["action"] for item in as_admin.json()["items"]] == ["update", "create"]

    assert world.client(world.manager).get("/api/audit-logs", params=params).status_code == 403
    as_manager = world.client(world.manager).get("/api/audit-logs", params=scoped)
    assert as_manager.status_code == 200, as_manager.text
    assert len(as_manager.json()["items"]) == 2

    for user in (world.writer, world.reader, world.guest, world.no_group):
        assert world.client(user).get("/api/audit-logs", params=scoped).status_code == 403


# Record revision: PATCH requires If-Match; a missing one is 428, a stale one 412.


def _save(world: _World, value: str, revision: str | None = None) -> Any:
    headers = {} if revision is None else {"If-Match": revision}
    return world.client(world.writer).patch(
        f"/api/records/{world.record.id}",
        json={"data": {str(world.label.id): value}},
        headers=headers,
    )


def test_save_without_if_match_is_refused_without_a_write(world: _World) -> None:
    # PATCH replaces every active value, so an unversioned save could erase changes
    # made after the caller read the record.
    before = dict(world.record.data)
    refused = _save(world, "unversioned")
    assert refused.status_code == 428, refused.text
    world.db.refresh(world.record)
    assert world.record.data == before


def test_save_with_the_current_revision_from_a_query_row(world: _World) -> None:
    # The side panel opens from a query row, so its token is the row's updated_at.
    row = next(
        item
        for item in world.client(world.writer)
        .post(
            "/api/records/query",
            json={"module_id": str(world.module.id), "definition": {}},
        )
        .json()["items"]
        if item["id"] == str(world.record.id)
    )
    saved = _save(world, "first", f'"{row["updated_at"]}"')
    assert saved.status_code == 200, saved.text
    assert saved.json()["updated_at"] != row["updated_at"]

    again = _save(world, "second", saved.json()["updated_at"])
    assert again.status_code == 200, again.text


def test_stale_save_is_refused_and_keeps_the_newer_value(world: _World) -> None:
    opened = world.client(world.writer).get(f"/api/records/{world.record.id}").json()
    assert _save(world, "theirs", opened["updated_at"]).status_code == 200

    stale = _save(world, "mine", opened["updated_at"])
    assert stale.status_code == 412, stale.text
    world.db.refresh(world.record)
    assert world.record.data[str(world.label.id)] == "theirs"


def test_unreadable_revision_is_refused(world: _World) -> None:
    assert _save(world, "mine", "not-a-revision").status_code == 412
