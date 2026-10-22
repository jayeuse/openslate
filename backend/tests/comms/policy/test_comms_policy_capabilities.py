"""D27 current reads and pure admission, never grant writes/routes."""

import pytest
from fastapi import HTTPException

from app.systems.comms.capabilities import (
    capability_check,
    channel_creation_check,
    inspect_capabilities,
    scope_management_decision,
    validate_capability_configuration,
)
from tests.rbac.support import make_group_access

pytestmark = pytest.mark.integration

CONVERSATION_CAPABILITIES = (
    "react",
    "reply",
    "createThread",
    "attachFiles",
    "linkRecords",
    "mentionChannel",
    "pin",
    "manageThreads",
    "deleteOthersMessages",
    "moderate",
    "manageChannel",
)


@pytest.mark.parametrize("source", ["creator", "membership_manager", "department_manager"])
def test_manager_sources_are_distinct_and_immutable_without_org_promotion(policy_case, source):
    c, db = policy_case, policy_case.db
    channel = c.conversation(
        category=c.category, creator=c.actor if source == "creator" else None,
    )
    if source == "creator":
        c.member(channel, c.actor)
    if source == "membership_manager":
        c.member(channel, c.actor, role="manager")
    if source != "department_manager":
        # A manager row counts only for a current reader (spec deviation 7).
        make_group_access(db, [c.actor], c.department, level="read")
    if source == "department_manager":
        make_group_access(db, [c.actor], c.department, level="manage")
    for capability in ("react", "reply", "createThread", "attachFiles", "linkRecords"):
        c.grant({"kind": "workspace"}, capability, granted=False)
    for capability in CONVERSATION_CAPABILITIES:
        c.lock("capability", capability)
    check = capability_check(db, c.actor, channel.id)
    assert check["conversation_level"] == "manage"
    assert check["manager_source"] == source
    assert check["access_source"] == {"kind": "manager", "reason": source}
    for capability in CONVERSATION_CAPABILITIES:
        assert check["capabilities"][capability] == {
            "allowed": True,
            "source": {"kind": "manager", "reason": source},
        }
    assert check["capabilities"]["manageWorkspace"]["allowed"] is False
    creation = channel_creation_check(db, c.actor, {"kind": "category", "id": c.category.id})
    assert creation["decision"]["allowed"] is (source == "department_manager")
    workspace_creation = channel_creation_check(db, c.actor, {"kind": "workspace"})
    assert workspace_creation["decision"]["allowed"] is False


def test_guest_cap_and_admin_eligibility_precede_manager_and_grant_shortcuts(policy_case):
    c, db = policy_case, policy_case.db
    channel = c.conversation()
    guest = c.person("Guest manager", role="guest")
    c.member(channel, guest, role="manager")
    make_group_access(db, [guest], c.department, level="read")  # Still a current reader.
    group = c.group(guest)
    c.grant({"kind": "channel", "id": channel.id}, "manageChannel", group=group)
    check = capability_check(db, guest, channel.id)
    assert check["conversation_level"] == "read"
    assert check["manager_source"] is None
    assert set(check["capabilities"]) == {
        *CONVERSATION_CAPABILITIES,
        "createChannel",
        "manageWorkspace",
    }
    assert all(
        decision == {"allowed": False, "source": {"kind": "guest_cap"}}
        for decision in check["capabilities"].values()
    )
    admin = inspect_capabilities(db, c.admin, channel.id)
    assert all(
        decision == {"allowed": True, "source": {"kind": "admin"}}
        for decision in admin["capabilities"].values()
    )
    c.admin.status = "disabled"
    db.flush()
    with pytest.raises(HTTPException) as refused:
        inspect_capabilities(db, c.admin, channel.id)
    assert refused.value.status_code == 404


