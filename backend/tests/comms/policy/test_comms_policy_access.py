"""Current policy decisions, not future HTTP/send implementation."""

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.systems.access.policy.models import Group
from app.systems.access.users.membership import organization_membership, remember_membership
from app.systems.access.users.models import User
from app.systems.access.users.person_visibility import visible_person_ids
from app.systems.comms.access import (
    can_start_direct,
    conversation_level,
    conversation_reader_ids,
    readable_conversation_ids,
    require_conversation_access,
    visible_conversation_clause,
)
from app.systems.comms.capabilities import capability_check, inspect_capabilities
from app.systems.comms.conversations.models import (
    CommsConversation,
    CommsConversationGroup,
    CommsDirectBlock,
)
from tests.conftest import membership_of
from tests.rbac.support import add_module, make_group_access

pytestmark = pytest.mark.integration


def assert_views(db, actor, conversations, expected):
    """Independent literal levels supplied by each scenario, not by another resolver."""
    actual = {row.id: conversation_level(db, actor, row) for row in conversations}
    assert actual == expected
    readable = {identity for identity, level in expected.items() if level != "none"}
    sql_ids = set(
        db.scalars(
            select(CommsConversation.id).where(
                CommsConversation.id.in_(expected),
                visible_conversation_clause(db, actor),
            )
        )
    )
    assert sql_ids == readable
    assert readable_conversation_ids(db, actor) & expected.keys() == readable
    for row in conversations:
        assert (actor.id in conversation_reader_ids(db, row)) == (row.id in readable)


def test_scope_forms_agree_without_board_fallback_or_category_default_leak(policy_case):
    c, db = policy_case, policy_case.db
    organization = c.conversation(scope="organization")
    department = c.conversation(scope="department", department=c.department)
    grouped = c.conversation(scope="groups", category=c.category)
    private = c.conversation(category=c.category)
    direct = c.conversation(kind="direct")
    group_chat = c.conversation(kind="group")
    everyone = c.conversation(scope="groups")
    ungranted_private = c.conversation(category=c.category)
    ungranted_groups = c.conversation(scope="groups", category=c.category)
    c.access(everyone, level="read")
    rows = [
        organization,
        department,
        grouped,
        private,
        direct,
        group_chat,
        everyone,
        ungranted_private,
        ungranted_groups,
    ]
    c.member(private, c.actor)
    c.member(direct, c.actor)
    c.member(group_chat, c.peer)
    low = c.group(c.actor, name="Read")
    high = c.group(c.actor, name="Post")
    c.access(grouped, group=low, level="read")
    high_grant = c.access(grouped, group=high, level="post")
    # Category access rows are creation defaults, not another live inheritance source.
    db.add(
        CommsConversationGroup(
            org_id=c.org.id,
            category_id=c.category.id,
            subject="everyone",
            level="post",
        )
    )
    module = add_module(db, c.department)
    module_grant = make_group_access(db, [c.actor], c.department, module, level="manage")
    db.flush()
    expected = {
        organization.id: "post",
        department.id: "none",
        grouped.id: "post",
        private.id: "post",
        direct.id: "post",
        group_chat.id: "none",
        everyone.id: "read",
        ungranted_private.id: "none",
        ungranted_groups.id: "none",
    }
    assert_views(db, c.actor, rows, expected)
    all_visible = {organization.id, grouped.id, private.id, direct.id, everyone.id}
    assert readable_conversation_ids(db, c.actor) == all_visible
    assert (
        set(
            db.scalars(
                select(CommsConversation.id).where(
                    visible_conversation_clause(db, c.actor),
                )
            )
        )
        == all_visible
    )
    assert conversation_reader_ids(db, group_chat) == {c.peer.id}
    # The Comms delta is write->post; canonical per-group specificity remains existing coverage.
    department_group = db.get(Group, module_grant.group_id)
    assert department_group is not None
    department_grant = make_group_access(
        db,
        [],
        c.department,
        level="write",
        group=department_group,
    )
    expected[department.id] = "post"
    assert_views(db, c.actor, rows, expected)
    high_grant.is_deleted = True
    department_grant.level = "read"
    db.flush()
    expected.update({grouped.id: "read", department.id: "read"})
    assert_views(db, c.actor, rows, expected)
    # The literal none entries also protect private/group-granted siblings at every stage.


