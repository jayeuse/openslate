"""Person cards use existing module, Board, group and administrator visibility."""

from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.boards.models import Board, BoardGroup
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.manage.audit.context import set_audit_actor
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.files.user_avatar_support import (
    actor_role,
    native_avatar,
)
from tests.files.user_avatar_support import (
    avatar_world as avatar_world,
)
from tests.files.user_avatar_support import (
    policy_world as policy_world,
)

pytestmark = pytest.mark.integration


def card(world):
    return world.client.get(f"/api/users/{world.target_id}/card", headers=world.headers())


@pytest.fixture
def person_world(avatar_world):
    """Create owned company sharing, initially hidden, in the explicit actor organization."""
    world = avatar_world
    owned = []
    with Session(world.owner) as db:
        world.person_org_id = db.scalars(
            select(Membership.org_id).where(Membership.user_id == world.actor_id)
        ).one()
        company = Board(org_id=world.person_org_id, scope="company", name="Owned company")
        db.add(company)
        db.flush()
        owned.append((Board, company.id))
        saved = company.is_deleted, company.deleted_at
        company.is_deleted = True
        target = db.get(User, world.target_id)
        target.display_name, target.job_title = "Visible person", "Editor"
        target.phone, target.bio = "Private phone", "Private bio"
        db.commit()
        company_id = company.id
    actor_role(world, "member")
    world.person_owned = owned
    try:
        yield world
    finally:
        with Session(world.owner) as db:
            company = db.get(Board, company_id)
            company.is_deleted, company.deleted_at = saved
            for model, identity in reversed(owned):
                row = db.get(model, identity)
                if row is not None:
                    db.delete(row)
                    db.flush()
            db.commit()


def shared(world, mode):
    with Session(world.owner) as db:

        def add(row):
            db.add(row)
            db.flush()
            world.person_owned.append((type(row), row.id))
            return row

        if mode == "admin":
            membership = db.scalars(
                select(Membership).where(Membership.user_id == world.actor_id)
            ).one()
            membership.role = "admin"
        elif mode == "company":
            db.scalar(select(Board).where(
                Board.org_id == world.person_org_id, Board.scope == "company"
            )).is_deleted = False
        else:
            left = add(Group(org_id=world.person_org_id, name=f"card-left-{uuid4()}"))
            right = left if mode == "group" else add(
                Group(org_id=world.person_org_id, name=f"card-right-{uuid4()}")
            )
            add(GroupMember(org_id=left.org_id, group_id=left.id, user_id=world.actor_id))
            add(GroupMember(org_id=right.org_id, group_id=right.id, user_id=world.target_id))
            if mode == "module":
                department = add(Department(
                    org_id=left.org_id, department_name=f"card-{uuid4()}"
                ))
                module = add(Module(org_id=department.org_id, department_id=department.id,
                                    module_name="Shared module"))
                for group in (left, right):
                    add(
                        GroupAccess(
                            org_id=group.org_id,
                            group_id=group.id,
                            department_id=department.id,
                            module_id=module.id,
                            level="read",
                        )
                    )
            elif mode in ("project_board", "department_board"):
                if mode == "project_board":
                    board = add(Board(org_id=left.org_id, scope="project", name=f"card-{uuid4()}"))
                    for group in (left, right):
                        add(BoardGroup(org_id=board.org_id, board_id=board.id,
                                       group_id=group.id, level="read"))
                else:
                    department = add(Department(org_id=left.org_id,
                                                department_name=f"card-{uuid4()}"))
                    add(Board(org_id=department.org_id, scope="department",
                              department_id=department.id, name="Department"))
                    for group in (left, right):
                        add(
                            GroupAccess(
                                org_id=group.org_id,
                                group_id=group.id, department_id=department.id, level="read"
                            )
                        )
        db.commit()


@pytest.mark.parametrize(
    "scope", ["module", "group", "project_board", "department_board", "company", "admin"]
)
def test_member_card_and_avatar_follow_each_existing_visibility_path(person_world, scope):
    world = person_world
    _, key = native_avatar(world, owner_id=world.target_id, bind=True)
    shared(world, scope)
    response = card(world)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "display_name": "Visible person",
        "job_title": "Editor",
        "avatar_url": f"/api/users/{world.target_id}/avatar",
        "email": f"target-{world.target_id}@example.test",
        "phone": "Private phone",
        "bio": "Private bio",
    }
    assert "no-store" in response.headers["cache-control"]
    avatar = world.client.get(response.json()["avatar_url"], headers=world.headers())
    assert avatar.status_code == 200 and avatar.content == world.storage.objects[key]


def test_guest_card_omits_private_keys_including_own_card_but_self_read_stays_private(person_world):
    world = person_world
    shared(world, "company")
    actor_role(world, "guest")
    response = card(world)
    assert response.status_code == 200
    assert response.json() == {
        "display_name": "Visible person",
        "job_title": "Editor",
        "avatar_url": None,
    }
    own = world.client.get(f"/api/users/{world.actor_id}/card", headers=world.headers())
    assert own.status_code == 200 and {"email", "phone", "bio"}.isdisjoint(own.json())
    assert {"phone", "bio", "avatar_file_id"} <= world.client.get(
        "/api/auth/me", headers=world.headers()
    ).json().keys()


