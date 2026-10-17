"""Account-owned avatars retain identity safeguards without organization admission."""

from datetime import timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization
from tests.files.user_avatar_support import avatar_world as avatar_world
from tests.files.user_avatar_support import (
    image,
    native_avatar,
    ready_avatar,
    stored_file,
)
from tests.files.user_avatar_support import policy_world as policy_world

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def restore_membership(avatar_world):
    world = avatar_world
    yield
    with Session(world.owner) as db:
        membership = db.scalar(select(Membership).where(
            Membership.org_id == world.org_id, Membership.user_id == world.actor_id,
        ))
        membership.is_deleted, membership.status, membership.expires_at = False, "active", None
        db.commit()


@pytest.mark.parametrize("state", ["no-default", "removed", "expired", "ip", "mfa"])
def test_account_only_avatar_round_trip_does_not_admit_organization_resources(avatar_world, state):
    world = avatar_world
    with Session(world.owner) as db:
        membership = db.scalar(select(Membership).where(Membership.user_id == world.actor_id))
        if state == "no-default":
            db.get(IdentitySession, world.session_ids[0]).active_org_id = None
        elif state == "removed":
            membership.is_deleted = True
        elif state == "expired":
            membership.expires_at = world.clock - timedelta(seconds=1)
        elif state == "ip":
            db.get(WorkspaceProfile, membership.org_id).ip_allow_list = ["192.0.2.0/24"]
        else:
            db.get(WorkspaceProfile, membership.org_id).mfa_require_admin = True
        db.commit()
    file_id, key = ready_avatar(world, bind=True)
    delivered = world.client.get(f"/api/users/{world.actor_id}/avatar", headers=world.headers())
    assert delivered.status_code == 200, delivered.text
    assert delivered.content == world.storage.objects[key]
    assert delivered.headers["x-content-type-options"] == "nosniff"
    assert delivered.headers["cache-control"] == "private, no-store"
    assert stored_file(world, file_id).org_id is None
    for path in ("/api/boards", f"/api/users/{world.target_id}/avatar"):
        refused = world.client.get(path, headers=world.headers())
        assert refused.status_code == 403, refused.text
    refused = world.client.post("/api/files", headers=world.headers(), json={
        "purpose": "workspace_logo", "filename": "logo.png", "expected_size": 10,
    })
    assert refused.status_code == 403, refused.text


def test_account_only_upload_cannot_take_another_accounts_avatar(avatar_world):
    world = avatar_world
    other, _ = native_avatar(world, owner_id=world.target_id)
    with Session(world.owner) as db:
        db.get(IdentitySession, world.session_ids[0]).active_org_id = None
        db.commit()
    refused = world.client.put(f"/api/files/{other}/content", headers={
        **world.headers(), "Content-Type": "application/octet-stream",
    }, content=image())
    assert refused.status_code == 404, refused.text
    assert world.storage.uploaded == []
    assert stored_file(world, other).state == "ready"


@pytest.fixture
def avatar_tabs(avatar_world):
    world = avatar_world
    with Session(world.owner) as db:
        second = create_organization(db, display_name="Avatar tab B")
        create_member(db, second, user=db.get(User, world.actor_id), role="admin")
        second_id = second.id
        db.get(IdentitySession, world.session_ids[0]).active_org_id = second_id
        db.commit()
    try:
        yield world, world.org_id, second_id
    finally:
        with Session(world.owner) as db:
            db.get(IdentitySession, world.session_ids[0]).active_org_id = world.org_id
            for row in db.scalars(select(Membership).where(Membership.org_id == second_id)):
                db.delete(row)
            db.flush()
            db.connection().execute(text("DELETE FROM audit_logs WHERE org_id = :org"),
                                    {"org": second_id})
            db.delete(db.get(WorkspaceProfile, second_id))
            db.commit()


def test_avatar_query_pins_tab_and_header_wins_without_changing_session_default(avatar_tabs):
    world, first, second = avatar_tabs
    _, key = native_avatar(world, owner_id=world.target_id, bind=True)
    path = f"/api/users/{world.target_id}/avatar"
    assert world.client.get(path, headers=world.headers()).status_code == 404
    selected = world.client.get(path, params={"org": str(first)}, headers=world.headers())
    assert selected.status_code == 200, selected.text
    assert selected.content == world.storage.objects[key]
    assert world.client.get(path, params={"org": str(first)}, headers={
        **world.headers(), "X-Org": str(second),
    }).status_code == 404
    assert world.client.get(path, params={"org": "not-a-uuid"}, headers={
        **world.headers(), "X-Org": str(first),
    }).status_code == 200
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_ids[0]).active_org_id == second


@pytest.mark.parametrize("org", ["not-a-uuid", ""])
def test_avatar_query_rejects_malformed_selector(avatar_world, org):
    world = avatar_world
    native_avatar(world, bind=True)
    refused = world.client.get(f"/api/users/{world.actor_id}/avatar",
                               params={"org": org}, headers=world.headers())
    assert refused.status_code == 422, refused.text
    assert refused.json()["detail"][0]["loc"] == ["query", "org"]


def test_other_avatar_rechecks_query_membership_after_storage_io(avatar_tabs):
    world, first, _ = avatar_tabs
    native_avatar(world, owner_id=world.target_id, bind=True)

    def remove_membership():
        with Session(world.owner) as db:
            membership = db.scalar(select(Membership).where(
                Membership.org_id == first, Membership.user_id == world.actor_id,
            ))
            membership.status = "disabled"
            db.commit()

    world.storage.read_effect = remove_membership
    refused = world.client.get(f"/api/users/{world.target_id}/avatar",
                               params={"org": str(first)}, headers=world.headers())
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == "organization_required"