def test_guest_and_ineligible_admin_caps_agree_in_all_access_forms(policy_case):
    c, db = policy_case, policy_case.db
    organization = c.conversation(scope="organization")
    private = c.conversation()
    c.member(private, c.admin)
    guest = c.person("Guest manager", role="guest")
    c.member(private, guest, role="manager")
    assert_views(db, guest, [organization, private], {organization.id: "read", private.id: "read"})
    membership_of(db, guest.id).expires_at = datetime(2000, 1, 1, tzinfo=UTC)
    db.flush()
    assert_views(db, guest, [organization, private], {organization.id: "none", private.id: "none"})
    assert_views(
        db,
        c.admin,
        [organization, private],
        {organization.id: "manage", private.id: "manage"},
    )
    c.admin.status = "disabled"
    db.flush()
    assert_views(
        db,
        c.admin,
        [organization, private],
        {organization.id: "none", private.id: "none"},
    )


def test_admin_private_access_tracks_membership_in_every_projection(policy_case):
    c, db = policy_case, policy_case.db
    public = [
        c.conversation(scope="organization", creator=c.peer),
        c.conversation(scope="department", department=c.department, creator=c.peer),
        c.conversation(scope="groups", creator=c.peer),
    ]
    private = [
        c.conversation(category=c.category, creator=c.peer),
        c.conversation(kind="direct", creator=c.peer),
        c.conversation(kind="group", creator=c.peer),
    ]
    expected = {row.id: "manage" for row in public} | {row.id: "none" for row in private}
    assert_views(db, c.admin, public + private, expected)
    for row in private:
        with pytest.raises(HTTPException) as refused:
            require_conversation_access(db, c.admin, row.id, "read")
        assert refused.value.status_code == 404
        assert refused.value.detail["code"] == "comms_not_found"
        with pytest.raises(HTTPException) as refused:
            inspect_capabilities(db, c.admin, row.id)
        assert refused.value.status_code == 404
    members = [c.member(row, c.admin) for row in private]
    assert_views(db, c.admin, public + private, {row.id: "manage" for row in public + private})
    for row in private:
        assert require_conversation_access(db, c.admin, row.id, "read").id == row.id
    for member in members:
        member.is_deleted = True
        member.deleted_at = datetime(2000, 1, 1, tzinfo=UTC)
    db.flush()
    assert_views(db, c.admin, public + private, expected)


@pytest.mark.parametrize("scope", ["members", "organization"])
def test_creator_management_ends_with_membership_without_erasing_other_access(policy_case, scope):
    c, db = policy_case, policy_case.db
    channel = c.conversation(scope=scope, creator=c.actor)
    member = c.member(channel, c.actor)
    assert_views(db, c.actor, [channel], {channel.id: "manage"})
    assert capability_check(db, c.actor, channel.id)["manager_source"] == "creator"
    member.is_deleted = True
    member.deleted_at = datetime(2000, 1, 1, tzinfo=UTC)
    db.flush()
    expected = "post" if scope == "organization" else "none"
    assert_views(db, c.actor, [channel], {channel.id: expected})
    check = capability_check(db, c.actor, channel.id)
    assert check["manager_source"] is None
    assert check["capabilities"]["manageChannel"]["allowed"] is False