def test_comms_only_sharing_reveals_card_until_target_leaves(person_world):
    world = person_world
    # person_world hides its owned company Board; do not add any other sharing path.
    hidden = card(world)
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "person_not_found", "message": "Person not found"}}
    with AuditSession(world.owner) as db:
        scope_session(db, world.person_org_id)
        set_audit_actor(db, world.actor_id)
        conversation = CommsConversation(
            org_id=world.person_org_id, kind="channel", scope="members",
            name="Owned private card channel", created_by=world.actor_id,
        )
        db.add(conversation)
        db.flush()
        world.person_owned.append((CommsConversation, conversation.id))
        actor_member = CommsMember(
            org_id=world.person_org_id, conversation_id=conversation.id,
            user_id=world.actor_id, role="member", joined_at=world.clock,
        )
        target_member = CommsMember(
            org_id=world.person_org_id, conversation_id=conversation.id,
            user_id=world.target_id, role="member", joined_at=world.clock,
        )
        db.add_all([actor_member, target_member])
        db.flush()
        world.person_owned.extend([
            (CommsMember, actor_member.id), (CommsMember, target_member.id),
        ])
        target_member_id = target_member.id
        db.commit()
    visible = card(world)
    assert visible.status_code == 200, visible.text
    assert visible.json() == {
        "display_name": "Visible person",
        "job_title": "Editor",
        "avatar_url": None,
        "email": f"target-{world.target_id}@example.test",
        "phone": "Private phone",
        "bio": "Private bio",
    }
    assert visible.headers["cache-control"] == "private, no-store"
    with AuditSession(world.owner) as db:
        scope_session(db, world.person_org_id)
        set_audit_actor(db, world.target_id)
        target_member = db.get(CommsMember, target_member_id)
        assert target_member is not None
        target_member.is_deleted = True
        target_member.deleted_at = world.clock
        db.commit()
    hidden = card(world)
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "person_not_found", "message": "Person not found"}}


def test_removed_live_group_membership_hides_card_and_avatar_without_company_sharing(person_world):
    world = person_world
    shared(world, "group")
    native_avatar(world, owner_id=world.target_id, bind=True)
    assert card(world).status_code == 200
    with Session(world.owner) as db:
        db.scalar(
            select(GroupMember).where(GroupMember.user_id == world.actor_id)
        ).is_deleted = True
        db.commit()
    assert card(world).status_code == 404
    assert (
        world.client.get(
            f"/api/users/{world.target_id}/avatar", headers=world.headers()
        ).status_code
        == 404
    )


@pytest.mark.parametrize(
    "defect", ["separate_boards", "board_is_deleted", "board_deleted_at", "removed_board_grant"]
)
def test_board_visibility_requires_a_shared_live_board(person_world, defect):
    world = person_world
    shared(world, "project_board")
    native_avatar(world, owner_id=world.target_id, bind=True)
    assert card(world).status_code == 200
    with Session(world.owner) as db:
        grant = db.scalar(
            select(BoardGroup)
            .join(GroupMember, GroupMember.group_id == BoardGroup.group_id)
            .where(GroupMember.user_id == world.target_id)
        )
        board = db.get(Board, grant.board_id)
        if defect == "separate_boards":
            separate = Board(org_id=board.org_id, scope="project", name="Target's Board")
            db.add(separate)
            db.flush()
            world.person_owned.append((Board, separate.id))
            separate_grant = BoardGroup(
                org_id=board.org_id, board_id=separate.id, group_id=grant.group_id, level="read"
            )
            db.add(separate_grant)
            db.flush()
            world.person_owned.append((BoardGroup, separate_grant.id))
            grant.is_deleted = True
        elif defect == "board_is_deleted":
            board.is_deleted = True
        elif defect == "board_deleted_at":
            board.deleted_at = world.clock
        else:
            grant.is_deleted = True
        db.commit()
    hidden = card(world)
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "person_not_found", "message": "Person not found"}}
    assert world.client.get(
        f"/api/users/{world.target_id}/avatar", headers=world.headers()
    ).status_code == 404


@pytest.mark.parametrize("defect", ["disabled", "pending", "deleted", "unaccepted"])
def test_ineligible_target_is_hidden_even_to_admin(person_world, defect):
    world = person_world
    shared(world, "admin")
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        if defect in ("disabled", "pending"):
            target.status = defect
        elif defect == "deleted":
            target.is_deleted = True
        else:
            membership = db.scalars(
                select(Membership).where(Membership.user_id == target.id)
            ).one()
            membership.invitation_sent_at = world.clock
            membership.invitation_accepted_at = None
        db.commit()
    assert card(world).status_code == 404
    assert (
        world.client.get(
            f"/api/users/{world.target_id}/avatar", headers=world.headers()
        ).status_code
        == 404
    )


def test_absent_sharing_and_absent_identity_are_indistinguishable_and_username_fallback(
    person_world,
):
    world = person_world
    assert card(world).status_code == 404
    assert (
        world.client.get(f"/api/users/{uuid4()}/card", headers=world.headers()).status_code == 404
    )
    shared(world, "admin")
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        target.display_name = None
        expected = target.username
        db.commit()
    assert card(world).json()["display_name"] == expected
