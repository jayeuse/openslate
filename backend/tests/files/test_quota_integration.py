"""Pending-upload admission bounds never prevent safe cleanup of existing inventory."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.platform.files import service
from app.systems.platform.files.models import File
from app.systems.platform.files.purge import purge_confirmed
from app.systems.platform.files.quota import lock_quota, quota_lock_key
from app.systems.platform.files.schemas import FileCreate
from app.systems.platform.files.validation import ValidatedContent
from app.systems.sandbox.departments.models import Department
from tests.conftest import create_member
from tests.files.conftest import library_department
from tests.files.test_integration import Store, reserve
from tests.rbac.support import organization

pytestmark = pytest.mark.integration
MIB = 1024 * 1024


def inventory(db, actor, *, count, size=1, state="awaiting_upload"):
    department_id = library_department(db)
    rows = [
        File(
            org_id=organization(db).id,
            purpose="library_document",
            department_id=department_id,
            creator_id=actor.id,
            filename="file.pdf",
            expected_size=size,
            object_key=f"org/{organization(db).id}/{uuid4().hex}",
            state=state,
            is_deleted=True,
        )
        for _ in range(count)
    ]
    db.add_all(rows)
    db.commit()
    return rows


def test_hundred_archived_pending_uploads_block_new_reservation(guarded_db, actor):
    db = guarded_db
    inventory(db, actor, count=100)
    with pytest.raises(HTTPException) as caught:
        service.reserve(
            db,
            actor,
            FileCreate(
                purpose="library_document",
                department_id=library_department(db),
                filename="new.pdf",
                expected_size=1,
            ),
        )
    assert caught.value.detail["code"] == "file_uploads_full"


def test_rejected_rows_do_not_use_pending_upload_capacity(guarded_db, actor):
    db = guarded_db
    inventory(db, actor, count=100, state="rejected")
    inventory(db, actor, count=99)
    item = service.reserve(
        db,
        actor,
        FileCreate(
            purpose="library_document",
            department_id=library_department(db),
            filename="new.pdf",
            expected_size=1,
        ),
    )
    assert item.state == "awaiting_upload"
    with pytest.raises(HTTPException) as caught:
        service.reserve(
            db,
            actor,
            FileCreate(
                purpose="library_document",
                department_id=library_department(db),
                filename="over.pdf",
                expected_size=1,
            ),
        )
    assert caught.value.detail["code"] == "file_uploads_full"


def test_byte_boundary_uses_declared_bytes_and_logo_canonical_charge(guarded_db, actor):
    db = guarded_db

    def document(name, size):
        return FileCreate(
            purpose="library_document",
            department_id=library_department(db),
            filename=name,
            expected_size=size,
        )

    # 50 pending uploads of 10 MiB, then 11 MiB more: 1 MiB below the 512 MiB cap.
    inventory(db, actor, count=50, size=10 * MIB)
    service.reserve(db, actor, document("remaining.pdf", 10 * MIB))
    service.reserve(db, actor, document("remaining-2.pdf", MIB))
    with pytest.raises(HTTPException):
        # A logo charges its canonical 2 MiB, not its declared byte.
        service.reserve(
            db, actor, FileCreate(purpose="workspace_logo", filename="tiny.png", expected_size=1)
        )
    db.rollback()
    service.reserve(db, actor, document("last.pdf", MIB))
    with pytest.raises(HTTPException) as caught:
        service.reserve(db, actor, document("excess.pdf", 1))
    assert caught.value.detail["code"] == "file_uploads_full"


def test_advisory_lock_rejects_parallel_admission_without_waiting(guarded_db):
    db = guarded_db
    # A request is always bound to its organization; the lock is that organization's.
    scope_session(db, organization(db).id)
    lock_quota(db)
    # Same already-guarded disposable engine, independent PostgreSQL session.
    engine = db.get_bind().engine
    with Session(engine) as other:
        scope_session(other, organization(db).id)
        with pytest.raises(HTTPException) as caught:
            lock_quota(other)
        assert caught.value.detail["code"] == "file_quota_busy"


def test_admission_in_another_organization_or_account_never_waits_on_this_one(guarded_db):
    # Live seven-pack run: one installation-wide lock refused a logo bind in one
    # organization (503 file_quota_busy) while another organization admitted a file.
    db = guarded_db
    scope_session(db, organization(db).id)
    lock_quota(db)
    engine = db.get_bind().engine
    with Session(engine) as other:
        scope_session(other, uuid4())
        lock_quota(other)
        lock_quota(other, account=uuid4())
        other.rollback()


def test_expiration_only_purges_never_admitted_reservations(guarded_db, actor):
    db = guarded_db
    rows = inventory(db, actor, count=3)
    now = datetime.now(UTC)
    for row in rows:
        row.created_at = now - timedelta(hours=25)
    rows[1].state = "uploading"
    rows[1].operation_id = uuid4()
    rows[2].created_at = now - timedelta(hours=23)
    db.commit()
    assert service.expire_unused_reservations(db, now) == 1
    assert db.get(File, rows[0].id).state == "purged"
    assert db.get(File, rows[0].id).failure_code == "file_reservation_expired"
    assert db.get(File, rows[1].id).state == "uploading"
    assert db.get(File, rows[2].id).state == "awaiting_upload"


def _holds_quota_lock(db, org_id) -> bool:
    # pg_locks shows a bigint advisory key as its unsigned high and low 32 bits.
    key = quota_lock_key(org_id) & 0xFFFFFFFFFFFFFFFF
    # Read through the session's connection: the audit listener refuses raw ORM SQL.
    return bool(
        db.connection().scalar(
            text(
                "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' "
                "AND classid = CAST(:classid AS oid) AND objid = CAST(:objid AS oid) "
                "AND objsubid = 1 AND pid = pg_backend_pid() AND granted)"
            ),
            {"classid": key >> 32, "objid": key & 0xFFFFFFFF},
        )
    )


def test_reserve_expires_stale_reservations_and_keeps_the_quota_lock(guarded_db, monkeypatch):
    # The guarded fixture commits only savepoints, which never release a transaction lock.
    # Commit this owned fixture through real transactions so expiry commits are real.
    engine = guarded_db.get_bind().engine
    actor_id, stale_id = uuid4(), uuid4()
    context = AuditContext(request_id=uuid4(), request_method="POST", request_path="/api/test")
    with AuditSession(engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = context
        department_id = library_department(db)
        org_id = organization(db).id
        create_member(
                db, organization(db),
                id=actor_id,
                email=f"quota-lock-{actor_id}@example.com",
                username=f"quota_{actor_id.hex[:12]}",
                role="admin",
                status="active",
        )
        db.flush()
        db.add(
            File(
                org_id=org_id,
                id=stale_id,
                purpose="library_document",
                department_id=department_id,
                creator_id=actor_id,
                filename="stale.pdf",
                expected_size=1,
                object_key=uuid4().hex,
                state="awaiting_upload",
            )
        )
        db.flush()
        db.get(File, stale_id).created_at = datetime.now(UTC) - timedelta(hours=25)
        db.commit()
    checks = []
    require_capacity = service.require_capacity

    def checked(db, purpose, expected_size, *, creator_id):
        checks.append(_holds_quota_lock(db, org_id))
        require_capacity(db, purpose, expected_size, creator_id=creator_id)

    monkeypatch.setattr(service, "require_capacity", checked)
    created = None
    try:
        with AuditSession(engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = context
            scope_session(db, org_id)
            created = service.reserve(
                db,
                db.get(User, actor_id),
                FileCreate(
                    purpose="library_document",
                    department_id=department_id,
                    filename="new.pdf",
                    expected_size=1,
                ),
            ).id
            expired = db.get(File, stale_id)
            assert expired.state == "purged"
            assert expired.failure_code == "file_reservation_expired"
        assert checks == [True]
    finally:
        with AuditSession(engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = context
            for file_id in (stale_id, created):
                file = db.get(File, file_id) if file_id is not None else None
                if file is not None:
                    db.delete(file)
            db.flush()
            department = db.get(Department, department_id)
            if department is not None:
                db.delete(department)
            db.flush()
            for membership in db.scalars(select(Membership).where(Membership.user_id == actor_id)):
                db.delete(membership)
            db.flush()
            actor = db.get(User, actor_id)
            if actor is not None:
                db.delete(actor)
            db.commit()
        with engine.begin() as cleanup:
            cleanup.execute(text("DELETE FROM public.audit_logs WHERE org_id = :id"),
                            {"id": org_id})
            cleanup.execute(text("DELETE FROM public.organizations WHERE id = :id"),
                            {"id": org_id})


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


def test_full_pending_uploads_do_not_prevent_confirmed_cleanup(guarded_db, actor, monkeypatch):
    db = guarded_db
    actor_id = actor.id
    inventory(db, actor, count=100)
    ready = File(
        org_id=organization(db).id,
        purpose="library_document",
        department_id=library_department(db),
        creator_id=actor_id,
        filename="ready.pdf",
        expected_size=1,
        actual_size=1,
        digest="a" * 64,
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


def test_expiration_skips_a_locked_reservation_without_waiting(guarded_db):
    # Real transactions: the second session must hold its row lock independently.
    engine = guarded_db.get_bind().engine
    actor_id, stale_id = uuid4(), uuid4()
    context = AuditContext(request_id=uuid4(), request_method="POST", request_path="/api/test")
    now = datetime.now(UTC)
    with AuditSession(engine) as db:
        db.info[AUDIT_CONTEXT_KEY] = context
        department_id = library_department(db)
        org_id = organization(db).id
        create_member(
                db, organization(db),
                id=actor_id,
                email=f"expiry-lock-{actor_id}@example.com",
                username=f"expiry_{actor_id.hex[:12]}",
                role="admin",
                status="active",
        )
        db.flush()
        db.add(
            File(
                org_id=org_id,
                id=stale_id,
                purpose="library_document",
                department_id=department_id,
                creator_id=actor_id,
                filename="locked.pdf",
                expected_size=1,
                object_key=uuid4().hex,
                state="awaiting_upload",
            )
        )
        db.flush()
        db.get(File, stale_id).created_at = now - timedelta(hours=25)
        db.commit()
    try:
        with Session(engine) as holder:
            holder.get(File, stale_id, with_for_update=True)
            with AuditSession(engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = context
                assert service.expire_unused_reservations(db, now) == 0
            holder.rollback()
        with AuditSession(engine) as db:
            assert db.get(File, stale_id).state == "awaiting_upload"
    finally:
        with AuditSession(engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = context
            file = db.get(File, stale_id)
            if file is not None:
                db.delete(file)
            db.flush()
            department = db.get(Department, department_id)
            if department is not None:
                db.delete(department)
            db.flush()
            for membership in db.scalars(select(Membership).where(Membership.user_id == actor_id)):
                db.delete(membership)
            db.flush()
            actor = db.get(User, actor_id)
            if actor is not None:
                db.delete(actor)
            db.commit()
        with engine.begin() as cleanup:
            cleanup.execute(text("DELETE FROM public.audit_logs WHERE org_id = :id"),
                            {"id": org_id})
            cleanup.execute(text("DELETE FROM public.organizations WHERE id = :id"),
                            {"id": org_id})


def test_expiration_skips_a_reservation_whose_parent_refuses_and_expires_the_rest(
    guarded_db, actor, monkeypatch
):
    db = guarded_db
    blocked, stale = inventory(db, actor, count=2)
    for row in (blocked, stale):
        row.is_deleted = False
        row.created_at = datetime.now(UTC) - timedelta(hours=25)
    db.commit()
    blocked_id, stale_id = blocked.id, stale.id
    original = service.load

    def load(session, file_id, **options):
        if file_id == blocked_id:
            raise HTTPException(409, detail={"code": "file_parent_closed"})
        return original(session, file_id, **options)

    monkeypatch.setattr(service, "load", load)
    assert service.expire_unused_reservations(db, datetime.now(UTC)) == 1
    assert db.get(File, blocked_id).state == "awaiting_upload"
    assert db.get(File, stale_id).state == "purged"


def test_expiry_during_a_reservation_is_attributed_to_the_system(guarded_db, actor):
    # Review finding A: expiring other people's stale reservations inside a user's request
    # recorded that user as the actor in the audit log.
    db = guarded_db
    request = AuditContext(
        performed_by=actor.id, request_id=uuid4(), request_method="POST", request_path="/api/f"
    )
    db.info[AUDIT_CONTEXT_KEY] = request
    (stale,) = inventory(db, actor, count=1)
    stale.created_at = datetime.now(UTC) - timedelta(hours=25)
    db.commit()

    created = service.reserve(
        db,
        actor,
        FileCreate(
            purpose="library_document",
            department_id=library_department(db),
            filename="new.pdf",
            expected_size=1,
        ),
    )

    assert db.get(File, stale.id).state == "purged"
    assert db.info[AUDIT_CONTEXT_KEY] is request

    def entries(file_id, action):
        return db.scalars(
            select(AuditLog).where(
                AuditLog.entity_type == File.__tablename__,
                AuditLog.entity_id == file_id,
                AuditLog.action == action,
            )
        ).all()

    (expiry,) = entries(stale.id, AuditAction.UPDATE)
    assert expiry.performed_by is None
    assert (expiry.request_method, expiry.request_path) == ("SYSTEM", "/internal/files/expire")
    assert expiry.request_id != request.request_id
    (reservation,) = entries(created.id, AuditAction.CREATE)
    assert reservation.performed_by == actor.id
    assert reservation.request_id == request.request_id
