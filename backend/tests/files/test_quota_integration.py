"""Quarantine admission bounds never prevent safe cleanup of existing inventory."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.systems.platform.files import service
from app.systems.platform.files.models import File
from app.systems.platform.files.purge import purge_confirmed
from app.systems.platform.files.quota import lock_quota
from app.systems.platform.files.schemas import FileCreate
from app.systems.platform.files.validation import ValidatedContent
from app.systems.platform.files.worker import expire_unused_reservations
from tests.files.test_integration import Store, reserve

pytestmark = pytest.mark.integration
MIB = 1024 * 1024


def inventory(db, actor, *, count, size=1, state="awaiting_upload"):
    rows = [
        File(
            purpose="library_document",
            creator_id=actor.id,
            filename="file.pdf",
            expected_size=size,
            object_key=uuid4().hex,
            state=state,
            is_deleted=True,
        )
        for _ in range(count)
    ]
    db.add_all(rows)
    db.commit()
    return rows


def test_hundred_archived_rejected_entries_block_new_reservation(guarded_db, actor):
    db = guarded_db
    inventory(db, actor, count=100, state="rejected")
    with pytest.raises(HTTPException) as caught:
        service.reserve(
            db, actor, FileCreate(purpose="library_document", filename="new.pdf", expected_size=1)
        )
    assert caught.value.detail["code"] == "file_quarantine_full"


def test_gibibyte_boundary_uses_declared_bytes_and_logo_canonical_charge(guarded_db, actor):
    db = guarded_db
    inventory(db, actor, count=40, size=25 * MIB)
    service.reserve(
        db,
        actor,
        FileCreate(purpose="library_document", filename="remaining.pdf", expected_size=23 * MIB),
    )
    with pytest.raises(HTTPException):
        service.reserve(
            db, actor, FileCreate(purpose="workspace_logo", filename="tiny.png", expected_size=1)
        )
    db.rollback()
    service.reserve(
        db, actor, FileCreate(purpose="library_document", filename="last.pdf", expected_size=MIB)
    )
    with pytest.raises(HTTPException) as caught:
        service.reserve(
            db,
            actor,
            FileCreate(purpose="library_document", filename="excess.pdf", expected_size=1),
        )
    assert caught.value.detail["code"] == "file_quarantine_full"


def test_advisory_lock_rejects_parallel_admission_without_waiting(guarded_db):
    db = guarded_db
    lock_quota(db)
    # Same already-guarded disposable engine, independent PostgreSQL session.
    engine = db.get_bind().engine
    with Session(engine) as other:
        with pytest.raises(HTTPException) as caught:
            lock_quota(other)
        assert caught.value.detail["code"] == "file_quota_busy"


def test_expiration_only_purges_never_admitted_reservations(guarded_db, actor):
    db = guarded_db
    rows = inventory(db, actor, count=3)
    now = datetime.now(UTC)
    for row in rows:
        row.created_at = now - timedelta(hours=25)
    rows[1].state = "uploading"
    rows[1].operation_id = uuid4()
    rows[2].scan_requested_by = actor.id
    db.commit()
    assert expire_unused_reservations(db, now) == 1
    assert db.get(File, rows[0].id).state == "purged"
    assert db.get(File, rows[0].id).performed_by is None
    assert db.get(File, rows[1].id).state == "uploading"
    assert db.get(File, rows[2].id).state == "awaiting_upload"


def test_upload_rechecks_reservation_expiry_after_parser(guarded_db, actor, monkeypatch):
    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)

    def parser(filename, content, *, logo):
        file = db.get(File, file_id)
        file.created_at = datetime.now(UTC) - timedelta(hours=25)
        db.commit()
        return ValidatedContent(content, "image/png")

    monkeypatch.setattr(service, "validate_bounded", parser)
    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor_id, file_id, content, storage)
    assert caught.value.detail["code"] == "file_reservation_expired"
    assert not storage.objects


def test_full_quarantine_does_not_prevent_confirmed_cleanup(guarded_db, actor, monkeypatch):
    db = guarded_db
    actor_id = actor.id
    inventory(db, actor, count=100, state="rejected")
    ready = File(
        purpose="library_document",
        creator_id=actor_id,
        filename="ready.pdf",
        expected_size=1,
        actual_size=1,
        digest="a" * 64,
        scanner_version="test",
        signature_version="test",
        object_key=uuid4().hex,
        state="ready",
        is_deleted=True,
    )
    db.add(ready)
    db.commit()
    file_id = ready.id
    monkeypatch.setattr(
        "app.systems.platform.files.purge.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    assert purge_confirmed(db, actor_id, file_id, Store(db)).state == "purged"
