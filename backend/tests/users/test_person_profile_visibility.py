"""Profiles: members see every active member of the bound organization (PD17)."""

from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization
from tests.files.user_avatar_support import actor_role, native_avatar
from tests.files.user_avatar_support import avatar_world as avatar_world
from tests.files.user_avatar_support import policy_world as policy_world
from tests.users.test_person_card_visibility import person_world as person_world
from tests.users.test_person_card_visibility import shared

pytestmark = pytest.mark.integration

NOT_FOUND = {"detail": {"code": "person_not_found", "message": "Person not found"}}


def profile(world, person_id=None, **headers):
    return world.client.get(
        f"/api/users/{person_id or world.target_id}/profile",
        headers={**world.headers(), **headers},
    )


def target_groups(world):
    """Two live groups of the target, added out of name order, a removed membership,
    and a live membership of a deleted group; only the two live groups show."""
    names = [f"Zeta-{uuid4()}", f"Alpha-{uuid4()}", f"Removed-{uuid4()}", f"Deleted-{uuid4()}"]
    with Session(world.owner) as db:
        groups = []
        for name in names:
            group = Group(org_id=world.person_org_id, name=name)
            db.add(group)
            db.flush()
            world.person_owned.append((Group, group.id))
            member = GroupMember(
                org_id=group.org_id, group_id=group.id, user_id=world.target_id
            )
            db.add(member)
            db.flush()
            world.person_owned.append((GroupMember, member.id))
            groups.append((group.id, name, member))
        groups[2][2].is_deleted = True
        db.get(Group, groups[3][0]).is_deleted = True
        db.commit()
    zeta, alpha = groups[0], groups[1]
    return [{"id": str(alpha[0]), "name": alpha[1]}, {"id": str(zeta[0]), "name": zeta[1]}]


def test_member_sees_full_profile_and_photo_of_a_member_without_shared_work(person_world):
    world = person_world
    _, key = native_avatar(world, owner_id=world.target_id, bind=True)
    groups = target_groups(world)
    # The person card keeps the shared-work rule (D36); the profile does not (PD17).
    assert world.client.get(
        f"/api/users/{world.target_id}/card", headers=world.headers()
    ).json() == NOT_FOUND
    response = profile(world)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "display_name": "Visible person",
        "job_title": "Editor",
        "phone": "Private phone",
        "bio": "Private bio",
        "avatar_url": f"/api/users/{world.target_id}/avatar",
        "role": "member",
        "groups": groups,
    }
    assert response.headers["cache-control"] == "private, no-store"
    avatar = world.client.get(response.json()["avatar_url"], headers=world.headers())
    assert avatar.status_code == 200, avatar.text
    assert avatar.content == world.storage.objects[key]


def test_administrator_sees_the_target_role_not_their_own(person_world):
    world = person_world
    shared(world, "admin")
    response = profile(world)
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "member"
    assert response.json()["groups"] == []


def test_guest_sees_only_name_title_and_photo_of_a_person_they_share_work_with(person_world):
    world = person_world
    native_avatar(world, owner_id=world.target_id, bind=True)
    target_groups(world)
    shared(world, "company")
    actor_role(world, "guest")
    response = profile(world)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "display_name": "Visible person",
        "job_title": "Editor",
        "avatar_url": f"/api/users/{world.target_id}/avatar",
    }
    assert response.headers["cache-control"] == "private, no-store"


def test_guest_without_shared_work_gets_the_same_answer_as_an_unknown_person(person_world):
    world = person_world
    actor_role(world, "guest")
    native_avatar(world, owner_id=world.target_id, bind=True)
    hidden = profile(world)
    assert hidden.status_code == 404
    assert hidden.json() == NOT_FOUND
    assert world.client.get(
        f"/api/users/{world.target_id}/avatar", headers=world.headers()
    ).status_code == 404
    unknown = profile(world, uuid4())
    assert unknown.status_code == 404
    assert unknown.json() == NOT_FOUND


@pytest.mark.parametrize(
    ("role", "expected_keys"),
    [
        ("member", {"display_name", "job_title", "phone", "bio", "avatar_url", "role", "groups"}),
        ("guest", {"display_name", "job_title", "avatar_url"}),
    ],
)
def test_a_viewer_always_reads_their_own_profile(person_world, role, expected_keys):
    world = person_world
    actor_role(world, role)
    response = profile(world, world.actor_id)
    assert response.status_code == 200, response.text
    assert set(response.json()) == expected_keys
    if role == "member":
        assert response.json()["role"] == "member"


@pytest.mark.parametrize("state", ["removed_membership", "disabled_account", "deleted_account"])
def test_a_removed_or_disabled_member_is_not_available_even_to_an_administrator(
    person_world, state
):
    world = person_world
    shared(world, "admin")
    native_avatar(world, owner_id=world.target_id, bind=True)
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        membership = db.scalars(
            select(Membership).where(Membership.user_id == world.target_id)
        ).one()
        saved = membership.is_deleted, target.status, target.is_deleted
        if state == "removed_membership":
            membership.is_deleted = True
        elif state == "disabled_account":
            target.status = "disabled"
        else:
            target.is_deleted = True
        db.commit()
    try:
        hidden = profile(world)
        assert hidden.status_code == 404
        assert hidden.json() == NOT_FOUND
        assert world.client.get(
            f"/api/users/{world.target_id}/avatar", headers=world.headers()
        ).status_code == 404
    finally:
        with Session(world.owner) as db:
            target = db.get(User, world.target_id)
            membership = db.scalars(
                select(Membership).where(Membership.user_id == world.target_id)
            ).one()
            membership.is_deleted, target.status, target.is_deleted = saved
            db.commit()


@pytest.fixture
def second_organization(person_world):
    """The actor administers a second organization; the target belongs only to the first."""
    world = person_world
    with Session(world.owner) as db:
        second = create_organization(db, display_name="Profile organization B")
        create_member(db, second, user=db.get(User, world.actor_id), role="admin")
        second_id = second.id
        db.get(IdentitySession, world.session_ids[0]).active_org_id = second_id
        db.commit()
    try:
        yield second_id
    finally:
        with Session(world.owner) as db:
            db.get(IdentitySession, world.session_ids[0]).active_org_id = world.org_id
            for row in db.scalars(select(Membership).where(Membership.org_id == second_id)):
                db.delete(row)
            db.flush()
            db.connection().execute(
                text("DELETE FROM audit_logs WHERE org_id = :org"), {"org": second_id}
            )
            db.delete(db.get(WorkspaceProfile, second_id))
            db.commit()


def test_a_person_of_another_organization_is_not_available(person_world, second_organization):
    world = person_world
    native_avatar(world, owner_id=world.target_id, bind=True)
    foreign = profile(world)
    assert foreign.status_code == 404
    assert foreign.json() == NOT_FOUND
    assert world.client.get(
        f"/api/users/{world.target_id}/avatar", headers=world.headers()
    ).status_code == 404
    # The same person is available in the organization they belong to.
    home = profile(world, **{"X-Org": str(world.person_org_id)})
    assert home.status_code == 200, home.text