@pytest.mark.parametrize(
    ("department_level", "expected", "guest_expected"),
    [
        (None, "none", "none"),
        ("read", "read", "read"),
        ("write", "post", "read"),
        ("manage", "manage", "read"),
    ],
)
def test_department_roles_alone_decide_department_channels_and_revocation_is_immediate(
    policy_case, department_level, expected, guest_expected,
):
    # SEC-R6 matrix for D44: department level -> channel level; organization channels post/read.
    c, db = policy_case, policy_case.db
    department = c.conversation(scope="department", department=c.department, creator=c.peer)
    organization = c.conversation(scope="organization", creator=c.peer)
    guest = c.person("Guest reader", role="guest")
    grant = None
    if department_level is not None:
        grant = make_group_access(db, [c.actor, guest], c.department, level=department_level)
    assert_views(
        db, c.actor, [department, organization],
        {department.id: expected, organization.id: "post"},
    )
    assert_views(
        db, guest, [department, organization],
        {department.id: guest_expected, organization.id: "read"},
    )
    assert_views(
        db, c.admin, [department, organization],
        {department.id: "manage", organization.id: "manage"},
    )
    outcomes = {
        "none": {"read": 404, "post": 404, "manage": 404},
        "read": {"read": 200, "post": 403, "manage": 403},
        "post": {"read": 200, "post": 200, "manage": 403},
        "manage": {"read": 200, "post": 200, "manage": 200},
    }[expected]
    for requested, status in outcomes.items():
        if status == 200:
            assert require_conversation_access(db, c.actor, department.id, requested).id == (
                department.id
            )
            continue
        with pytest.raises(HTTPException) as refused:
            require_conversation_access(db, c.actor, department.id, requested)
        assert refused.value.status_code == status
        assert refused.value.detail["code"] == (
            "comms_not_found" if status == 404 else f"comms_{requested}_denied"
        )
    if grant is not None:
        grant.is_deleted = True
        db.flush()
        assert_views(db, c.actor, [department], {department.id: "none"})
        with pytest.raises(HTTPException) as refused:
            require_conversation_access(db, c.actor, department.id, "read")
        assert refused.value.status_code == 404


def test_department_manager_cannot_manage_private_category_sibling(policy_case):
    c, db = policy_case, policy_case.db
    own_department = c.conversation(
        scope="department",
        department=c.department,
        category=c.category,
    )
    private = c.conversation(category=c.category)
    make_group_access(db, [c.actor], c.department, level="manage")
    assert_views(
        db,
        c.actor,
        [own_department, private],
        {own_department.id: "manage", private.id: "none"},
    )
    with pytest.raises(HTTPException) as refused:
        require_conversation_access(db, c.actor, private.id, "read")
    assert refused.value.status_code == 404
    c.member(private, c.actor)
    assert_views(
        db,
        c.actor,
        [own_department, private],
        {own_department.id: "manage", private.id: "post"},
    )
    check = capability_check(db, c.actor, private.id)
    assert check["manager_source"] is None
    assert check["capabilities"]["manageChannel"]["allowed"] is False


def test_hidden_and_foreign_objects_are_not_readable_even_to_local_admin(policy_case):
    c, db = policy_case, policy_case.db
    reader = c.conversation(scope="groups")
    c.access(reader, level="read")
    hidden = c.conversation()
    with c.world.session(c.world.second) as other:
        foreign = other.get(CommsConversation, c.world.second.conversation)
        assert foreign is not None
        other.expunge(foreign)
    assert_views(db, c.admin, [foreign], {foreign.id: "none"})
    assert conversation_reader_ids(db, foreign) == set()
    foreign_actor = db.get(User, c.world.second.author)
    assert foreign_actor is not None
    assert_views(db, foreign_actor, [reader, hidden], {reader.id: "none", hidden.id: "none"})
    for actor, identity, level, status, code in (
        (c.actor, hidden.id, "read", 404, "comms_not_found"),
        (c.admin, foreign.id, "read", 404, "comms_not_found"),
        (c.actor, reader.id, "post", 403, "comms_post_denied"),
    ):
        with pytest.raises(HTTPException) as refused:
            require_conversation_access(db, actor, identity, level)
        assert refused.value.status_code == status
        assert refused.value.detail["code"] == code
    assert require_conversation_access(db, c.actor, reader.id, "read").id == reader.id