def test_everyone_switches_grants_and_person_specific_locks(policy_case):
    c, db = policy_case, policy_case.db
    channel = c.conversation(scope="organization", category=c.category)
    workspace = {"kind": "workspace"}
    category = {"kind": "category", "id": c.category.id}
    local = {"kind": "channel", "id": channel.id}
    actor_group = c.group(c.actor, name="Actor grants")
    peer_group = c.group(c.peer, name="Peer grants")
    switches = {}
    for capability in ("react", "reply", "createThread", "attachFiles", "linkRecords"):
        switches[capability] = c.grant(category, capability, granted=False)
    check = capability_check(db, c.actor, channel.id)
    assert {key: check["capabilities"][key]["allowed"] for key in switches} == {
        "react": False,
        "reply": False,
        "createThread": False,
        "attachFiles": False,
        "linkRecords": False,
    }
    assert check["capabilities"]["react"]["source"] == {
        "kind": "everyone",
        "scope": category,
        "enabled": False,
    }
    local_react = c.grant(local, "react", granted=True)
    c.grant(workspace, "reply", group=actor_group)
    c.grant(workspace, "pin", group=actor_group)
    c.grant(category, "moderate", group=actor_group)
    local_thread = c.grant(local, "manageThreads", group=actor_group)
    local_channel = c.grant(local, "manageChannel", group=actor_group)
    check = capability_check(db, c.actor, channel.id)
    assert check["capabilities"]["react"]["allowed"] is True
    assert check["capabilities"]["reply"] == {
        "allowed": True,
        "source": {
            "kind": "group_grant",
            "scope": workspace,
            "group_id": actor_group.id,
            "group_name": actor_group.name,
        },
    }
    assert check["capabilities"]["manageChannel"]["allowed"] is True
    assert check["manager_source"] is None
    assert check["capabilities"]["deleteOthersMessages"]["allowed"] is False
    assert check["capabilities"]["createChannel"]["allowed"] is False
    assert check["capabilities"]["manageWorkspace"]["allowed"] is False
    # Represent a later command's local-row replacement, not an S16 mutation API.
    empty = {"scope": local, "group_grants": [], "everyone": {}}
    assert validate_capability_configuration(db, local, empty) == empty
    for row in (local_thread, local_channel, local_react):
        row.is_deleted = True
    db.flush()
    check = capability_check(db, c.actor, channel.id)
    assert check["capabilities"]["manageThreads"]["allowed"] is False
    assert check["capabilities"]["manageChannel"]["allowed"] is False
    assert check["capabilities"]["pin"]["allowed"] is True
    assert check["capabilities"]["moderate"]["source"]["scope"] == category
    c.grant(category, "pin", group=peer_group)
    c.lock("capability", "pin")
    assert capability_check(db, c.actor, channel.id)["capabilities"]["pin"] == {
        "allowed": True,
        "source": {"kind": "workspace_lock", "enabled": True},
    }
    assert capability_check(db, c.peer, channel.id)["capabilities"]["pin"] == {
        "allowed": False,
        "source": {"kind": "workspace_lock", "enabled": False},
    }
    # A lock freezes the person's workspace result, not the category false or a global bool.
    c.lock("capability", "react")
    assert capability_check(db, c.peer, channel.id)["capabilities"]["react"] == {
        "allowed": True,
        "source": {"kind": "workspace_lock", "enabled": True},
    }


