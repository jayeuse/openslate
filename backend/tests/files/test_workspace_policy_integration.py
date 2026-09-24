"""Record attachments obey persisted workspace policy across their lifecycle."""

from hashlib import sha256
from io import BytesIO
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessPolicyVersion, AccessRule
from app.systems.access.users.models import Role, User
from app.systems.platform.files import service
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import transfer_slot
from app.systems.platform.files.router import router
from app.systems.platform.files.schemas import FileCreate
from app.systems.platform.files.storage import get_storage
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

pytestmark = pytest.mark.integration


class _Store:
    def __init__(self, db):
        self.db = db
        self.quarantine: dict[str, bytes] = {}
        self.objects: dict[str, bytes] = {}

    def upload(self, key: str, content: bytes, _media_type: str) -> None:
        assert not self.db.in_transaction()
        self.quarantine[key] = content

    def read_quarantine(self, key: str) -> bytes | None:
        assert not self.db.in_transaction()
        return self.quarantine.get(key)

    def promote(self, key: str, *, expected_digest: str, expected_size: int) -> None:
        assert not self.db.in_transaction()
        content = self.quarantine.get(key)
        assert content is not None
        assert (sha256(content).hexdigest(), len(content)) == (expected_digest, expected_size)
        self.objects[key] = content

    def download(self, key: str) -> bytes | None:
        assert not self.db.in_transaction()
        return self.objects.get(key)

    def stat(self, key: str, *, quarantine: bool):
        del key, quarantine
        raise AssertionError("The attachment policy test does not reconcile storage")

    def delete(self, key: str) -> None:
        self.quarantine.pop(key, None)
        self.objects.pop(key, None)


def _png() -> bytes:
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    return output.getvalue()


def _add_role_rule(db, *, role_id, permission: str, decision: str) -> AccessRule:
    version = db.scalar(select(AccessPolicyVersion).with_for_update())
    assert version is not None
    version.revision += 1
    rule = AccessRule(
        subject_kind="role",
        subject_id=role_id,
        scope_kind="workspace",
        scope_id=None,
        permission_id=permission,
        decision=decision,
        starts_at=None,
        ends_at=None,
        locked=False,
        policy_version=version.revision,
    )
    db.add(rule)
    db.commit()
    return rule


def _actor_with_record(db, *, permissions: dict[str, bool] | None = None):
    role = Role(role=f"attachment-policy-{uuid4()}", permissions=permissions or {})
    db.add(role)
    db.flush()
    actor = User(
        email=f"attachment-policy-{uuid4()}@example.com",
        username=f"attachment_policy_{uuid4().hex[:12]}",
        role_id=role.id,
        status="active",
    )
    department = Department(department_name=f"Attachment policy {uuid4()}")
    module = Module(department=department, module_name="Files")
    record = Record(module=module, data={})
    db.add_all([actor, department, module, record])
    db.commit()
    return actor, role, record


def _client(db, actor: User, storage: _Store) -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def file_capacity(request, call_next):
        with transfer_slot() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_storage] = lambda: storage
    return TestClient(app)


def test_record_attachment_routes_allow_workspace_role_rules(guarded_db, monkeypatch):
    db = guarded_db
    actor, role, record = _actor_with_record(db)
    _add_role_rule(db, role_id=role.id, permission="records.read", decision="allow")
    _add_role_rule(db, role_id=role.id, permission="records.write", decision="allow")
    content = _png()
    storage = _Store(db)
    monkeypatch.setattr(service, "append_committed_security_event", lambda _event: None)

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

        file = db.get(File, file_id)
        assert file is not None and file.digest is not None and file.actual_size is not None
        key, digest, size = file.object_key, file.digest, file.actual_size
        db.commit()
        storage.promote(key, expected_digest=digest, expected_size=size)
        file = db.get(File, file_id)
        assert file is not None
        file.state = "ready"
        file.scanner_version = "test"
        file.signature_version = "test"
        db.commit()
        downloaded = client.get(path + "/content")
        assert downloaded.status_code == 200 and downloaded.content == content
        archived = client.post(path + "/archive")
        assert archived.status_code == 200 and archived.json()["is_deleted"] is True


def test_record_attachment_routes_deny_without_a_workspace_rule(guarded_db):
    db = guarded_db
    actor, _role, record = _actor_with_record(db)
    content = _png()
    file = File(
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
        scanner_version="test",
        signature_version="test",
    )
    db.add(file)
    db.commit()
    storage = _Store(db)
    storage.objects[file.object_key] = content

    with _client(db, actor, storage) as client:
        path = f"/api/files/{file.id}"
        assert (
            client.get(
                "/api/files",
                params={"purpose": "record_attachment", "record_id": str(record.id)},
            ).status_code
            == 403
        )
        assert client.get(path).status_code == 403
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
            == 403
        )
        assert (
            client.put(
                path + "/content",
                content=content,
                headers={"Content-Type": "application/octet-stream"},
            ).status_code
            == 403
        )
        assert client.post(path + "/archive").status_code == 403


def test_attachment_download_reauthorizes_after_storage_latency(guarded_db, monkeypatch):
    db = guarded_db
    actor, role, record = _actor_with_record(db)
    allow = _add_role_rule(db, role_id=role.id, permission="records.read", decision="allow")
    content = _png()
    file = File(
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
        scanner_version="test",
        signature_version="test",
    )
    db.add(file)
    db.commit()

    class _RevokingStore(_Store):
        def download(self, key: str) -> bytes | None:
            allow.is_deleted = True
            version = self.db.scalar(select(AccessPolicyVersion).with_for_update())
            assert version is not None
            version.revision += 1
            self.db.add(
                AccessRule(
                    subject_kind="role",
                    subject_id=role.id,
                    scope_kind="workspace",
                    scope_id=None,
                    permission_id="records.read",
                    decision="deny",
                    starts_at=None,
                    ends_at=None,
                    locked=False,
                    policy_version=version.revision,
                )
            )
            self.db.commit()
            return super().download(key)

    storage = _RevokingStore(db)
    storage.objects[file.object_key] = content
    monkeypatch.setattr(service, "append_committed_security_event", lambda _event: None)

    with _client(db, actor, storage) as client:
        response = client.get(f"/api/files/{file.id}/content")
    assert response.status_code == 403


def test_internal_administrator_attachment_write_is_policy_protected(guarded_db, actor):
    db = guarded_db
    department = Department(department_name=f"Administrator attachment {uuid4()}")
    module = Module(department=department, module_name="Files")
    record = Record(module=module, data={})
    db.add_all([department, module, record])
    db.commit()
    version = db.scalar(select(AccessPolicyVersion).with_for_update())
    assert version is not None
    version.revision += 1
    db.add(
        AccessRule(
            subject_kind="everyone",
            subject_id=None,
            scope_kind="workspace",
            scope_id=None,
            permission_id="records.write",
            decision="deny",
            starts_at=None,
            ends_at=None,
            locked=False,
            policy_version=version.revision,
        )
    )
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
