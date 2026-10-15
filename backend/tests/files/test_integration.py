"""Real PostgreSQL transitions with fake external bytes."""

from io import BytesIO
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image

from app.systems.platform.files import delivery, service
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import (
    ProviderRejected,
    ProviderUnavailable,
    ProviderWriteRejected,
)
from app.systems.platform.files.schemas import FileCreate
from tests.files.conftest import library_department
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


class Store:
    def __init__(self, db):
        self.objects = {}
        self.db = db
        self.fail_upload = False

    def upload(self, key, content, media_type):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        self.objects[key] = content
        if self.fail_upload:
            raise ProviderUnavailable("uncertain write")

    def download(self, key):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        return self.objects.get(key)

    def delete(self, key):
        assert not self.db.in_transaction()
        self.objects.pop(key, None)


def reserve(db, actor):
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    item = service.reserve(
        db,
        actor,
        FileCreate(
            purpose="library_document",
            department_id=library_department(db),
            filename="image.png",
            expected_size=len(content),
        ),
    )
    db.commit()
    return item.id, content


def test_upload_returns_ready_and_downloads_with_no_further_step(guarded_db, actor, monkeypatch):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)

    result = service.upload(db, actor_id, file_id, content, storage)

    assert result.state == "ready" and result.failure_code is None
    stored = db.get(File, file_id)
    assert stored.operation_id is None and stored.operation_expires_at is None
    events = []
    monkeypatch.setattr(delivery, "append_committed_security_event", events.append)
    downloaded, mime, filename = service.download(db, actor_id, file_id, storage)
    assert (downloaded, mime, filename) == (content, "image/png", "image.png")
    assert len(events) == 1 and events[0].event_type == "file.download"


@pytest.mark.parametrize("stored", ["exact", "missing", "different"])
def test_reconcile_makes_an_uncertain_upload_ready_only_with_its_exact_bytes(
    guarded_db, actor, stored
):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    storage.fail_upload = True
    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor_id, file_id, content, storage)
    assert caught.value.detail["code"] == "upload_unresolved"
    assert db.get(File, file_id).state == "uploading"
    key = db.get(File, file_id).object_key
    db.rollback()
    if stored == "missing":
        del storage.objects[key]
    elif stored == "different":
        storage.objects[key] = content[:-1] + b"x"

    if stored == "exact":
        result = service.reconcile(db, actor_id, file_id, storage)
        assert result.state == "ready" and result.failure_code is None
        assert db.get(File, file_id).operation_id is None
        return
    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "upload_unresolved"
    db.rollback()
    assert db.get(File, file_id).state == "uploading"


def test_definitive_pre_install_upload_failure_releases_the_reservation(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)

    def reject_before_install(key, content, media_type):
        del key, content, media_type
        raise ProviderWriteRejected("disk full before install")

    storage.upload = reject_before_install
    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor_id, file_id, content, storage)

    assert caught.value.detail["code"] == "upload_storage_unavailable"
    file = db.get(File, file_id)
    assert file is not None
    assert file.state == "purged"
    assert file.failure_code == "upload_storage_unavailable"
    assert file.operation_id is None
    assert file.actual_size is None and file.digest is None


def test_storage_rejected_upload_is_never_downloadable(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)

    def reject(key, content, media_type):
        del key, content, media_type
        raise ProviderRejected("object already exists")

    storage.upload = reject
    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor_id, file_id, content, storage)
    assert caught.value.detail["code"] == "upload_rejected"
    db.rollback()
    assert db.get(File, file_id).state == "rejected"
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "file_not_ready"


def test_access_event_failure_releases_no_bytes(guarded_db, actor, monkeypatch):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)

    def fail(event):
        raise delivery.SecurityEventPersistenceError("unavailable")

    monkeypatch.setattr(delivery, "append_committed_security_event", fail)
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "file_event_unavailable"


def test_registered_attachment_flow_obeys_parent_and_transfer_contracts(
    guarded_db, actor, monkeypatch
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies import get_current_user
    from app.core.database import get_db
    from app.systems.platform.files.router import router
    from app.systems.platform.files.storage import get_storage
    from app.systems.sandbox.departments.models import Department
    from app.systems.sandbox.modules.models import Module
    from app.systems.sandbox.records.models import Record

    db = guarded_db
    org_id = organization(db).id
    department = Department(org_id=org_id, department_name=str(uuid4()))
    module = Module(org_id=org_id, department=department, module_name="Files")
    record = Record(org_id=org_id, module=module, data={})
    db.add_all([department, module, record])
    db.commit()
    record_id = record.id
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    storage = Store(db)
    app = FastAPI()
    from app.systems.platform.files.providers import transfer_slot

    @app.middleware("http")
    async def file_capacity(request, call_next):
        with transfer_slot() as lease:
            request.state.file_transfer_lease = lease
            return await call_next(request)

    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_storage] = lambda: storage
    monkeypatch.setattr(delivery, "append_committed_security_event", lambda event: None)
    with TestClient(app) as client:
        response = client.post(
            "/api/files",
            json={
                "purpose": "record_attachment",
                "record_id": str(record_id),
                "filename": "a.png",
                "expected_size": len(content),
            },
        )
        assert response.status_code == 201
        file_id = response.json()["id"]
        path = f"/api/files/{file_id}"
        assert client.get(path).status_code == 200
        listed = client.get(
            "/api/files", params={"purpose": "record_attachment", "record_id": str(record_id)}
        )
        assert listed.status_code == 200 and listed.json()["pagination"]["total"] == 1
        assert client.get("/api/files", params={"purpose": "record_attachment"}).status_code == 422
        uploaded = client.put(
            path + "/content",
            content=content,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert uploaded.status_code == 200 and uploaded.json()["state"] == "ready"
        result = client.get(path + "/content")
        assert result.content == content and result.headers["Cache-Control"] == "no-store"
        assert result.headers["Content-Disposition"].startswith("attachment;")
        assert client.post(path + "/archive").json()["is_deleted"] is True
        assert client.post(path + "/reopen").json()["is_deleted"] is False
        assert client.post(path + "/reconcile").status_code == 200
        assert client.post(path + "/archive").json()["is_deleted"] is True
        department.is_deleted = True
        db.commit()
        assert client.post(path + "/reopen").status_code == 409


def test_invalid_size_duplicate_upload_and_corrupt_stored_bytes_fail_closed(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor_id, file_id, content + b"extra", storage)
    assert caught.value.status_code == 422
    db.rollback()
    service.upload(db, actor_id, file_id, content, storage)
    with pytest.raises(HTTPException):
        service.upload(db, actor_id, file_id, content, storage)
    db.rollback()
    key = db.get(File, file_id).object_key
    storage.objects[key] = b"corrupt"
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "file_integrity_error"
