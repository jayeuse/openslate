"""Authenticated avatar delivery rechecks real state across provider latency."""

from io import BytesIO

import pytest
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.quota import lock_quota
from tests.files.user_avatar_support import (
    actor_role,
    native_avatar,
    stored_file,
)
from tests.files.user_avatar_support import (
    avatar_world as avatar_world,
)
from tests.files.user_avatar_support import (
    policy_world as policy_world,
)

pytestmark = pytest.mark.integration


def read(world, identity=None):
    return world.client.get(
        f"/api/users/{identity or world.actor_id}/avatar", headers=world.headers()
    )


@pytest.mark.parametrize("role", ["member", "guest"])
def test_own_avatar_is_readable_without_shared_scope_and_preserves_image_safeguards(
    avatar_world, role
):
    world = avatar_world
    actor_role(world, role)
    _, key = native_avatar(world, bind=True)
    response = read(world)
    assert response.status_code == 200, response.text
    assert response.content == world.storage.objects[key]
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "no-store" in response.headers["cache-control"]
    assert "private" in response.headers["cache-control"]


@pytest.mark.parametrize("size", [64, 256])
def test_a_thumbnail_is_a_square_of_the_requested_size(avatar_world, size):
    world = avatar_world
    native_avatar(world, bind=True)
    response = world.client.get(
        f"/api/users/{world.actor_id}/avatar", params={"size": size}, headers=world.headers()
    )
    assert response.status_code == 200, response.text
    with Image.open(BytesIO(response.content)) as thumbnail:
        assert (thumbnail.format, thumbnail.size) == ("PNG", (size, size))
    assert "no-store" in response.headers["cache-control"]


def test_only_the_two_thumbnail_sizes_are_served(avatar_world):
    world = avatar_world
    native_avatar(world, bind=True)
    response = world.client.get(
        f"/api/users/{world.actor_id}/avatar", params={"size": 1024}, headers=world.headers()
    )
    assert response.status_code == 422


def test_avatar_download_holds_no_user_file_quota_or_session_locks_during_io(avatar_world):
    world = avatar_world
    file_id, _ = native_avatar(world, bind=True)
    observed = []

    def independent_locks():
        with Session(world.owner) as db:
            lock_quota(db)
            db.scalar(select(User).where(User.id == world.actor_id).with_for_update(nowait=True))
            db.scalar(select(File).where(File.id == file_id).with_for_update(nowait=True))
            db.scalar(
                select(IdentitySession)
                .where(IdentitySession.id == world.session_ids[0])
                .with_for_update(nowait=True)
            )
            observed.append(True)

    world.storage.read_effect = independent_locks
    assert read(world).status_code == 200
    assert observed == [True]


@pytest.mark.parametrize("mutation", ["replace", "archive", "revoke", "disable"])
def test_stale_avatar_or_identity_after_provider_latency_never_delivers_bytes(
    avatar_world, mutation
):
    world = avatar_world
    file_id, _ = native_avatar(world, bind=True)

    def mutate():
        with Session(world.owner) as db:
            if mutation == "replace":
                db.get(User, world.actor_id).avatar_file_id = None
            elif mutation == "archive":
                db.get(File, file_id).is_deleted = True
            elif mutation == "revoke":
                db.get(IdentitySession, world.session_ids[0]).revoked_at = world.clock
            else:
                db.get(User, world.actor_id).status = "disabled"
            db.commit()

    world.storage.read_effect = mutate
    refused = read(world)
    assert refused.status_code in (401, 403, 404, 409)
    assert refused.content != b"" and refused.headers["content-type"].startswith("application/json")
    assert stored_file(world, file_id).state == "ready"


@pytest.mark.parametrize("failure", ["absent", "corrupt", "provider"])
def test_avatar_provider_or_integrity_failure_is_truthful_unavailable(avatar_world, failure):
    world = avatar_world
    _, key = native_avatar(world, bind=True)
    if failure == "absent":
        world.storage.objects.clear()
    elif failure == "corrupt":
        world.storage.objects[key] = b"not matching the admitted image"
    else:

        def unavailable():
            raise ProviderUnavailable("private-storage-canary")

        world.storage.read_effect = unavailable
    refused = read(world)
    assert refused.status_code == 503
    assert "private-storage-canary" not in refused.text


def test_other_avatar_is_hidden_with_card_when_target_is_ineligible(avatar_world):
    world = avatar_world
    native_avatar(world, owner_id=world.target_id, bind=True)
    with Session(world.owner) as db:
        db.get(User, world.target_id).status = "disabled"
        db.commit()
    assert read(world, world.target_id).status_code == 404
    assert (
        world.client.get(f"/api/users/{world.target_id}/card", headers=world.headers()).status_code
        == 404
    )
