"""Committed signed-auth journeys for replacement/removal and recoverable cleanup."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import inspect, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.manage.workspace import router
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.storage import get_storage
from tests.auth.session_policy_support import policy_world as policy_world

pytestmark = pytest.mark.integration


class LogoStore:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.effect: Callable[[], None] | None = None
        self.fail = False
        self.keep = False

    def upload(self, key, content, media_type):
        self.objects[key] = content

    def delete(self, key):
        self.deleted.append(key)
        if self.effect is not None:
            self.effect()
        if self.fail:
            raise ProviderUnavailable("Owned simulated dependency failure")
        if not self.keep:
            self.objects.pop(key, None)

    def download(self, key):
        return self.objects.get(key)


@pytest.fixture
def logo_world(policy_world, monkeypatch):
    world = policy_world
    world.storage = LogoStore()
    world.file_ids = []
    with Session(world.owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        world.profile_snapshot = {
            column.key: getattr(profile, column.key)
            for column in inspect(WorkspaceProfile).column_attrs
        }
    world.client.app.dependency_overrides[get_storage] = lambda: world.storage
    monkeypatch.setattr(router, "get_storage", lambda: world.storage)
    monkeypatch.setattr(
        "app.systems.platform.files.delivery.append_committed_security_event", lambda payload: None
    )
    try:
        yield world
    finally:
        with Session(world.owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            for field, value in world.profile_snapshot.items():
                setattr(profile, field, value)
            db.flush()
            for file in db.scalars(select(File).where(File.id.in_(world.file_ids))):
                db.delete(file)
            db.commit()


def ready_logo(world, *, bind=False, **values):
    output = BytesIO()
    Image.new("RGB", (2, 2), "blue").save(output, format="PNG")
    content = output.getvalue()
    identity, key = uuid4(), uuid4().hex
    with Session(world.owner) as db:
        file = File(
            id=identity,
            purpose="workspace_logo",
            creator_id=world.actor_id,
            filename="owned-logo.png",
            object_key=key,
            state="ready",
            expected_size=len(content),
            actual_size=len(content),
            media_type="image/png",
            digest=sha256(content).hexdigest(),
            **values,
        )
        db.add(file)
        if bind:
            db.flush()
            db.scalar(select(WorkspaceProfile)).logo_file_id = identity
        db.commit()
    world.file_ids.append(identity)
    world.storage.objects[key] = content
    return identity, key


def current(world):
    with Session(world.owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        return profile.logo_file_id, profile.revision, profile.display_name


def stored_file(world, identity):
    with Session(world.owner) as db:
        file = db.get(File, identity)
        return {column.key: getattr(file, column.key) for column in inspect(File).column_attrs}


def patch(world, **values):
    return world.client.patch(
        "/api/workspace",
        headers=world.headers(),
        json={"revision": current(world)[1], **values},
    )


@pytest.mark.parametrize("remove", [False, True])
def test_replacement_or_removal_commits_binding_and_purges_only_old_logo(logo_world, remove):
    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    new, new_key = ready_logo(world)
    before = current(world)
    result = patch(world, logo_file_id=None if remove else str(new), display_name="Saved brand")
    assert result.status_code == 200
    state = stored_file(world, old)
    assert state["state"] == "purged"
    assert state["is_deleted"] is True
    assert state["operation_id"] is None and state.get("deletion_origin") is None
    assert world.storage.deleted == [old_key]
    assert old_key not in world.storage.objects and new_key in world.storage.objects
    assert current(world) == (None if remove else new, before[1] + 1, "Saved brand")
    assert "deletion_origin" not in result.json()
    if not remove:
        read = world.client.get("/api/workspace/logo", headers=world.headers())
        assert read.status_code == 200 and read.content == world.storage.objects[new_key]


@pytest.mark.parametrize("change", ["omitted", "same", "absent"])
def test_nonreplacement_saves_never_delete_inventory(logo_world, change):
    world = logo_world
    old, key = ready_logo(world, bind=change != "absent")
    values = {"display_name": "Text settings"}
    if change == "same":
        values["logo_file_id"] = str(old)
    elif change == "absent":
        values["logo_file_id"] = None
    assert patch(world, **values).status_code == 200
    assert world.storage.deleted == [] and key in world.storage.objects
    assert stored_file(world, old)["state"] == "ready"


@pytest.mark.parametrize("failure", ["stale", "invalid", "commit", "role"])
def test_refused_admission_never_deletes_or_changes_the_old_binding(
    logo_world, monkeypatch, failure
):
    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    new, new_key = ready_logo(world)
    before = current(world)
    revision = before[1]
    if failure == "stale":
        assert patch(world, display_name="Competing committed brand").status_code == 200
        before = current(world)
    elif failure == "invalid":
        with Session(world.owner) as db:
            db.get(File, new).is_deleted = True
            db.commit()
    elif failure == "role":
        with Session(world.owner) as db:
            from app.systems.access.users.models import User

            db.get(User, world.actor_id).role = "member"
            db.commit()
    else:
        original = AuditSession.commit
        original_flush = AuditSession.flush

        def admission_flush(db, *args, **kwargs):
            if any(isinstance(row, WorkspaceProfile) for row in db.dirty):
                db.info["owned_logo_admission"] = True
            return original_flush(db, *args, **kwargs)

        def refused(db):
            if db.info.get("owned_logo_admission"):
                raise SQLAlchemyError("Owned pre-effect commit refusal")
            return original(db)

        monkeypatch.setattr(AuditSession, "flush", admission_flush)
        monkeypatch.setattr(AuditSession, "commit", refused)
    result = world.client.patch(
        "/api/workspace",
        headers=world.headers(),
        json={"revision": revision, "logo_file_id": str(new)},
    )
    assert result.status_code == {"stale": 409, "invalid": 409, "commit": 503, "role": 403}[failure]
    assert current(world) == before
    assert world.storage.deleted == []
    assert old_key in world.storage.objects and new_key in world.storage.objects
    assert stored_file(world, old)["state"] == "ready"


@pytest.mark.parametrize("fault", ["provider", "presence", "final_commit", "diagnostic_commit"])
def test_partial_keeps_new_binding_and_reconciles_exact_old_key(logo_world, monkeypatch, fault):
    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    new, new_key = ready_logo(world)
    world.storage.fail = fault in {"provider", "diagnostic_commit"}
    world.storage.keep = fault == "presence"
    original = AuditSession.commit

    def interrupted(db):
        if any(
            isinstance(row, File)
            and (
                fault == "final_commit"
                and row.state == "purged"
                or fault == "diagnostic_commit"
                and row.failure_code == "deletion_unresolved"
            )
            for row in db.dirty
        ):
            raise SQLAlchemyError("Owned post-effect commit refusal")
        return original(db)

    monkeypatch.setattr(AuditSession, "commit", interrupted)
    result = patch(world, logo_file_id=str(new))
    assert result.status_code == 503
    assert result.json()["detail"]["code"] == "workspace_logo_cleanup_partial"
    state = stored_file(world, old)
    assert current(world)[0] == new
    assert state["state"] == "deleting" and state["is_deleted"]
    assert state["deletion_origin"] == "logo_replacement" and state["operation_id"]
    assert new_key in world.storage.objects
    read = world.client.get("/api/workspace/logo", headers=world.headers())
    assert read.status_code == 200 and read.content == world.storage.objects[new_key]
    monkeypatch.setattr(AuditSession, "commit", original)
    world.storage.fail = world.storage.keep = False
    with Session(world.owner) as db:
        db.get(File, old).operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    retry = world.client.post(f"/api/files/{old}/reconcile", headers=world.headers())
    assert retry.status_code == 200
    assert retry.json()["state"] == "purged"
    assert stored_file(world, old)["deletion_origin"] is None
    assert world.storage.deleted == [old_key, old_key]
    assert current(world)[0] == new and new_key in world.storage.objects


def test_admitted_cleanup_finishes_after_actor_role_loss_but_new_reconcile_refuses(logo_world):
    from app.systems.access.users.models import User

    world = logo_world
    old, key = ready_logo(world, bind=True)
    new, _ = ready_logo(world)

    def lose_role():
        with Session(world.owner) as db:
            actor = db.get(User, world.actor_id)
            actor.role = "guest"
            actor.sponsor_user_id = world.target_id
            actor.expires_at = world.clock + timedelta(days=1)
            profile = db.scalar(select(WorkspaceProfile))
            profile.contact_email = "post-admission-private@example.test"
            db.commit()

    world.storage.effect = lose_role
    result = patch(world, logo_file_id=str(new))
    assert result.status_code == 200
    assert result.json()["contact_email"] == world.profile_snapshot["contact_email"]
    assert "post-admission-private@example.test" not in result.text
    assert stored_file(world, old)["state"] == "purged" and key not in world.storage.objects
    assert (
        world.client.post(f"/api/files/{old}/reconcile", headers=world.headers()).status_code == 403
    )


def test_manual_origin_reconciliation_stays_disabled_and_origin_is_private(logo_world, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "lifecycle_purge_enabled", False)
    world = logo_world
    identity, key = ready_logo(world, is_deleted=True)
    with Session(world.owner) as db:
        file = db.get(File, identity)
        file.state, file.operation_id = "deleting", uuid4()
        file.operation_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    result = world.client.post(f"/api/files/{identity}/reconcile", headers=world.headers())
    assert result.status_code == 403 and result.json()["detail"]["code"] == "purge_disabled"
    assert world.storage.deleted == [] and key in world.storage.objects
    response = world.client.get(f"/api/files/{identity}", headers=world.headers())
    assert response.status_code == 200 and "deletion_origin" not in response.json()


@pytest.mark.parametrize("remove", [False, True])
def test_archived_current_logo_can_be_replaced_or_removed_without_manual_inventory_cleanup(
    logo_world, remove
):
    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    new, new_key = ready_logo(world)
    unused, unused_key = ready_logo(
        world, is_deleted=True, deleted_at=world.clock - timedelta(days=1)
    )
    unused_before = stored_file(world, unused)
    archived = world.client.post(f"/api/files/{old}/archive", headers=world.headers())
    assert archived.status_code == 200
    archived_before = stored_file(world, old)
    assert archived_before["state"] == "ready" and archived_before["is_deleted"]
    assert archived_before["operation_id"] is None and current(world)[0] == old
    assert archived_before["deleted_at"] is not None
    result = patch(world, logo_file_id=None if remove else str(new))
    assert result.status_code == 200
    assert current(world)[0] == (None if remove else new)
    retired = stored_file(world, old)
    assert retired["state"] == "purged" and retired["is_deleted"]
    assert retired["deleted_at"] == archived_before["deleted_at"]
    assert retired["deletion_origin"] is None and retired["operation_id"] is None
    assert world.storage.deleted == [old_key]
    assert old_key not in world.storage.objects
    assert new_key in world.storage.objects and unused_key in world.storage.objects
    assert stored_file(world, unused) == unused_before
    assert unused_before["deletion_origin"] is None


def test_archived_same_id_stays_a_strict_new_candidate(logo_world):
    world = logo_world
    old, key = ready_logo(world, bind=True)
    assert (
        world.client.post(f"/api/files/{old}/archive", headers=world.headers()).status_code == 200
    )
    before, archived = current(world), stored_file(world, old)
    result = patch(world, logo_file_id=str(old))
    assert result.status_code == 409 and result.json()["detail"]["code"] == "logo_not_ready"
    assert current(world) == before and stored_file(world, old) == archived
    assert world.storage.deleted == [] and key in world.storage.objects