def test_reader_grants_never_supply_missing_read_or_parent_authority(policy_case):
    c, db = policy_case, policy_case.db
    channel = c.conversation(category=c.category)
    hidden = c.conversation(category=c.category, department=c.other_department())
    group = c.group(c.actor)
    make_group_access(db, [], c.department, level="read", group=group)
    c.settings({"kind": "channel", "id": channel.id}, {"mode": "announcements"})
    category = {"kind": "category", "id": c.category.id}
    c.grant(category, "reply", group=group)
    c.grant({"kind": "channel", "id": channel.id}, "manageChannel", group=group)
    check = inspect_capabilities(db, c.actor, channel.id)
    assert check["conversation_level"] == "read"
    assert check["access_source"] == {"kind": "department", "department_id": c.department.id}
    assert check["capabilities"]["reply"]["allowed"] is True
    assert check["capabilities"]["attachFiles"]["allowed"] is False
    assert scope_management_decision(db, c.actor, category)["allowed"] is False
    assert scope_management_decision(db, c.actor, {"kind": "workspace"})["allowed"] is False
    c.grant(category, "createChannel", group=group)
    assert channel_creation_check(db, c.actor, category)["decision"]["allowed"] is True
    workspace_creation = channel_creation_check(db, c.actor, {"kind": "workspace"})
    assert workspace_creation["decision"]["allowed"] is False
    c.grant({"kind": "workspace"}, "createChannel", group=group)
    # Owner decision 2026-10-22: a grant never creates an organization channel; the
    # workspace grant reaches the department where the actor holds a role.
    workspace = {"kind": "workspace"}
    assert channel_creation_check(db, c.actor, workspace)["decision"]["allowed"] is False
    in_department = channel_creation_check(db, c.actor, workspace, c.department.id)
    assert in_department["decision"]["allowed"] is True
    with pytest.raises(HTTPException) as refused:
        inspect_capabilities(db, c.actor, hidden.id)
    assert refused.value.status_code == 404
    # Inspectors may explain a known eligible nonreader, but cannot discover foreign people.
    no_access = inspect_capabilities(db, c.admin, hidden.id, user_id=c.actor.id)
    assert no_access["conversation_level"] == "none"
    assert no_access["capabilities"]["reply"]["allowed"] is False
    with pytest.raises(HTTPException) as refused:
        inspect_capabilities(db, c.admin, hidden.id, user_id=c.world.second.peer)
    assert refused.value.status_code == 404
    with pytest.raises(HTTPException) as refused:
        inspect_capabilities(db, c.peer, channel.id, user_id=c.actor.id)
    assert refused.value.status_code == 404  # Inspector itself cannot read.
    make_group_access(db, [c.peer], c.department, level="read")
    with pytest.raises(HTTPException) as refused:
        inspect_capabilities(db, c.peer, channel.id, user_id=c.actor.id)
    assert refused.value.status_code == 403


def test_configuration_admission_rejects_illegal_subjects_scopes_and_lock_changes(policy_case):
    c, db = policy_case, policy_case.db
    channel = c.conversation()
    group = c.group(c.actor)
    scope = {"kind": "channel", "id": channel.id}
    valid = {
        "scope": scope,
        "everyone": {"reply": False},
        "group_grants": [
            {"group_id": str(group.id), "capability": "reply"},
        ],
    }
    assert validate_capability_configuration(db, scope, valid)["everyone"] == {"reply": False}
    invalid = [
        {**valid, "group_grants": [{"group_id": str(group.id), "capability": "createChannel"}]},
        {**valid, "group_grants": [{"group_id": str(group.id), "capability": "manageWorkspace"}]},
        {**valid, "group_grants": [{"group_id": str(c.world.second.group), "capability": "reply"}]},
        {**valid, "group_grants": valid["group_grants"] * 2},
        {**valid, "everyone": {"pin": False}},
        {**valid, "person_grants": [{"user_id": str(c.actor.id), "capability": "pin"}]},
        {**valid, "group_grants": [{**valid["group_grants"][0], "deny": True}]},
        {**valid, "locks": ["reply"]},
        {**valid, "scope": {"kind": "workspace"}},
        {**valid, "scope": {"kind": ["channel"], "id": channel.id}},
    ]
    for payload in invalid:
        with pytest.raises(HTTPException) as refused:
            validate_capability_configuration(db, scope, payload)
        assert refused.value.status_code == 422
    c.lock("capability", "reply")
    with pytest.raises(HTTPException) as refused:
        validate_capability_configuration(db, scope, valid)
    assert refused.value.status_code == 403
    foreign = {"kind": "category", "id": c.world.second.category}
    with pytest.raises(HTTPException) as refused:
        channel_creation_check(db, c.admin, foreign)
    assert refused.value.status_code == 404
