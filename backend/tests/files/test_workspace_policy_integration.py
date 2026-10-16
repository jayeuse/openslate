"""Record attachments follow the record's department and module access across their lifecycle."""

from hashlib import sha256
from io import BytesIO
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel, GroupAccess
from app.systems.access.users.models import User, UserRole
from app.systems.platform.files import delivery, service
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import transfer_slot
from app.systems.platform.files.router import router
from app.systems.platform.files.schemas import FileCreate
from app.systems.platform.files.storage import get_storage
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.organization_scope_support import scoped_override
from tests.rbac.support import add_user, make_group_access, organization

pytestmark = pytest.mark.integration


class _Store:
    def __init__(self, db):
        self.db = db
        self.objects: dict[str, bytes] = {}

    def upload(self, key: str, content: bytes, _media_type: str) -> None:
        assert not self.db.in_transaction()
        self.objects[key] = content

    def download(self, key: str) -> bytes | None:
        assert not self.db.in_transaction()
        return self.objects.get(key)

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)


def _png() -> bytes:
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    return output.getvalue()


def _actor_with_record(
    db, *, level: AccessLevel | None = None, role: str = UserRole.MEMBER
) -> tuple[User, GroupAccess | None, Record]:
    actor = add_user(db, "attachment-policy", role=role)
    department = Department(org_id=organization(db).id,
                            department_name=f"Attachment policy {uuid4()}")
    module = Module(org_id=department.org_id, department=department, module_name="Files")
    record = Record(org_id=module.org_id, module=module, data={})
    db.add_all([department, module, record])
    db.flush()
    grant = (
        make_group_access(db, [actor], department, module, level=level)
        if level is not None
        else None
    )
    db.commit()
    return actor, grant, record


def _ready_file(db, actor: User, record: Record, content: bytes) -> File:
    file = File(
        org_id=record.org_id,
        purpose="record_attachment",
        record_id=record.id,
        creator_id=actor.id,
        filename="attachment.png",
        expected_size=len(content),
        actual_size=len(content),
        media_type="image/png",
        digest=sha256(content).hexdigest(),
        object_key=uuid4().hex,
        state="ready",
    )
    db.add(file)
    db.commit()
    return file


def _client(db, actor: User, storage: _Store) -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def file_capacity(request, call_next):
        with transfer_slot() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    app.dependency_overrides[get_storage] = lambda: storage
    return TestClient(app)


def test_record_attachment_routes_allow_a_member_who_can_write_the_module(guarded_db, monkeypatch):
    db = guarded_db
    actor, _grant, record = _actor_with_record(db, level=AccessLevel.WRITE)
    content = _png()
    storage = _Store(db)
    monkeypatch.setattr(delivery, "append_committed_security_event", lambda _event: None)

    with _client(db, actor, storage) as client:
        created = client.post(
            "/api/files",
            json={
                "purpose": "record_attachment",
                "record_id": str(record.id),
                "filename": "attachment.png",
                "expected_size": len(content),
            },
        )
        assert created.status_code == 201, created.text
        file_id = created.json()["id"]
        path = f"/api/files/{file_id}"
        listed = client.get(
            "/api/files", params={"purpose": "record_attachment", "record_id": str(record.id)}
        )
        assert listed.status_code == 200 and listed.json()["pagination"]["total"] == 1
        assert client.get(path).status_code == 200
        uploaded = client.put(
            path + "/content",
            content=content,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["state"] == "ready"
        downloaded = client.get(path + "/content")
        assert downloaded.status_code == 200 and downloaded.content == content
        archived = client.post(path + "/archive")
        assert archived.status_code == 200 and archived.json()["is_deleted"] is True


def test_member_without_a_group_for_the_department_cannot_see_or_change_attachments(
    guarded_db,
):
    db = guarded_db
    actor, _grant, record = _actor_with_record(db)
    content = _png()
    file = _ready_file(db, actor, record, content)
    storage = _Store(db)
    storage.objects[file.object_key] = content

    with _client(db, actor, storage) as client:
        path = f"/api/files/{file.id}"
        assert (
            client.get(
                "/api/files",
                params={"purpose": "record_attachment", "record_id": str(record.id)},
            ).status_code
            == 404
        )
        assert client.get(path).status_code == 404
        assert client.get(path + "/content").status_code == 404
        assert (
            client.post(
                "/api/files",
                json={
                    "purpose": "record_attachment",
                    "record_id": str(record.id),
                    "filename": "new.png",
                    "expected_size": len(content),
                },
            ).status_code
            == 404
        )
        assert client.post(path + "/archive").status_code == 404


def test_guest_in_a_write_group_can_read_but_not_add_attachments(guarded_db):
    db = guarded_db
    guest, _grant, record = _actor_with_record(db, level=AccessLevel.WRITE, role=UserRole.GUEST)
    content = _png()
    file = _ready_file(db, guest, record, content)

    with _client(db, guest, _Store(db)) as client:
        assert client.get(f"/api/files/{file.id}").status_code == 200
        created = client.post(
            "/api/files",
            json={
                "purpose": "record_attachment",
                "record_id": str(record.id),
                "filename": "new.png",
                "expected_size": len(content),
            },
        )
        assert created.status_code == 403
        assert client.post(f"/api/files/{file.id}/archive").status_code == 403


def test_attachment_download_reauthorizes_after_storage_latency(guarded_db, monkeypatch):
    db = guarded_db
    actor, grant, record = _actor_with_record(db, level=AccessLevel.READ)
    assert grant is not None
    content = _png()
    file = _ready_file(db, actor, record, content)

    class _RevokingStore(_Store):
        def download(self, key: str) -> bytes | None:
            revoked = self.db.get(GroupAccess, grant.id)
            assert revoked is not None
            self.db.delete(revoked)
            self.db.commit()
            return super().download(key)

    storage = _RevokingStore(db)
    storage.objects[file.object_key] = content
    monkeypatch.setattr(delivery, "append_committed_security_event", lambda _event: None)

    with _client(db, actor, storage) as client:
        response = client.get(f"/api/files/{file.id}/content")
    assert response.status_code == 404


def test_administrator_attaches_to_any_record_without_a_group(guarded_db, actor):
    db = guarded_db
    department = Department(org_id=organization(db).id,
                            department_name=f"Administrator attachment {uuid4()}")
    module = Module(org_id=department.org_id, department=department, module_name="Files")
    record = Record(org_id=module.org_id, module=module, data={})
    db.add_all([department, module, record])
    db.commit()

    result = service.reserve(
        db,
        actor,
        FileCreate(
            purpose="record_attachment",
            record_id=record.id,
            filename="administrator.png",
            expected_size=len(_png()),
        ),
    )

    assert result.purpose == "record_attachment"
