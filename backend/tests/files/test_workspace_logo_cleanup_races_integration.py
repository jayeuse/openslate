"""Independent committed locks, operation fencing and actual cleanup capacity."""

from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files import providers
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import FileCapacity, file_processing
from tests.auth.session_policy_support import policy_world as policy_world
from tests.workspace.test_workspace_logo_cleanup_integration import (
    current,
    patch,
    ready_logo,
    stored_file,
)
from tests.workspace.test_workspace_logo_cleanup_integration import (
    logo_world as logo_world,
)

pytestmark = pytest.mark.integration


def test_cleanup_provider_io_has_no_workspace_file_or_quota_transaction_locks(logo_world):
    from app.core.database.organization_scope import scope_session
    from app.systems.platform.files.quota import lock_quota

    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    new, _ = ready_logo(world)
    probed = []

    def independent_locks():
        with Session(world.owner) as db:
            # The logo is charged to its organization, so the lock is that organization's.
            scope_session(db, world.logo_org_id)
            lock_quota(db)
            db.scalar(select(WorkspaceProfile).where(
                WorkspaceProfile.id == world.logo_org_id
            ).with_for_update(nowait=True))
            db.scalar(select(File).where(File.id == old).with_for_update(nowait=True))
            probed.append(current(world)[0])

    world.storage.effect = independent_locks
    assert patch(world, logo_file_id=str(new)).status_code == 200
    assert probed == [new] and world.storage.deleted == [old_key]


def test_late_completion_preserves_a_second_committed_replacement(logo_world):
    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    first, first_key = ready_logo(world)
    second, second_key = ready_logo(world)
    entered, release = Event(), Event()
    results = []

    def hold_old():
        if world.storage.deleted[-1] == old_key:
            entered.set()
            assert release.wait(10), "Owned old-cleanup worker was not released"

    world.storage.effect = hold_old

    def replace_first():
        results.append(patch(world, logo_file_id=str(first)))

    worker = Thread(target=replace_first)
    worker.start()
    try:
        assert entered.wait(10), "Replacement never reached committed cleanup"
        assert current(world)[0] == first
        assert patch(world, logo_file_id=str(second)).status_code == 200
    finally:
        release.set()
        worker.join(10)
    assert not worker.is_alive() and results[0].status_code == 200
    assert current(world)[0] == second
    assert stored_file(world, old)["state"] == stored_file(world, first)["state"] == "purged"
    assert old_key not in world.storage.objects and first_key not in world.storage.objects
    assert second_key in world.storage.objects
    assert results[0].json()["logo_file_id"] == str(first)


def test_stale_token_never_finalizes_a_new_operation_or_restores_binding(logo_world):
    world = logo_world
    old, _ = ready_logo(world, bind=True)
    new, new_key = ready_logo(world)
    replacement_token = uuid4()

    def replace_claim():
        with Session(world.owner) as db:
            file = db.get(File, old)
            file.operation_id = replacement_token
            file.operation_expires_at = datetime.now(UTC) + timedelta(minutes=2)
            db.commit()

    world.storage.effect = replace_claim
    result = patch(world, logo_file_id=str(new))
    assert result.status_code == 503
    assert result.json()["detail"]["code"] == "workspace_logo_cleanup_partial"
    state = stored_file(world, old)
    assert state["operation_id"] == replacement_token and state["state"] == "deleting"
    assert state["deletion_origin"] == "logo_replacement"
    assert current(world)[0] == new and new_key in world.storage.objects