def test_direct_start_policy_and_blocks_do_not_erase_existing_history(policy_case):
    c, db = policy_case, policy_case.db
    direct = c.conversation(kind="direct")
    c.member(direct, c.actor)
    c.member(direct, c.peer)
    policy = c.settings({"kind": "workspace"}, {"dm_rule": "everyone"})
    assert can_start_direct(db, c.actor, c.peer.id) is True
    policy.values = {"dm_rule": "shared-channel"}
    db.flush()
    assert can_start_direct(db, c.actor, c.peer.id) is False  # A direct is not a channel.
    shared = c.conversation()
    c.member(shared, c.actor)
    c.member(shared, c.peer)
    assert can_start_direct(db, c.actor, c.peer.id) is True
    policy.values = {"dm_rule": "none"}
    db.flush()
    assert can_start_direct(db, c.actor, c.peer.id) is False
    assert require_conversation_access(db, c.actor, direct.id, "read").id == direct.id
    policy.values = {"dm_rule": "everyone"}
    blocked = CommsDirectBlock(org_id=c.org.id, user_id=c.peer.id, blocked_user_id=c.actor.id)
    db.add(blocked)
    db.flush()
    assert can_start_direct(db, c.actor, c.peer.id) is False
    assert can_start_direct(db, c.peer, c.actor.id) is False
    with pytest.raises(HTTPException) as refused:
        require_conversation_access(db, c.actor, direct.id, "post")
    assert refused.value.status_code == 403
    assert refused.value.detail == {
        "code": "comms_post_denied",
        "message": "Conversation access denied",
    }
    assert require_conversation_access(db, c.actor, direct.id, "read").id == direct.id
    blocked.is_deleted = True
    db.flush()
    assert can_start_direct(db, c.actor, c.peer.id) is True
    guest = c.person("Guest", role="guest")
    assert can_start_direct(db, guest, c.peer.id) is False
    assert can_start_direct(db, c.actor, c.actor.id) is False
    assert can_start_direct(db, c.actor, c.world.second.peer) is False
    # D36 allows guest visibility; D3 separately forbids a guest joining a new direct.
    c.member(shared, guest)
    assert require_conversation_access(db, guest, shared.id, "read").id == shared.id
    assert visible_person_ids(db, c.actor, {guest.id}) == {guest.id}
    assert can_start_direct(db, c.actor, guest.id) is False


def test_committed_membership_changes_replace_cached_positive_decisions(comms_world):
    org = comms_world.first
    with comms_world.session(org, actor=org.peer) as reader:
        actor = reader.get(User, org.peer)
        conversation = reader.get(CommsConversation, org.conversation)
        assert actor is not None and conversation is not None
        membership = organization_membership(reader, actor.id)
        assert membership is not None
        remember_membership(reader, membership)
        assert_views(reader, actor, [conversation], {conversation.id: "post"})
        initial = inspect_capabilities(reader, actor, conversation.id)
        assert initial["capabilities"]["react"]["allowed"] is True
        # Sequential independent commits are deterministic: no timing, fake policy or sleep.
        for change, expected in (
            ("guest", "read"),
            ("expired", "none"),
            ("restored", "post"),
            ("removed", "none"),
        ):
            with comms_world.session(org) as writer:
                current = organization_membership(writer, org.peer, fresh=True)
                assert current is not None
                if change == "guest":
                    current.role = "guest"
                    current.sponsor_user_id = org.author
                    current.expires_at = datetime(2100, 1, 1, tzinfo=UTC)
                elif change == "expired":
                    current.expires_at = datetime(2000, 1, 1, tzinfo=UTC)
                else:
                    current.role, current.sponsor_user_id, current.expires_at = "member", None, None
                    current.is_deleted = change == "removed"
                writer.commit()
            # Do NOT clear caches, expire objects, or replace the actor/session in the test.
            assert_views(reader, actor, [conversation], {conversation.id: expected})
            if expected == "none":
                with pytest.raises(HTTPException) as refused:
                    inspect_capabilities(reader, actor, conversation.id)
                assert refused.value.status_code == 404
            else:
                check = inspect_capabilities(reader, actor, conversation.id)
                decision = check["capabilities"]["react"]
                assert decision["allowed"] is (expected == "post")
                if expected == "read":
                    assert decision["source"] == {"kind": "guest_cap"}
