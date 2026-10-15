"""Department-library routes exercise real direct grants and persisted file state."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel, GroupAccess
from app.systems.access.users.membership import sole_active_membership
from app.systems.platform.files import delivery, service
from app.systems.platform.files.models import File
from app.systems.platform.files.validation import ValidatedContent
from app.systems.sandbox.records.models import Record
from tests.files.test_workspace_policy_integration import _client, _png, _Store
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("revocation", ["expiry-grant", "quota-account"])
def test_library_reservation_rechecks_authority_at_final_admission(
    guarded_db, monkeypatch, revocation
):
    db = guarded_db
    actor = add_user(db)
    department = add_department(db)
    grant = make_group_access(db, [actor], department, level=AccessLevel.WRITE)
    db.commit()
    if revocation == "expiry-grant":
        original_expiry = service.expire_unused_reservations

        def expire(session, now):
            session.delete(session.get(GroupAccess, grant.id))
            session.commit()
            return original_expiry(session, now)

        monkeypatch.setattr(service, "expire_unused_reservations", expire)
    else:
        original_quota = service.lock_quota

        def lock(session):
            original_quota(session)
            session.get(type(actor), actor.id).status = "disabled"
            session.commit()

        monkeypatch.setattr(service, "lock_quota", lock)
    with _client(db, actor, _Store(db)) as client:
        response = reserve_request(client, department)
    assert response.status_code == (404 if revocation == "expiry-grant" else 403), response.text
    assert db.scalar(select(File.id).where(File.creator_id == actor.id)) is None


def library_file(
    db, creator, department, *, state="ready", archived=False, size=None, name="guide.png"
):
    content = _png()
    file = File(
        org_id=department.org_id,
        purpose="library_document",
        department_id=department.id,
        creator_id=creator.id,
        filename=name,
        expected_size=size or len(content),
        object_key=uuid7().hex,
        state=state,
        is_deleted=archived,
        deleted_at=datetime.now(UTC) if archived else None,
        actual_size=(size or len(content)) if state in {"ready", "uploading"} else None,
        media_type="image/png" if state == "ready" else None,
        digest=sha256(content).hexdigest() if state == "ready" else None,
    )
    db.add(file)
    db.commit()
    return file


def reserve_request(client, department):
    return client.post(
        "/api/files",
        json={
            "purpose": "library_document",
            "department_id": str(department.id),
            "filename": "guide.png",
            "expected_size": len(_png()),
        },
    )


@pytest.mark.parametrize(
    "role,level,can_write,can_manage",
    [
        ("admin", None, True, True),
        ("member", AccessLevel.READ, False, False),
        ("member", AccessLevel.WRITE, True, False),
        ("member", AccessLevel.MANAGE, True, True),
        ("guest", AccessLevel.MANAGE, False, False),
    ],
)
def test_library_routes_apply_direct_department_action_levels(
    guarded_db,
    monkeypatch,
    role,
    level,
    can_write,
    can_manage,
):
    db = guarded_db
    actor = add_user(db, role=role)
    department = add_department(db)
    if level is not None:
        make_group_access(db, [actor], department, level=level)
    file = library_file(db, actor, department)
    storage = _Store(db)
    storage.objects[file.object_key] = _png()
    monkeypatch.setattr(delivery, "append_committed_security_event", lambda _event: None)
    with _client(db, actor, storage) as client:
        path = f"/api/files/{file.id}"
        assert client.get(path).status_code == 200
        assert client.get(path + "/content").content == _png()
        listed = client.get(
            "/api/files",
            params={"purpose": "library_document", "department_id": str(department.id)},
        )
        assert listed.status_code == 200, listed.text
        reserved = reserve_request(client, department)
        assert reserved.status_code == (201 if can_write else 403), reserved.text
        if can_write:
            uploaded = client.put(
                f"/api/files/{reserved.json()['id']}/content",
                content=_png(),
                headers={"Content-Type": "application/octet-stream"},
            )
            assert uploaded.status_code == 200 and uploaded.json()["state"] == "ready"
        archived = client.post(path + "/archive")
        assert archived.status_code == (200 if can_manage else 403), archived.text
        if can_manage:
            assert archived.json()["is_deleted"] is True
            reopened = client.post(path + "/reopen")
            assert reopened.status_code == 200 and reopened.json()["is_deleted"] is False
        if role != "admin":
            assert client.post(path + "/reconcile").status_code == 403


@pytest.mark.parametrize("grant_kind", ["none", "module-only", "other-department"])
def test_library_denials_hide_metadata_and_release_no_bytes_or_writes(guarded_db, grant_kind):
    db = guarded_db
    actor = add_user(db)
    department = add_department(db)
    if grant_kind == "module-only":
        module = add_module(db, department)
        make_group_access(db, [actor], department, module, level=AccessLevel.MANAGE)
    elif grant_kind == "other-department":
        make_group_access(db, [actor], add_department(db), level=AccessLevel.MANAGE)
    file = library_file(db, actor, department)
    storage = _Store(db)
    storage.objects[file.object_key] = _png()
    with _client(db, actor, storage) as client:
        path = f"/api/files/{file.id}"
        for closed in (False, True):
            department.is_deleted = closed
            department.deleted_at = datetime.now(UTC) if closed else None
            db.commit()
            assert (
                client.get(
                    "/api/files",
                    params={"purpose": "library_document", "department_id": str(department.id)},
                ).status_code
                == 404
            )
            assert client.get(path).status_code == 404
            assert client.get(path + "/content").status_code == 404
            assert reserve_request(client, department).status_code == 404
            assert client.post(path + "/archive").status_code == 404
            denied_writes = {
                "reopen": client.post(path + "/reopen").status_code,
                "upload": client.put(
                    path + "/content",
                    content=_png(),
                    headers={"Content-Type": "application/octet-stream"},
                ).status_code,
            }
            assert denied_writes == {"reopen": 404, "upload": 404}
    assert file.is_deleted is False and storage.objects[file.object_key] == _png()


@pytest.mark.parametrize("state", ["disabled", "pending", "expired", "deleted"])
def test_inactive_library_accounts_cannot_read_or_reserve(guarded_db, state):
    db = guarded_db
    actor = add_user(db)
    department = add_department(db)
    make_group_access(db, [actor], department, level=AccessLevel.MANAGE)
    file = library_file(db, actor, department)
    if state in {"disabled", "pending"}:
        actor.status = state
    elif state == "expired":
        sole_active_membership(db, actor.id).expires_at = datetime.now(UTC) - timedelta(seconds=1)
    else:
        actor.is_deleted = True
    db.commit()
    with _client(db, actor, _Store(db)) as client:
        assert client.get(f"/api/files/{file.id}").status_code == 403
        assert reserve_request(client, department).status_code == 403


def test_closed_library_parent_allows_read_download_archive_but_refuses_active_writes(
    guarded_db, monkeypatch
):
    db = guarded_db
    actor = add_user(db)
    department = add_department(db)
    make_group_access(db, [actor], department, level=AccessLevel.MANAGE)
    ready = library_file(db, actor, department)
    pending = library_file(db, actor, department, state="awaiting_upload")
    department.is_deleted, department.deleted_at = True, datetime.now(UTC)
    db.commit()
    storage = _Store(db)
    storage.objects[ready.object_key] = _png()
    monkeypatch.setattr(delivery, "append_committed_security_event", lambda _event: None)
    with _client(db, actor, storage) as client:
        path = f"/api/files/{ready.id}"
        assert (
            client.get(
                "/api/files",
                params={"purpose": "library_document", "department_id": str(department.id)},
            ).status_code
            == 200
        )
        assert client.get(path).status_code == 200
        assert client.get(path + "/content").content == _png()
        assert client.post(path + "/archive").status_code == 200
        assert client.post(path + "/reopen").status_code == 409
        assert reserve_request(client, department).status_code == 409
        assert (
            client.put(
                f"/api/files/{pending.id}/content",
                content=_png(),
                headers={"Content-Type": "application/octet-stream"},
            ).status_code
            == 409
        )
    assert pending.state == "awaiting_upload"


@pytest.mark.parametrize("stage", ["parser", "upload", "download"])
def test_library_transfer_rechecks_permission_or_parent_after_latency(
    guarded_db, monkeypatch, stage
):
    db = guarded_db
    actor = add_user(db)
    department = add_department(db)
    grant = make_group_access(db, [actor], department, level=AccessLevel.MANAGE)
    file = library_file(
        db, actor, department, state="ready" if stage == "download" else "awaiting_upload"
    )
    storage = _Store(db)
    storage.objects[file.object_key] = _png() if stage == "download" else b""

    def revoke():
        db.delete(db.get(GroupAccess, grant.id))
        db.commit()

    if stage == "parser":

        def parser(_filename, content, *, logo):
            revoke()
            return ValidatedContent(content, "image/png")

        monkeypatch.setattr(service, "validate_bounded", parser)
    elif stage == "upload":

        def upload(key, content, media_type):
            department.is_deleted, department.deleted_at = True, datetime.now(UTC)
            db.commit()
            storage.objects[key] = content

        storage.upload = upload
    else:

        def download(key):
            revoke()
            return storage.objects[key]

        storage.download = download
    with _client(db, actor, storage) as client:
        path = f"/api/files/{file.id}/content"
        response = (
            client.get(path)
            if stage == "download"
            else client.put(
                path, content=_png(), headers={"Content-Type": "application/octet-stream"}
            )
        )
    assert response.status_code == (409 if stage == "upload" else 404), response.text
    if stage == "parser":
        assert storage.objects[file.object_key] == b"" and file.state == "awaiting_upload"
    elif stage == "upload":
        assert db.get(File, file.id).state == "uploading"


@pytest.mark.parametrize(
    "payload",
    [
        {"purpose": "library_document"},
        {"purpose": "library_document", "department_id": None},
        {"purpose": "library_document", "department_id": "invalid"},
        {"purpose": "workspace_logo", "department_id": str(uuid7())},
        {"purpose": "record_attachment", "record_id": str(uuid7()), "department_id": str(uuid7())},
        {"purpose": "library_document", "department_id": str(uuid7()), "record_id": str(uuid7())},
    ],
)
def test_library_http_rejects_invalid_parent_combinations(guarded_db, actor, payload):
    with _client(guarded_db, actor, _Store(guarded_db)) as client:
        response = client.post(
            "/api/files", json={"filename": "guide.png", "expected_size": len(_png()), **payload}
        )
    assert response.status_code == 422


def test_library_missing_department_is_not_found_and_record_envelope_stays_standard(
    guarded_db, actor
):
    db = guarded_db
    department = add_department(db)
    module = add_module(db, department)
    record = Record(org_id=module.org_id, module_id=module.id, data={})
    db.add(record)
    db.commit()
    with _client(db, actor, _Store(db)) as client:
        assert (
            reserve_request(client, type("MissingDepartment", (), {"id": uuid7()})()).status_code
            == 404
        )
        created = client.post(
            "/api/files",
            json={
                "purpose": "record_attachment",
                "record_id": str(record.id),
                "filename": "guide.png",
                "expected_size": len(_png()),
            },
        )
        assert created.status_code == 201, created.text
        assert created.json()["department_id"] is None
        listed = client.get(
            "/api/files", params={"purpose": "record_attachment", "record_id": str(record.id)}
        )
        assert set(listed.json()) == {"items", "pagination"}
        assert listed.json()["items"][0]["department_id"] is None


def test_department_writer_reserves_a_library_file(guarded_db):
    db = guarded_db
    writer = add_user(db)
    department = add_department(db)
    make_group_access(db, [writer], department, level=AccessLevel.WRITE)
    db.commit()
    with _client(db, writer, _Store(db)) as client:
        response = client.post(
            "/api/files",
            json={
                "purpose": "library_document",
                "department_id": str(department.id),
                "filename": "guide.png",
                "expected_size": len(_png()),
            },
        )
    assert response.status_code == 201, response.text
    assert response.json()["department_id"] == str(department.id)
    assert response.json()["record_id"] is None and response.json()["board_id"] is None