@pytest.mark.parametrize("locked", ["workspace", "file", "quota"])
def test_contended_admission_is_bounded_and_never_starts_storage_effect(logo_world, locked):
    from app.systems.platform.files.quota import lock_quota

    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    new, new_key = ready_logo(world)
    before = current(world)
    with Session(world.owner) as blocker:
        if locked == "workspace":
            blocker.scalar(select(WorkspaceProfile).where(
                WorkspaceProfile.id == world.logo_org_id
            ).with_for_update())
        elif locked == "file":
            blocker.scalar(select(File).where(File.id == old).with_for_update())
        else:
            lock_quota(blocker)
        result = patch(world, logo_file_id=str(new))
        assert result.status_code == 503
        assert current(world) == before and world.storage.deleted == []
        assert old_key in world.storage.objects and new_key in world.storage.objects


def test_active_replacement_claim_cannot_be_stolen_by_reconciliation(logo_world):
    world = logo_world
    old, _ = ready_logo(world, bind=True)
    new, _ = ready_logo(world)
    world.storage.fail = True
    assert patch(world, logo_file_id=str(new)).status_code == 503
    with Session(world.owner) as db:
        file = db.get(File, old)
        token = file.operation_id
        file.operation_expires_at = datetime.now(UTC) + timedelta(minutes=2)
        db.commit()
    before = list(world.storage.deleted)
    result = world.client.post(f"/api/files/{old}/reconcile", headers=world.headers())
    assert result.status_code == 409 and result.json()["detail"]["code"] == "file_operation_active"
    assert world.storage.deleted == before and stored_file(world, old)["operation_id"] == token


@pytest.fixture
def two_slots(monkeypatch):
    """Two processing slots, and a short wait so a refusal does not take the full bound."""
    monkeypatch.setattr(providers, "_pool", FileCapacity(256 * 1024 * 1024, 2))
    monkeypatch.setattr(providers, "PROCESSING_WAIT_SECONDS", 0.05)


def test_supplied_logo_obeys_capacity_while_text_only_settings_still_save(logo_world, two_slots):
    world = logo_world
    old, _ = ready_logo(world, bind=True)
    new, _ = ready_logo(world)
    before = current(world)
    with file_processing(wait_seconds=0), file_processing(wait_seconds=0):
        refused = patch(world, logo_file_id=str(new))
        assert refused.status_code == 503
        assert refused.json()["detail"]["code"] == "files_busy"
        assert current(world) == before and world.storage.deleted == []
        assert patch(world, display_name="Text can save").status_code == 200
    assert current(world)[0] == old


def test_two_stalled_cleanup_workers_hold_both_slots_until_actual_exit(logo_world, two_slots):
    world = logo_world
    old, old_key = ready_logo(world, bind=True)
    first, first_key = ready_logo(world)
    second, _ = ready_logo(world)
    third, _ = ready_logo(world)
    events = {old_key: Event(), first_key: Event()}
    release = {old_key: Event(), first_key: Event()}
    results = []

    def held():
        key = world.storage.deleted[-1]
        if key in events:
            events[key].set()
            assert release[key].wait(10), "Owned cleanup worker not released"

    world.storage.effect = held
    first_worker = Thread(target=lambda: results.append(patch(world, logo_file_id=str(first))))
    second_worker = Thread(target=lambda: results.append(patch(world, logo_file_id=str(second))))
    first_worker.start()
    try:
        assert events[old_key].wait(10)
        second_worker.start()
        assert events[first_key].wait(10)
        assert patch(world, logo_file_id=str(third)).status_code == 503
        assert patch(world, display_name="While cleanup runs").status_code == 200
        release[old_key].set()
        first_worker.join(10)
        assert not first_worker.is_alive()
        with file_processing(wait_seconds=0):
            with pytest.raises(HTTPException) as caught:
                with file_processing(wait_seconds=0):
                    pytest.fail("A live second cleanup lost its physical slot")
            assert caught.value.status_code == 503
    finally:
        for gate in release.values():
            gate.set()
        first_worker.join(10)
        if second_worker.ident is not None:
            second_worker.join(10)
    assert not first_worker.is_alive() and not second_worker.is_alive()
    assert len(results) == 2 and all(result.status_code == 200 for result in results)
    assert current(world)[0] == second
