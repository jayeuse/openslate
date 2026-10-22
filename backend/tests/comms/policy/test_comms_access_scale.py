"""Comms access results at Harbor size: one literal owner for the relation's outputs.

The expected sets are worked out by hand from the world in ``harbor_scale_support``;
they guard a performance-only change to the access relation (D36, D43, D44, D45).
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import GroupMember
from app.systems.access.users.person_visibility import visible_person_ids
from app.systems.comms.access import (
    conversation_reader_counts,
    explain_conversation_access,
    readable_conversation_ids,
)
from app.systems.comms.conversations.models import CommsConversation
from tests.comms.harbor_scale_support import build_harbor_scale

pytestmark = pytest.mark.integration


def test_harbor_scale_access_relation_results(policy_case):
    c, db = policy_case, policy_case.db
    world = build_harbor_scale(db, c.org.id, c.admin, c.peer)
    names = {identity: name for name, identity in world.conversations.items()}
    accounts, teams, guests = world.accounts, world.teams, world.guests

    def readable(user):
        return {names[identity] for identity in readable_conversation_ids(db, user)}

    organization = {"O0", "O1", "O2"}
    assert readable(accounts["writer"]) == organization | {
        "K0", "K1", "Grp0", "Grp1", "Grp2", "Grp3", "Dir1", "Dir3", "Dir5",
    }
    assert readable(accounts["guest"]) == organization | {"K3"}
    assert readable(guests[0]) == organization | {"K0", "K1", "K2", "K3", "K4", "K5"}
    assert readable(accounts["manager"]) == organization | {"K2", "GG0", "GG1"}
    assert readable(accounts["admin"]) == organization | {
        "K0", "K1", "K2", "K3", "K4", "K5", "Dir0", "Dir2", "Dir4",
    }
    assert readable(accounts["noaccess"]) == organization
    assert readable(teams[4][2]) == organization | {"K4", "GG0"}

    counts = conversation_reader_counts(db, world.channel_ids())
    assert {names[identity]: count for identity, count in counts.items()} == {
        "K0": 18, "K1": 18, "K2": 18, "K3": 18, "K4": 20, "K5": 19,
        "O0": 44, "O1": 44, "O2": 44,
    }

    explained = {
        (account, channel): explain_conversation_access(db, user, world.conversations[channel])
        for account, user, channel in (
            ("writer", accounts["writer"], "K0"),
            ("writer", accounts["writer"], "K1"),
            ("manager", accounts["manager"], "K2"),
            ("guest", accounts["guest"], "K3"),
            ("guest0", guests[0], "K2"),
            ("lead", teams[2][0], "K2"),
            ("admin", accounts["admin"], "K3"),
            ("noaccess", accounts["noaccess"], "K0"),
        )
    }
    assert {key: (row.level, row.manager_source, row.source) for key, row in explained.items()} == {
        ("writer", "K0"): ("post", None, {"kind": "grant"}),
        ("writer", "K1"): (
            "read", None, {"kind": "department", "department_id": db.get(
                CommsConversation, world.conversations["K1"]).department_id},
        ),
        ("manager", "K2"): (
            "manage", "department_manager",
            {"kind": "manager", "reason": "department_manager"},
        ),
        ("guest", "K3"): ("read", None, {"kind": "guest_cap"}),
        ("guest0", "K2"): ("read", None, {"kind": "guest_cap"}),
        ("lead", "K2"): (
            "manage", "department_manager",
            {"kind": "manager", "reason": "department_manager"},
        ),
        ("admin", "K3"): ("manage", None, {"kind": "admin"}),
        ("noaccess", "K0"): ("none", None, {"kind": "none", "reason": "no_access"}),
    }

    everyone = {person.id for person in world.people} | {c.actor.id}
    active = everyone - {person.id for person in world.inactive}
    # Organization channels make every active person visible to every other one.
    assert visible_person_ids(db, accounts["writer"], everyone) == active
    for name in organization:
        db.get(CommsConversation, world.conversations[name]).is_deleted = True
    db.flush()
    writer_peers = {
        *(person for n in (0, 1, 2, 3, 5) for person in teams[n]), teams[4][0], *guests,
        accounts["writer"], accounts["admin"],
    }
    assert visible_person_ids(db, accounts["writer"], everyone) == {
        person.id for person in writer_peers
    }
    guest_peers = {
        *teams[2], *teams[3], *(team[0] for team in teams), *guests,
        accounts["admin"], accounts["guest"],
    }
    assert visible_person_ids(db, accounts["guest"], everyone) == {
        person.id for person in guest_peers
    }

    # Department-row edges, organization channels still deleted: a deleted group, a
    # deleted group membership and a deleted department each remove only their path.
    def soft_delete(row):
        row.is_deleted, row.deleted_at = True, datetime(2000, 1, 1, tzinfo=UTC)
        db.flush()

    assert readable(teams[1][2]) == {"K1", "Grp1"}
    soft_delete(world.groups["Team 1"])
    assert readable(teams[1][2]) == {"Grp1"}
    assert readable(accounts["guest"]) == {"K3"}
    soft_delete(db.scalar(select(GroupMember).where(
        GroupMember.group_id == world.groups["Guest"].id,
        GroupMember.user_id == accounts["guest"].id,
    )))
    assert readable(accounts["guest"]) == set()
    assert readable(teams[4][2]) == {"K4", "GG0"}
    soft_delete(world.departments[4])
    assert readable(teams[4][2]) == {"GG0"}
    assert readable(guests[0]) == {"K0", "K1", "K2", "K3", "K5"}
    # An administrator keeps a department channel whose department is deleted.
    assert readable(accounts["admin"]) == {
        "K0", "K1", "K2", "K3", "K4", "K5", "Dir0", "Dir2", "Dir4",
    }
