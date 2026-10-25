"""Authenticated avatar delivery rechecks real state across provider latency."""

from io import BytesIO
from threading import Barrier, Event, Thread

import pytest
from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.database.session import get_engine
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users import avatar_delivery
from app.systems.access.users.models import User
from app.systems.platform.files import providers
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable, transfer_slot
from app.systems.platform.files.quota import lock_quota
from app.systems.platform.scheduling import notification_router
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


# The patches of PD67 names below pass ``raising=False``: on the base revision those
# names do not exist, so the same tests run there and fail on the behavior itself.


def hold_actor_row(world):
    """Another request's exclusive lock on the reader's own row, held until committed."""
    holder = Session(world.owner)
    holder.scalar(select(User).where(User.id == world.actor_id).with_for_update())
    return holder


def test_three_parallel_reads_of_one_photo_by_one_session_all_succeed(
    avatar_world, monkeypatch
):
    world = avatar_world
    native_avatar(world, bind=True)
    downloading, release, third_admission = Barrier(3), Event(), Event()
    real_download, real_slots = world.storage.download, providers._slots
    entered = []

    def held_download(key):
        entered.append(key)
        if len(entered) <= 2:
            downloading.wait(10)
            assert release.wait(10)
        return real_download(key)

    class ObservedSlots:
        attempts = 0

        def acquire(self, **kwargs):
            ObservedSlots.attempts += 1
            if ObservedSlots.attempts == 3:
                third_admission.set()
            return real_slots.acquire(**kwargs)

        def release(self):
            real_slots.release()

    world.storage.download = held_download
    monkeypatch.setattr(providers, "_slots", ObservedSlots())
    # The bound itself is owned by the transfer lease tests; a loaded machine must not trip it.
    monkeypatch.setattr(avatar_delivery, "AVATAR_SLOT_WAIT_SECONDS", 30, raising=False)
    statuses = []

    def fetch(size):
        statuses.append(world.client.get(
            f"/api/users/{world.actor_id}/avatar", params={"size": size},
            headers=world.headers(),
        ).status_code)

    # The Profile view, account row and header load 256- and 64-pixel photos at once.
    threads = [Thread(target=fetch, args=(size,)) for size in (64, 256, 64)]
    try:
        for thread in threads[:2]:
            thread.start()
        downloading.wait(10)  # Both transfer slots are now held by in-flight reads.
        threads[2].start()
        assert third_admission.wait(10)
    finally:
        release.set()
        for thread in threads:
            thread.join(15)
    assert not any(thread.is_alive() for thread in threads)
    assert sorted(statuses) == [200, 200, 200]


def test_a_photo_read_waiting_for_a_slot_holds_no_pooled_connection(avatar_world, monkeypatch):
    world = avatar_world
    native_avatar(world, bind=True)
    real_slots, pool = providers._slots, get_engine().pool
    checked_out, waiting = [], Event()

    class ObservedSlots:
        def acquire(self, **kwargs):
            checked_out.append(pool.checkedout())
            waiting.set()
            return real_slots.acquire(**kwargs)

        def release(self):
            real_slots.release()

    monkeypatch.setattr(avatar_delivery, "AVATAR_SLOT_WAIT_SECONDS", 30, raising=False)
    statuses = []
    with transfer_slot(), transfer_slot():
        monkeypatch.setattr(providers, "_slots", ObservedSlots())
        idle = pool.checkedout()
        worker = Thread(target=lambda: statuses.append(read(world).status_code))
        worker.start()
        assert waiting.wait(10)
    worker.join(15)
    assert not worker.is_alive()
    assert checked_out == [idle] and statuses == [200]


def test_a_photo_read_retries_past_a_brief_row_lock_held_by_another_request(
    avatar_world, monkeypatch
):
    world = avatar_world
    native_avatar(world, bind=True)
    progressed, released = Event(), Event()
    pauses = []

    def paused(seconds):
        pauses.append(seconds)
        progressed.set()
        assert released.wait(10)

    monkeypatch.setattr(avatar_delivery, "sleep", paused, raising=False)
    statuses = []

    def fetch():
        try:
            statuses.append(read(world).status_code)
        finally:
            progressed.set()

    holder = hold_actor_row(world)
    worker = Thread(target=fetch)
    try:
        worker.start()
        assert progressed.wait(10)
        holder.commit()
    finally:
        released.set()
        holder.close()
        worker.join(15)
    assert not worker.is_alive()
    assert statuses == [200] and len(pauses) == 1


def test_a_photo_read_gives_up_with_503_while_the_row_stays_locked(avatar_world, monkeypatch):
    world = avatar_world
    native_avatar(world, bind=True)
    pauses = []
    monkeypatch.setattr(avatar_delivery, "sleep", pauses.append, raising=False)
    holder = hold_actor_row(world)
    try:
        refused = read(world)
    finally:
        holder.close()
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "avatar_unavailable"
    assert len(pauses) == 2


def test_a_photo_read_does_not_retry_other_database_failures(avatar_world, monkeypatch):
    world = avatar_world
    native_avatar(world, bind=True)
    attempts, pauses = [], []

    def failing(_db, _identity, target_id):
        attempts.append(target_id)
        raise OperationalError("SELECT 1", {}, Exception("server closed the connection"))

    monkeypatch.setattr(avatar_delivery, "_bound_avatar", failing)
    monkeypatch.setattr(avatar_delivery, "sleep", pauses.append, raising=False)
    refused = read(world)
    assert refused.status_code == 503
    assert refused.json()["detail"]["code"] == "avatar_unavailable"
    assert len(attempts) == 1 and pauses == []


@pytest.mark.parametrize(("change", "status"), [("photo_removed", 404), ("session_revoked", 403)])
def test_a_change_committed_while_the_photo_read_waits_is_seen_by_its_retry(
    avatar_world, monkeypatch, change, status
):
    world = avatar_world
    native_avatar(world, bind=True)
    holder = hold_actor_row(world)

    def change_then_release(_seconds):
        if change == "photo_removed":
            holder.get(User, world.actor_id).avatar_file_id = None
        else:
            holder.get(IdentitySession, world.session_ids[0]).revoked_at = world.clock
        holder.commit()

    monkeypatch.setattr(avatar_delivery, "sleep", change_then_release, raising=False)
    try:
        refused = read(world)
    finally:
        holder.close()
    assert refused.status_code == status


def test_a_notifications_list_and_a_photo_read_in_parallel_both_succeed(
    avatar_world, monkeypatch
):
    world = avatar_world
    native_avatar(world, bind=True)
    listed, release = Event(), Event()
    real_query = notification_router.current_user_notification_query

    def held_query(*args, **kwargs):
        statement = real_query(*args, **kwargs)
        listed.set()  # The list now holds its lock on the reader's row.
        assert release.wait(10)
        return statement

    monkeypatch.setattr(notification_router, "current_user_notification_query", held_query)
    listing = []
    worker = Thread(target=lambda: listing.append(world.client.get(
        "/api/notifications", headers={**world.headers(), "X-Org": str(world.org_id)},
    ).status_code))
    try:
        worker.start()
        assert listed.wait(10)
        photo = read(world)
    finally:
        release.set()
        worker.join(15)
    assert not worker.is_alive()
    assert (photo.status_code, listing) == (200, [200])
