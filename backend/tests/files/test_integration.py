"""Real PostgreSQL transitions with fake external bytes/verdicts, never a release scan."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image

from app.systems.platform.files import service
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import (
    ProviderUnavailable,
    ProviderWriteRejected,
    ScanVerdict,
    StorageStat,
    UnavailableScanner,
)
from app.systems.platform.files.scan_processing import WorkerHalted, process_next
from app.systems.platform.files.schemas import FileCreate

pytestmark = pytest.mark.integration


class Store:
    def __init__(self, db):
        self.objects = {}
        self.quarantine = {}
        self.db = db
        self.fail_upload = False

    def upload(self, key, content, media_type):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        self.quarantine[key] = content
        if self.fail_upload:
            raise ProviderUnavailable("uncertain write")

    def read_quarantine(self, key):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        return self.quarantine.get(key)

    def promote(self, key, *, expected_digest, expected_size):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        content = self.quarantine.get(key)
        if content is None:
            raise ProviderUnavailable("quarantined object is unavailable")
        if sha256(content).hexdigest() != expected_digest or len(content) != expected_size:
            raise ProviderUnavailable("quarantined object integrity changed")
        self.objects[key] = content

    def download(self, key):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        return self.objects.get(key)

    def stat(self, key, *, quarantine):
        assert not self.db.in_transaction(), "Provider call held a SQL transaction"
        content = (self.quarantine if quarantine else self.objects).get(key)
        if content is None:
            return None
        return StorageStat(len(content), sha256(content).hexdigest())

    def delete(self, key):
        assert not self.db.in_transaction()
        self.quarantine.pop(key, None)
        self.objects.pop(key, None)


class Clean:
    def probe(self):
        pass

    def scan(self, content, *, digest, operation_id):
        return ScanVerdict("clean", sha256(content).hexdigest(), "test", "test")


def scan_now(db, actor_id, file_id, storage, scanner):
    service.scan(db, actor_id, file_id)
    process_next(db, storage, scanner)
    return db.get(File, file_id)


def reserve(db, actor):
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    item = service.reserve(
        db,
        actor,
        FileCreate(purpose="library_document", filename="image.png", expected_size=len(content)),
    )
    db.commit()
    return item.id, content


def test_upload_scan_download_requires_clean_verdict_and_committed_access_event(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    assert service.upload(db, actor_id, file_id, content, storage).state == "pending_scan"
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "file_not_ready"
    db.rollback()
    assert scan_now(db, actor_id, file_id, storage, Clean()).state == "ready"
    events = []
    monkeypatch.setattr(service, "append_committed_security_event", events.append)
    result, mime, filename = service.download(db, actor_id, file_id, storage)
    assert (result, mime, filename) == (content, "image/png", "image.png")
    assert len(events) == 1 and events[0].event_type == "file.download"


def test_unknown_scan_preserves_quarantine_and_uncertain_upload_requires_reconciliation(
    guarded_db, actor
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
    assert service.reconcile(db, actor_id, file_id, storage).state == "pending_scan"
    assert process_next(db, storage, UnavailableScanner()) is False
    assert db.get(File, file_id).scan_attempts == 0
    assert db.get(File, file_id).state == "pending_scan"
    assert db.get(File, file_id).scanner_version is None


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
    assert file.actual_size is None and file.digest is None and file.scan_requested_by is None


def test_reconcile_requeues_exact_dual_location_bytes_after_metadata_commit_failure(
    guarded_db, actor
):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    file = db.get(File, file_id)
    assert file is not None and file.digest is not None and file.actual_size is not None
    key, digest, size = file.object_key, file.digest, file.actual_size
    db.commit()
    storage.promote(key, expected_digest=digest, expected_size=size)
    file = db.get(File, file_id)
    assert file is not None
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    file.failure_code = "promotion_metadata_unresolved"
    db.commit()

    result = service.reconcile(db, actor_id, file_id, storage)

    assert result.state == "pending_scan"
    recovered = db.get(File, file_id)
    assert recovered is not None
    assert recovered.operation_id is None and recovered.scan_next_attempt_at is not None


def test_reconcile_requeues_exact_ready_bytes_when_quarantine_was_removed(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    file = db.get(File, file_id)
    assert file is not None and file.digest is not None and file.actual_size is not None
    key, digest, size = file.object_key, file.digest, file.actual_size
    db.commit()
    storage.promote(key, expected_digest=digest, expected_size=size)
    del storage.quarantine[key]
    file = db.get(File, file_id)
    assert file is not None
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    file.failure_code = "promotion_metadata_unresolved"
    db.commit()

    result = service.reconcile(db, actor_id, file_id, storage)

    assert result.state == "pending_scan"
    recovered = db.get(File, file_id)
    assert recovered is not None
    assert recovered.operation_id is None and recovered.scan_next_attempt_at is not None


def test_reconcile_rejects_conflicting_quarantine_even_if_ready_is_exact(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    file = db.get(File, file_id)
    assert file is not None and file.digest is not None and file.actual_size is not None
    key, digest, size = file.object_key, file.digest, file.actual_size
    db.commit()
    storage.promote(key, expected_digest=digest, expected_size=size)
    storage.quarantine[key] = b"mismatch"
    file = db.get(File, file_id)
    assert file is not None
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    file.failure_code = "promotion_metadata_unresolved"
    db.commit()

    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "scan_execution_unresolved"
    assert db.get(File, file_id).operation_id is not None


def test_leadership_loss_after_clean_promotion_is_reconciled_from_exact_dual_bytes(
    guarded_db, actor
):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    calls = 0

    def lose_leadership_after_promotion() -> None:
        nonlocal calls
        calls += 1
        if calls == 4:
            raise WorkerHalted("leader connection lost")

    with pytest.raises(WorkerHalted, match="metadata finalization"):
        process_next(db, storage, Clean(), verify_leader=lose_leadership_after_promotion)

    file = db.get(File, file_id)
    assert file is not None
    assert file.failure_code == "promotion_metadata_unresolved"
    assert file.operation_id is not None and file.scan_next_attempt_at is None
    assert storage.quarantine[file.object_key] == content
    assert storage.objects[file.object_key] == content
    file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()

    recovered = service.reconcile(db, actor_id, file_id, storage)

    assert recovered.state == "pending_scan"
    assert db.get(File, file_id).operation_id is None


def test_reconcile_does_not_steal_an_unexpired_scan_claim(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    file = db.get(File, file_id)
    assert file is not None
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) + timedelta(minutes=1)
    file.failure_code = "promotion_metadata_unresolved"
    db.commit()

    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "scan_execution_unresolved"
    assert db.get(File, file_id).operation_id is not None


def test_reconcile_never_adopts_exact_bytes_after_scanner_uncertainty(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    file = db.get(File, file_id)
    assert file is not None and file.digest is not None and file.actual_size is not None
    key, digest, size = file.object_key, file.digest, file.actual_size
    db.commit()
    storage.promote(key, expected_digest=digest, expected_size=size)
    file = db.get(File, file_id)
    assert file is not None
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    file.failure_code = "scan_execution_unresolved"
    db.commit()

    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "scan_execution_unresolved"
    assert db.get(File, file_id).operation_id is not None


def test_absence_does_not_resolve_uncertain_upload(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    storage.fail_upload = True
    with pytest.raises(HTTPException):
        service.upload(db, actor_id, file_id, content, storage)
    storage.quarantine.clear()
    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "upload_unresolved"
    assert db.get(File, file_id).state == "uploading"


def test_infected_scan_and_archived_file_never_become_downloadable(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)

    class Infected(Clean):
        def scan(self, content, *, digest, operation_id):
            return ScanVerdict("infected", digest, "test", "test")

    result = scan_now(db, actor_id, file_id, storage, Infected())
    assert result.state == "rejected" and result.failure_code == "scan_infected"
    service.archive(db, actor_id, file_id)
    with pytest.raises(HTTPException):
        scan_now(db, actor_id, file_id, storage, Clean())
    db.rollback()
    with pytest.raises(HTTPException):
        service.download(db, actor_id, file_id, storage)


def test_access_event_failure_releases_no_bytes(guarded_db, actor, monkeypatch):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    scan_now(db, actor_id, file_id, storage, Clean())

    def fail(event):
        raise service.SecurityEventPersistenceError("unavailable")

    monkeypatch.setattr(service, "append_committed_security_event", fail)
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "file_event_unavailable"


def test_archive_during_scan_fences_clean_result(guarded_db, actor):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)

    class ArchiveDuringScan(Clean):
        def scan(self, content, *, digest, operation_id):
            service.archive(db, actor_id, file_id)
            db.commit()
            return ScanVerdict("clean", digest, "test", "test")

    assert process_next(db, storage, ArchiveDuringScan()) is True
    assert db.get(File, file_id).failure_code == "scan_suspended"
    db.rollback()
    assert db.get(File, file_id).state == "pending_scan"


def test_registered_attachment_flow_obeys_parent_and_transfer_contracts(
    guarded_db, actor, monkeypatch
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies import get_current_user
    from app.core.database import get_db
    from app.systems.platform.files.providers import get_scanner
    from app.systems.platform.files.router import router
    from app.systems.platform.files.storage import get_storage
    from app.systems.sandbox.departments.models import Department
    from app.systems.sandbox.modules.models import Module
    from app.systems.sandbox.records.models import Record

    db = guarded_db
    department = Department(department_name=str(uuid4()))
    module = Module(department=department, module_name="Files")
    record = Record(module=module, data={})
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
    app.dependency_overrides[get_scanner] = lambda: Clean()
    monkeypatch.setattr(service, "append_committed_security_event", lambda event: None)
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
        assert (
            client.put(
                path + "/content",
                content=content,
                headers={"Content-Type": "application/octet-stream"},
            ).status_code
            == 200
        )
        queued = client.post(path + "/scan")
        assert queued.status_code == 202 and queued.json()["state"] == "pending_scan"
        assert process_next(db, storage, Clean()) is True
        result = client.get(path + "/content")
        assert result.content == content and result.headers["Cache-Control"] == "no-store"
        assert result.headers["Content-Disposition"].startswith("attachment;")
        assert client.post(path + "/archive").json()["is_deleted"] is True
        assert client.post(path + "/reopen").json()["is_deleted"] is False
        assert client.post(path + "/reconcile").status_code == 200
        department.is_deleted = True
        db.commit()
        assert client.post(path + "/scan").status_code == 409


def test_expired_scan_reconcile_fences_late_completion(guarded_db, actor):
    from datetime import UTC, datetime, timedelta

    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    file = db.get(File, file_id)
    file.operation_id = uuid4()
    file.operation_expires_at = datetime.now(UTC) + timedelta(minutes=1)
    db.commit()
    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "scan_execution_unresolved"
    db.rollback()
    file = db.get(File, file_id)
    file.operation_expires_at = datetime.now(UTC) - timedelta(minutes=1)
    db.commit()
    with pytest.raises(HTTPException) as caught:
        service.reconcile(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "scan_execution_unresolved"
    assert db.get(File, file_id).operation_id is not None


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
    scan_now(db, actor_id, file_id, storage, Clean())
    key = db.get(File, file_id).object_key
    storage.objects[key] = b"corrupt"
    with pytest.raises(HTTPException) as caught:
        service.download(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "file_integrity_error"
