"""D45 access grants in the one Comms access relation: add read or post, never manage."""

import pytest
from fastapi import HTTPException
from uuid6 import uuid7

from app.systems.access.policy.models import GroupMember
from app.systems.access.users.person_visibility import visible_person_ids
from app.systems.comms.access import explain_conversation_access, require_conversation_access
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations.models import CommsCategory, CommsChannelAccess
from app.systems.platform.events.models import event_for_entity
from tests.comms.policy.test_comms_policy_access import assert_views
from tests.rbac.support import make_group_access

pytestmark = pytest.mark.integration


def grant(case, target, level, *, person=None, group=None):
    """Fixture storage only: one grant row on a channel or a category."""
    row = CommsChannelAccess(
        org_id=case.org.id,
        conversation_id=None if isinstance(target, CommsCategory) else target.id,
        category_id=target.id if isinstance(target, CommsCategory) else None,
        subject="user" if person else "group",
        user_id=person.id if person else None,
        group_id=group.id if group else None,
        level=level,
        created_by=case.admin.id,
    )
    case.db.add(row)
    case.db.flush()
    return row


def test_person_and_group_grants_add_read_or_post_and_revocation_is_immediate(policy_case):
    c, db = policy_case, policy_case.db
    finance = c.conversation(scope="department", department=c.department, creator=c.peer)
    other = c.conversation(scope="department", department=c.department, creator=c.peer)
    inventory = c.person("Inventory member")
    later = c.person("Later group member")
    assert_views(db, inventory, [finance], {finance.id: "none"})
    # G1: a person grant of post reads and posts this channel only.
    person = grant(c, finance, "post", person=inventory)
    assert_views(db, inventory, [finance, other], {finance.id: "post", other.id: "none"})
    assert require_conversation_access(db, inventory, finance.id, "post").id == finance.id
    assert explain_conversation_access(db, inventory, finance.id).source == {"kind": "grant"}
    rights = capability_check(db, inventory, finance.id)
    assert rights["manager_source"] is None
    assert rights["capabilities"]["manageChannel"]["allowed"] is False
    assert rights["capabilities"]["reply"]["allowed"] is True
    # D36 follows the relation: two grant readers of one channel see each other.
    colleague = c.person("Granted colleague")
    assert visible_person_ids(db, inventory, [colleague.id]) == set()
    colleague_grant = grant(c, finance, "read", person=colleague)
    assert visible_person_ids(db, inventory, [colleague.id]) == {colleague.id}
    db.delete(colleague_grant)
    db.flush()
    # G2: a group grant of read reaches every live member, including a later one.
    staff = c.group(c.actor, name="Inventory staff")
    grant(c, finance, "read", group=staff)
    assert_views(db, c.actor, [finance], {finance.id: "read"})
    with pytest.raises(HTTPException) as refused:
        require_conversation_access(db, c.actor, finance.id, "post")
    assert (refused.value.status_code, refused.value.detail["code"]) == (403, "comms_post_denied")
    assert_views(db, later, [finance], {finance.id: "none"})
    joined = GroupMember(org_id=c.org.id, group_id=staff.id, user_id=later.id)
    db.add(joined)
    db.flush()
    assert_views(db, later, [finance], {finance.id: "read"})
    joined.is_deleted = True
    db.flush()
    assert_views(db, later, [finance], {finance.id: "none"})
    staff.is_deleted = True
    db.flush()
    assert_views(db, c.actor, [finance], {finance.id: "none"})
    # G4: removing the grant row refuses the channel at once.
    db.delete(person)
    db.flush()
    assert_views(db, inventory, [finance], {finance.id: "none"})
    with pytest.raises(HTTPException) as refused:
        require_conversation_access(db, inventory, finance.id, "read")
    assert (refused.value.status_code, refused.value.detail["code"]) == (404, "comms_not_found")


@pytest.mark.parametrize(
    ("department_level", "grant_level", "expected", "guest_expected"),
    [
        (None, "read", "read", "read"),
        (None, "post", "post", "read"),
        ("read", "post", "post", "read"),
        ("write", "read", "post", "read"),
        ("manage", "read", "manage", "read"),
    ],
)
def test_grant_and_department_role_take_the_higher_level_never_manage_and_guest_capped(
    policy_case,
    department_level,
    grant_level,
    expected,
    guest_expected,
):
    # G3 and the SEC-R6 matrix: max(department role, grant), grants stop at post.
    c, db = policy_case, policy_case.db
    channel = c.conversation(scope="department", department=c.department, creator=c.peer)
    guest = c.person("Granted guest", role="guest")
    if department_level is not None:
        make_group_access(db, [c.actor, guest], c.department, level=department_level)
    grant(c, channel, grant_level, person=c.actor)
    grant(c, channel, grant_level, person=guest)
    assert_views(db, c.actor, [channel], {channel.id: expected})
    assert_views(db, guest, [channel], {channel.id: guest_expected})
    assert_views(db, c.admin, [channel], {channel.id: "manage"})
    rights = capability_check(db, c.actor, channel.id)
    assert rights["capabilities"]["manageChannel"]["allowed"] is (expected == "manage")


def test_grant_rows_on_direct_and_group_messages_give_nothing(policy_case):
    # D43: membership alone decides private conversations, even with a stray stored row.
    c, db = policy_case, policy_case.db
    direct, group_chat = c.conversation(kind="direct"), c.conversation(kind="group")
    for row in (direct, group_chat):
        c.member(row, c.peer)
        grant(c, row, "post", person=c.actor)
    staff = c.group(c.actor)
    grant(c, group_chat, "read", group=staff)
    assert_views(db, c.actor, [direct, group_chat], {direct.id: "none", group_chat.id: "none"})
    assert_views(db, c.admin, [direct, group_chat], {direct.id: "none", group_chat.id: "none"})


def test_category_grants_follow_the_channels_current_category(policy_case):
    # G8: a category grant reaches the channels in it, adds to channel grants, and stops
    # when a channel moves out; the category may belong to another department.
    c, db = policy_case, policy_case.db
    assert c.category.department_id == c.department.id
    inside = c.conversation(scope="department", department=c.department, category=c.category)
    sibling = c.conversation(scope="department", department=c.department, category=c.category)
    outside = c.conversation(scope="department", department=c.department)
    staff = c.group(c.actor, name="Category readers")
    grant(c, c.category, "read", group=staff)
    expected = {inside.id: "read", sibling.id: "read", outside.id: "none"}
    assert_views(db, c.actor, [inside, sibling, outside], expected)
    grant(c, inside, "post", person=c.actor)
    expected = {inside.id: "post", sibling.id: "read", outside.id: "none"}
    assert_views(db, c.actor, [inside, sibling, outside], expected)
    sibling.category_id = None
    other = CommsCategory(org_id=c.org.id, name="Elsewhere", department_id=c.department.id)
    db.add(other)
    db.flush()
    outside.category_id = other.id
    db.flush()
    expected = {inside.id: "post", sibling.id: "none", outside.id: "none"}
    assert_views(db, c.actor, [inside, sibling, outside], expected)
    outside.category_id = c.category.id
    db.flush()
    assert_views(db, c.actor, [outside], {outside.id: "read"})


def test_grant_rows_never_emit_a_generic_invalidation():
    # A generic event would announce grant changes to every signed-in person.
    assert event_for_entity("comms_channel_access", uuid7()) is None
