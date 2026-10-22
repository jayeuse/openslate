"""Bounded D36 discovery and the same direct admission rules, through HTTP and PostgreSQL."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select
from uuid6 import uuid7

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation, CommsDirectBlock, CommsMember
from app.systems.comms.settings.models import CommsSettings
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.comms.routes.message_support import _ok
from tests.conftest import create_member

pytestmark = pytest.mark.integration
ROOT = "/api/comms/direct-candidates"


def person(case, name, *, shared=False, role="member", **values):
    org = case.world.first
    with case.world.session(org) as db:
        if role == "guest":
            values = {
                "sponsor_user_id": org.author,
                "expires_at": datetime.now(UTC) + timedelta(days=1),
                **values,
            }
        user, _ = create_member(
            db,
            db.get(WorkspaceProfile, org.id),
            role,
            display_name=name,
            supabase_user_id=uuid7(),
            **values,
        )
        identity = user.id
        if shared:
            # D44: sharing a department channel is a department role; a separate group keeps
            # the shared-group fallback out of the result.
            group = Group(org_id=org.id, name=f"Candidate share {identity}")
            db.add(group)
            db.flush()
            db.add(GroupMember(org_id=org.id, group_id=group.id, user_id=identity))
            db.add(GroupAccess(
                org_id=org.id, group_id=group.id, department_id=org.department, level="read",
            ))
        db.commit()
    case.world.additional_users.append(identity)
    return identity


def private_rooms(case):
    """Department channels that only the peer and shared people can read (D44)."""
    org = case.world.first
    with case.world.session(org) as db:
        for room in db.scalars(select(CommsConversation)):
            room.scope, room.department_id = "department", org.department
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(GroupAccess(
            org_id=org.id, group_id=org.group, department_id=org.department, level="read",
        ))
        db.commit()


def rule(case, value):
    with case.world.session(case.world.first) as db:
        row = db.scalar(select(CommsSettings).where(CommsSettings.scope == "workspace"))
        if row is None:
            db.add(
                CommsSettings(
                    org_id=case.world.first.id, scope="workspace", values={"dm_rule": value}
                )
            )
        else:
            row.values = {**row.values, "dm_rule": value}
        db.commit()


def test_names_are_bounded_private_and_case_insensitive(candidate_routes):
    case, org = candidate_routes, candidate_routes.world.first
    private_rooms(case)
    visible = person(case, "Candidate Needle", shared=True, email="email-only@example.test")
    hidden = person(case, "Candidate Hidden")
    api = case.client(org.peer, org.id)
    response = api.get(ROOT, params={"q": "  cANDidate  "})
    assert _ok(response) == {
        "items": [{"user_id": str(visible), "display_name": "Candidate Needle", "avatar_url": None}]
    }
    assert "no-store" in response.headers["cache-control"]
    assert _ok(api.get(ROOT, params={"q": "email-only"})) == {"items": []}
    admin = case.client(org.author, org.id)
    assert {row["user_id"] for row in _ok(admin.get(ROOT, params={"q": "Candidate"}))["items"]} == {
        str(visible),
        str(hidden),
    }
    assert _ok(
        case.client(case.world.second.author, case.world.second.id).get(
            ROOT,
            params={"q": "Candidate"},
        )
    ) == {"items": []}


@pytest.mark.parametrize("direction", ["outgoing", "incoming"])
def test_either_direct_block_direction_hides_the_person(candidate_routes, direction):
    case, org = candidate_routes, candidate_routes.world.first
    target = person(case, "Candidate Blocked")
    with case.world.session(org) as db:
        left, right = (org.peer, target) if direction == "outgoing" else (target, org.peer)
        db.add(CommsDirectBlock(org_id=org.id, user_id=left, blocked_user_id=right))
        db.commit()
    assert _ok(case.client(org.peer, org.id).get(ROOT, params={"q": "Candidate"})) == {"items": []}


@pytest.mark.parametrize("unavailable", ["account", "membership", "expired", "pending"])
def test_only_current_active_org_members_are_candidates(candidate_routes, unavailable):
    case, org = candidate_routes, candidate_routes.world.first
    target = person(case, "Candidate Unavailable")
    with case.world.session(org) as db:
        membership = db.scalars(select(Membership).where(Membership.user_id == target)).one()
        if unavailable == "account":
            db.get(User, target).status = "disabled"
        elif unavailable == "membership":
            membership.status = "disabled"
        elif unavailable == "expired":
            membership.expires_at = datetime.now(UTC) - timedelta(days=1)
        else:
            membership.status = "pending"
        db.commit()
    assert _ok(case.client(org.peer, org.id).get(ROOT, params={"q": "Candidate"})) == {"items": []}


@pytest.mark.parametrize("policy", ["everyone", "shared-channel", "none"])
def test_rule_uses_channel_sharing_not_merely_person_visibility(candidate_routes, policy):
    case, org = candidate_routes, candidate_routes.world.first
    private_rooms(case)
    shared = person(case, "Candidate Channel", shared=True)
    group_only = person(case, "Candidate Group")
    guest = person(case, "Candidate Guest", role="guest", shared=True)
    with case.world.session(org) as db:
        room = CommsConversation(
            org_id=org.id, kind="group", scope="members", name="Group only", created_by=org.author
        )
        db.add(room)
        db.flush()
        for identity in (org.peer, group_only):
            db.add(CommsMember(org_id=org.id, conversation_id=room.id, user_id=identity))
        db.commit()
    rule(case, policy)
    found = _ok(case.client(org.peer, org.id).get(ROOT, params={"q": "Candidate"}))["items"]
    expected = (
        {shared, group_only}
        if policy == "everyone"
        else {shared}
        if policy == "shared-channel"
        else set()
    )
    assert {row["user_id"] for row in found} == {str(identity) for identity in expected}
    assert case.client(guest, org.id).get(ROOT, params={"q": "Candidate"}).status_code == 403


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"q": " "},
        {"q": "x" * 101},
        {"q": "x", "limit": 0},
        {"q": "x", "limit": 21},
        {"q": "x", "limit": "1.5"},
        {"q": "x", "unknown": "value"},
    ],
)
def test_query_requires_bounded_trimmed_text_and_limit(candidate_routes, params):
    case, org = candidate_routes, candidate_routes.world.first
    assert case.client(org.peer, org.id).get(ROOT, params=params).status_code == 422


def test_sql_candidate_bound_precedes_visibility_and_filters_inactive_before_bound(
    candidate_routes,
):
    case, org = candidate_routes, candidate_routes.world.first
    private_rooms(case)
    identities = [
        person(case, f"Candidate {index:03}", shared=index == 100) for index in range(101)
    ]
    api = case.client(org.peer, org.id)
    assert _ok(api.get(ROOT, params={"q": "Candidate", "limit": 20})) == {"items": []}
    with case.world.session(org) as db:
        db.get(User, identities[0]).status = "disabled"
        db.commit()
    assert [row["user_id"] for row in _ok(api.get(ROOT, params={"q": "Candidate"}))["items"]] == [
        str(identities[100]),
    ]


def test_final_limit_self_exclusion_literal_search_and_constant_query_count(candidate_routes):
    case, org = candidate_routes, candidate_routes.world.first
    with case.world.session(org) as db:
        db.get(User, org.peer).display_name = "Candidate 000"
        db.commit()
    identities = [person(case, f"Candidate {index:03}") for index in range(1, 22)]
    literal = person(case, "Candidate 100%")
    api = case.client(org.peer, org.id)
    counter = []

    def counted(*_args):
        counter.append(1)  # Counts only, never SQL text or parameter values.

    event.listen(case.world.runtime, "before_cursor_execute", counted)
    try:
        small = _ok(api.get(ROOT, params={"q": "Candidate 001"}))["items"]
        small_count = len(counter)
        counter.clear()
        large = _ok(api.get(ROOT, params={"q": "Candidate"}))["items"]
        large_count = len(counter)
    finally:
        event.remove(case.world.runtime, "before_cursor_execute", counted)
    assert [row["user_id"] for row in small] == [str(identities[0])]
    assert [row["user_id"] for row in large] == [str(identity) for identity in identities[:20]]
    assert large_count == small_count and 0 < large_count <= 32
    assert [
        row["user_id"] for row in _ok(api.get(ROOT, params={"q": "%", "limit": 1}))["items"]
    ] == [str(literal)]
    assert len(_ok(api.get(ROOT, params={"q": "Candidate", "limit": 1}))["items"]) == 1
