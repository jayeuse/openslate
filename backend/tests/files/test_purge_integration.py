"""Purge confirmation and interrupted deletion regression tests."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.systems.access.users.models import User
from app.systems.platform.files import service
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from tests.files.test_integration import Store, reserve

pytestmark = pytest.mark.integration


def test_library_purge_fingerprint_tracks_direct_department_ownership(
    guarded_db, actor, monkeypatch
):
    from types import SimpleNamespace

    from app.systems.platform.files.lifecycle_router import purge_impact
    from tests.files.test_library_routes import library_file
    from tests.rbac.support import add_department

    db = guarded_db
    department, other = add_department(db), add_department(db)
    file = library_file(db, actor, department, state="awaiting_upload", archived=True)
    monkeypatch.setattr(
        "app.systems.platform.files.lifecycle_router.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    first = purge_impact(db, actor.id, file.id).rows[0].state_fingerprint
    file.department_id = other.id
    db.commit()
    second = purge_impact(db, actor.id, file.id).rows[0].state_fingerprint
    assert first != second


def test_purge_rejects_active_or_current_logo_and_deletes_only_archived_inventory(
    guarded_db, actor, monkeypatch
):
    from types import SimpleNamespace

    from app.systems.manage.workspace.models import WorkspaceProfile
    from app.systems.platform.files.lifecycle_router import purge_impact
    from app.systems.platform.files.purge import purge_confirmed

    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    monkeypatch.setattr(
        "app.systems.platform.files.lifecycle_router.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    monkeypatch.setattr(
        "app.systems.platform.files.purge.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    with pytest.raises(HTTPException) as caught:
        purge_impact(db, actor_id, file_id)
    assert caught.value.detail["code"] == "close_required"
    db.rollback()
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    service.archive(db, actor_id, file_id)
    impact = purge_impact(db, actor_id, file_id)
    assert impact.rows[0].state_fingerprint
    assert "object_key" not in impact.model_dump_json()
    profile = db.scalar(select(WorkspaceProfile))
    profile.logo_file_id = file_id
    db.commit()
    with pytest.raises(HTTPException) as caught:
        purge_impact(db, actor_id, file_id)
    assert caught.value.detail["code"] == "file_current_logo"
    db.rollback()
    profile = db.scalar(select(WorkspaceProfile))
    profile.logo_file_id = None
    db.commit()
    result = purge_confirmed(
        db, actor_id, file_id, storage, validate_locked=lambda: purge_impact(db, actor_id, file_id)
    )
    assert result.state == "purged"
    assert storage.objects == {}
    assert db.get(File, file_id) is not None


def test_changed_file_after_password_verification_rejects_purge(
    guarded_db, actor, monkeypatch, file_request
):
    from types import SimpleNamespace

    from fastapi import Response

    from app.systems.platform.files import lifecycle_router
    from app.systems.sandbox.lifecycle.schemas import LifecyclePurgeRequest

    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    service.archive(db, actor_id, file_id)
    monkeypatch.setattr(
        lifecycle_router, "get_settings", lambda: SimpleNamespace(lifecycle_purge_enabled=True)
    )
    monkeypatch.setattr(
        "app.systems.platform.files.purge.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    digest = lifecycle_router.purge_impact(db, actor_id, file_id).impact_digest
    db.commit()
    monkeypatch.setattr(lifecycle_router, "challenge_impact_digest", lambda *args: digest)

    def verify(*args):
        file = db.get(File, file_id)
        file.failure_code = "changed"
        db.commit()
        return SimpleNamespace(impact_digest=digest)

    monkeypatch.setattr(lifecycle_router, "verify_challenge", verify)
    with pytest.raises(HTTPException) as caught:
        lifecycle_router.execute(
            file_request,
            file_id,
            LifecyclePurgeRequest(token="test", password="test", confirmation_name=str(file_id)),
            db.get(User, actor_id),
            db,
            Store(db),
            Response(),
        )
    assert caught.value.detail["code"] == "plan_drift"
    assert db.get(File, file_id).state == "awaiting_upload"


def test_delete_provider_failure_keeps_inventory_and_resume_confirmed_delete(
    guarded_db, actor, monkeypatch
):
    from types import SimpleNamespace

    from app.systems.platform.files.purge import purge_confirmed

    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    storage = Store(db)
    service.upload(db, actor_id, file_id, content, storage)
    service.archive(db, actor_id, file_id)
    monkeypatch.setattr(
        "app.systems.platform.files.purge.get_settings",
        lambda: SimpleNamespace(lifecycle_purge_enabled=True),
    )
    original = storage.delete

    def failed_delete(key):
        raise ProviderUnavailable("failure")

    storage.delete = failed_delete
    with pytest.raises(HTTPException) as caught:
        purge_confirmed(db, actor_id, file_id, storage)
    assert caught.value.detail["code"] == "deletion_unresolved"
    assert db.get(File, file_id).state == "deleting"
    storage.delete = original
    assert service.reconcile(db, actor_id, file_id, storage).state == "purged"


def test_definitive_upload_rejection_is_purgeable_not_unresolved(guarded_db, actor):
    from app.systems.platform.files.providers import ProviderRejected

    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)

    class Reject(Store):
        def upload(self, *args):
            raise ProviderRejected("no write admitted")

    with pytest.raises(HTTPException) as caught:
        service.upload(db, actor_id, file_id, content, Reject(db))
    assert caught.value.detail["code"] == "upload_rejected"
    assert db.get(File, file_id).state == "rejected"


def test_purge_preview_issues_actor_bound_token_and_missing_token_does_not_delete(
    guarded_db, actor, monkeypatch, file_request
):
    from types import SimpleNamespace

    from fastapi import Response

    from app.systems.platform.files import lifecycle_router
    from app.systems.sandbox.lifecycle.schemas import LifecyclePurgeRequest

    db = guarded_db
    actor_id = actor.id
    file_id, content = reserve(db, actor)
    service.archive(db, actor_id, file_id)
    monkeypatch.setattr(
        lifecycle_router, "get_settings", lambda: SimpleNamespace(lifecycle_purge_enabled=False)
    )
    with pytest.raises(HTTPException) as caught:
        lifecycle_router.preview(file_id, db.get(User, actor_id), db, Response())
    assert caught.value.detail["code"] == "purge_disabled"
    db.rollback()
    monkeypatch.setattr(
        lifecycle_router, "get_settings", lambda: SimpleNamespace(lifecycle_purge_enabled=True)
    )
    preview = lifecycle_router.preview(file_id, db.get(User, actor_id), db, Response())
    assert preview.confirmation_name == str(file_id) and preview.token
    with pytest.raises(HTTPException) as caught:
        lifecycle_router.execute(
            file_request,
            file_id,
            LifecyclePurgeRequest(token="missing", password="test", confirmation_name=str(file_id)),
            db.get(User, actor_id),
            db,
            Store(db),
            Response(),
        )
    assert caught.value.status_code == 404
    assert caught.value.detail["code"] == "challenge_not_found"
    db.rollback()
    assert db.get(File, file_id).state == "awaiting_upload"
