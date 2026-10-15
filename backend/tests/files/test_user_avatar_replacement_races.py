"""Committed avatar replacement, cleanup failures and deterministic fencing."""

from datetime import timedelta
from threading import Event, Thread
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.quota import lock_quota
from tests.files.user_avatar_support import (
    actor_role,
    binding,
    native_avatar,
    profile_patch,
    stored_file,
)
from tests.files.user_avatar_support import (
    avatar_world as avatar_world,
)
from tests.files.user_avatar_support import (
    policy_world as policy_world,
)

pytestmark = pytest.mark.integration


def test_replacement_commits_binding_and_deletion_intent_before_unlocked_io(avatar_world):
    world = avatar_world
    old, old_key = native_avatar(world, bind=True)
    new, _ = native_avatar(world)
    observed = []

    def independent_locks():
        with Session(world.owner) as db:
            lock_quota(db)
            user = db.scalar(
                select(User).where(User.id == world.actor_id).with_for_update(nowait=True)
            )
            file = db.scalar(select(File).where(File.id == old).with_for_update(nowait=True))
            assert user.avatar_file_id == new
            assert file.state == "deleting" and file.deletion_origin == "avatar_replacement"
            assert file.operation_id is not None
            observed.append(True)

    world.storage.delete_effect = independent_locks
    assert profile_patch(world, avatar_file_id=str(new)).status_code == 200
    assert observed == [True] and world.storage.deleted == [old_key]
    assert stored_file(world, old).state == "purged" and binding(world)[0] == new


@pytest.mark.parametrize("failure", ["raise", "absence_unconfirmed"])
def test_cleanup_partial_503_keeps_saved_profile_and_admin_only_reconciliation(
    avatar_world, failure
):
    world = avatar_world
    old, old_key = native_avatar(world, bind=True)
    new, _ = native_avatar(world)

    def fail():
        raise ProviderUnavailable("private-canary")

    if failure == "raise":
        world.storage.delete_effect = fail
    else:
        world.storage.delete = lambda _key: None
    refused = profile_patch(world, avatar_file_id=str(new), bio="Saved despite cleanup")
    assert refused.status_code == 503 and "private-canary" not in refused.text
    assert refused.json()["detail"]["code"] == "profile_avatar_cleanup_partial"
    assert binding(world) == (new, None, "Saved despite cleanup")
    read = world.client.get("/api/auth/me", headers=world.headers())
    assert read.json()["avatar_file_id"] == str(new)
    assert old_key in world.storage.objects and stored_file(world, old).state == "deleting"
    # A same-binding retry never retries cleanup or claims/deletes the current image.
    assert profile_patch(world, avatar_file_id=str(new)).status_code == 200
    assert stored_file(world, new).state == "ready"
    actor_role(world, "member")
    assert (
        world.client.post(f"/api/files/{old}/reconcile", headers=world.headers()).status_code == 403
    )
    actor_role(world, "admin")
    world.storage.delete_effect = None
    world.storage.delete = lambda key: world.storage.objects.pop(key, None)
    done = world.client.post(f"/api/files/{old}/reconcile", headers=world.headers())
    assert done.status_code == 200 and done.json()["state"] == "purged"
    assert binding(world)[0] == new and old_key not in world.storage.objects


def test_late_cleanup_never_overwrites_a_second_committed_avatar_replacement(avatar_world):
    world = avatar_world
    old, old_key = native_avatar(world, bind=True)
    second, second_key = native_avatar(world)
    third, _ = native_avatar(world)
    entered, release = Event(), Event()
    outcomes = []

    def delayed():
        entered.set()
        assert release.wait(10)

    world.storage.delete_effect = delayed
    worker = Thread(
        target=lambda: outcomes.append(profile_patch(world, avatar_file_id=str(second)))
    )
    worker.start()
    try:
        assert entered.wait(10)
        world.storage.delete_effect = None
        saved = world.client.patch(
            "/api/auth/me/profile",
            headers=world.headers(slot=1),
            json={"avatar_file_id": str(third)},
        )
        assert saved.status_code == 200, saved.text
    finally:
        release.set()
        worker.join(15)
    assert not worker.is_alive() and outcomes[0].status_code == 200
    assert binding(world)[0] == third
    assert set(world.storage.deleted) == {old_key, second_key}
    assert stored_file(world, old).state == stored_file(world, second).state == "purged"


def test_failed_commit_rolls_back_binding_claim_and_text_without_storage_effect(avatar_world):
    world = avatar_world
    old, _ = native_avatar(world, bind=True)
    new, _ = native_avatar(world)

    def fail_commit(db):
        db.flush()
        raise SQLAlchemyError("private-canary")

    with patch.object(AuditSession, "commit", fail_commit):
        refused = profile_patch(world, avatar_file_id=str(new), phone="must roll back")
    assert refused.status_code == 503
    assert binding(world) == (old, None, None)
    assert stored_file(world, old).state == "ready" and not world.storage.deleted


@pytest.mark.parametrize(
    "defect", ["foreign", "wrong_purpose", "awaiting", "archived", "operation"]
)
def test_profile_refuses_unbindable_avatar_without_mutating_old_binding(avatar_world, defect):
    from uuid import uuid4

    world = avatar_world
    old, _ = native_avatar(world, bind=True)
    if defect == "wrong_purpose":
        from app.systems.access.users.models import Membership

        with Session(world.owner) as db:
            org_id = db.scalars(
                select(Membership.org_id).where(Membership.user_id == world.actor_id)
            ).one()
        new, _ = native_avatar(world, purpose="workspace_logo", org_id=org_id)
    else:
        new, _ = native_avatar(world, owner_id=world.target_id if defect == "foreign" else None)
    with Session(world.owner) as db:
        file = db.get(File, new)
        if defect == "awaiting":
            file.state = "awaiting_upload"
        elif defect == "archived":
            file.is_deleted = True
        elif defect == "operation":
            file.operation_id = uuid4()
            file.operation_expires_at = world.clock + timedelta(seconds=30)
        db.commit()
    refused = profile_patch(world, avatar_file_id=str(new), phone="Must not persist")
    assert refused.status_code in (404, 409)
    assert binding(world) == (old, None, None) and not world.storage.deleted


def test_bound_avatar_cannot_be_archived_or_reconciled_but_null_removal_cleans_owned_bytes(
    avatar_world,
):
    world = avatar_world
    file_id, key = native_avatar(world, bind=True)
    for command in ("archive", "reconcile"):
        assert (
            world.client.post(
                f"/api/files/{file_id}/{command}", headers=world.headers()
            ).status_code
            == 409
        )
    assert key in world.storage.objects and stored_file(world, file_id).state == "ready"
    assert profile_patch(world, avatar_file_id=None).status_code == 200
    assert binding(world)[0] is None and key not in world.storage.objects
