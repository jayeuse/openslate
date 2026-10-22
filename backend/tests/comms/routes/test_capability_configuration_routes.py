"""S16 decisions projected through exact-scope configuration and person inspections."""

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.settings.models import CommsCapabilityGrant
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from tests.comms.routes.settings_support import stored
from tests.comms.routes.structure_support import (
    ROOT,
    _channel,
    _created,
    _error,
    _ok,
    _read,
    _tag,
    _unchanged_read,
)

pytestmark = pytest.mark.integration


def test_exact_scope_grants_locks_inspections_and_truthful_self_removal(structure_routes):
    case, org, foreign = (
        structure_routes,
        structure_routes.world.first,
        structure_routes.world.second,
    )
    case.add_home_members(foreign.peer)
    admin, actor, other = (
        case.client(person, org.id) for person in (org.author, org.peer, foreign.peer)
    )
    with case.world.session(org) as db:
        # D44: both people read through department roles; only the actor is in org.group.
        readers = Group(org_id=org.id, name="Configuration readers")
        db.add(readers)
        db.flush()
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(GroupMember(org_id=org.id, group_id=readers.id, user_id=foreign.peer))
        for group in (org.group, readers.id):
            db.add(
                GroupAccess(
                    org_id=org.id, group_id=group, department_id=org.department, level="read"
                )
            )
        db.commit()
    row, path = _created(
        admin,
        ROOT + "/conversations",
        _channel(
            "Configuration authority",
            org.category,
            "department",
            department_id=str(org.department),
        ),
    )
    workspace = ROOT + "/settings/workspace/capabilities"
    category = f"{ROOT}/settings/category/{org.category}/capabilities"
    local = f"{ROOT}/settings/channel/{row['id']}/capabilities"
    locks = ROOT + "/settings/workspace/capability-locks"
    bodies = [
        {
            "scope": {"kind": "workspace"},
            "everyone": {},
            "group_grants": [{"group_id": str(org.group), "capability": "pin"}],
        },
        {
            "scope": {"kind": "category", "id": str(org.category)},
            "everyone": {},
            "group_grants": [{"group_id": str(org.group), "capability": "reply"}],
        },
        {
            "scope": {"kind": "channel", "id": row["id"]},
            "everyone": {},
            "group_grants": [
                {"group_id": str(org.group), "capability": "manageChannel"},
                {"group_id": str(org.group), "capability": "moderate"},
            ],
        },
    ]
    before = stored(case)
    original = _read(admin, local)
    _unchanged_read(admin, local, original)
    assert stored(case) == before
    for endpoint, body in zip((workspace, category, local), bodies, strict=True):
        saved = admin.put(endpoint, headers={"If-Match": _tag(_read(admin, endpoint))}, json=body)
        assert _ok(saved)["scope"] == body["scope"]
        assert {tuple(sorted(grant.items())) for grant in saved.json()["group_grants"]} == {
            tuple(sorted(grant.items())) for grant in body["group_grants"]
        }
        _unchanged_read(admin, endpoint, saved)
    rights = _ok(actor.get(path + "/capabilities"))
    assert rights["conversation_level"] == "read" and rights["manager_source"] is None
    assert rights["capabilities"]["manageChannel"]["allowed"] is True
    assert rights["capabilities"]["moderate"]["allowed"] is True
    assert _ok(actor.get(path + f"/capabilities/{foreign.peer}"))["user_id"] == str(foreign.peer)
    _error(other.get(path + f"/capabilities/{org.peer}"), 403)
    _error(actor.get(path + f"/capabilities/{foreign.author}"), 404)
    current = _read(actor, local)
    before = stored(case)
    _error(actor.put(local, json=bodies[2]), 428)
    _error(actor.put(local, headers={"If-Match": _tag(original)}, json=bodies[2]), 412)
    _error(actor.put(local, headers={"If-Match": _tag(current)}, json=bodies[0]), 422)
    _error(
        actor.put(category, headers={"If-Match": _tag(_read(admin, category))}, json=bodies[1]), 403
    )
    for bad in (
        {**bodies[2], "group_grants": [{"group_id": str(foreign.group), "capability": "pin"}]},
        {**bodies[2], "everyone": {"manageChannel": True}},
        {**bodies[2], "group_grants": [{"user_id": str(org.peer), "capability": "pin"}]},
    ):
        _error(admin.put(local, headers={"If-Match": _tag(current)}, json=bad), 422)
    assert stored(case) == before
    original_locks = _read(admin, locks)
    _error(admin.put(locks, json={"capabilities": ["pin", "reply"]}), 428)
    _error(
        actor.put(locks, headers={"If-Match": _tag(original_locks)}, json={"capabilities": []}), 403
    )
    locked = admin.put(
        locks, headers={"If-Match": _tag(original_locks)}, json={"capabilities": ["pin", "reply"]}
    )
    assert set(_ok(locked)["capabilities"]) == {"pin", "reply"}
    assert _tag(locked) != _tag(original_locks)
    assert _ok(actor.get(path + "/capabilities"))["capabilities"]["pin"] == {
        "allowed": True,
        "source": {"kind": "workspace_lock", "enabled": True},
    }
    assert _ok(other.get(path + "/capabilities"))["capabilities"]["pin"]["allowed"] is False
    current = _read(actor, local)
    before = stored(case)
    _error(
        admin.put(locks, headers={"If-Match": _tag(original_locks)}, json={"capabilities": []}), 412
    )
    _error(
        actor.put(
            local,
            headers={"If-Match": _tag(current)},
            json={
                **bodies[2],
                "everyone": {"reply": True},
                "group_grants": bodies[2]["group_grants"][:1],
            },
        ),
        403,
    )
    assert stored(case) == before
    _ok(
        admin.put(locks, headers={"If-Match": _tag(_read(admin, locks))}, json={"capabilities": []})
    )
    current = _read(actor, local)
    with case.world.session(org) as db:
        old_ids = set(
            db.scalars(
                select(CommsCapabilityGrant.id).where(
                    CommsCapabilityGrant.org_id == org.id,
                    CommsCapabilityGrant.conversation_id == row["id"],
                )
            )
        )
    empty = {"scope": bodies[2]["scope"], "group_grants": [], "everyone": {}}
    removed = actor.put(local, headers={"If-Match": _tag(current)}, json=empty)
    assert _ok(removed) == empty
    _unchanged_read(actor, local, removed)
    assert not _ok(actor.get(path + "/capabilities"))["capabilities"]["manageChannel"]["allowed"]
    _error(actor.put(local, headers={"If-Match": _tag(removed)}, json=bodies[2]), 403)
    _error(actor.get(path + f"/capabilities/{foreign.peer}"), 403)
    assert _ok(actor.get(path + "/capabilities"))["capabilities"]["pin"]["allowed"] is True
    with case.world.session(org) as db:
        logs = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.org_id == org.id,
                    AuditLog.entity_id.in_(old_ids),
                    AuditLog.action == "delete",
                )
            )
        )
        assert {log.entity_id for log in logs} == old_ids
        assert all(log.performed_by == org.peer and log.request_path == local for log in logs)


def test_configuration_scope_privacy_foreign_grants_and_creation_checks(structure_routes):
    case, org, foreign = (
        structure_routes,
        structure_routes.world.first,
        structure_routes.world.second,
    )
    admin, manager = case.client(org.author, org.id), case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="manage"
            )
        )
        db.commit()
    creation = ROOT + "/capabilities/channel-creation"
    assert not _ok(manager.get(creation, params={"scope_kind": "workspace"}))["decision"]["allowed"]
    assert _ok(
        manager.get(creation, params={"scope_kind": "category", "category_id": str(org.category)})
    )["decision"]["allowed"]
    for query in (
        {"scope_kind": "channel", "category_id": str(org.category)},
        {"scope_kind": "workspace", "category_id": str(org.category)},
        {"scope_kind": "category"},
        {"user_id": str(org.author)},
    ):
        _error(admin.get(creation, params=query), 422)
    _error(
        admin.get(
            creation, params={"scope_kind": "category", "category_id": str(foreign.category)}
        ),
        404,
    )
    with case.world.session(org) as db:
        # D44: another department's channel stored in this category (setup bypasses A8).
        other = Department(org_id=org.id, department_name="Other authority department")
        readers = Group(org_id=org.id, name="Other department readers")
        db.add_all([other, readers])
        db.flush()
        db.add(GroupMember(org_id=org.id, group_id=readers.id, user_id=org.peer))
        db.add(
            GroupAccess(org_id=org.id, group_id=readers.id, department_id=other.id, level="read")
        )
        sibling = CommsConversation(
            org_id=org.id, kind="channel", scope="department", department_id=other.id,
            category_id=org.category, name="Other authority", created_by=org.author,
        )
        db.add(sibling)
        db.flush()
        identity = str(sibling.id)
        db.commit()
    # Category placement must not give the department manager another department's channel.
    private_settings = f"{ROOT}/settings/channel/{identity}"
    _error(
        manager.patch(
            private_settings,
            headers={"If-Match": _tag(_read(manager, private_settings))},
            json={"formatting": False},
        ),
        403,
    )
    category = f"{ROOT}/settings/category/{org.category}"
    _ok(
        manager.patch(
            category,
            headers={"If-Match": _tag(_read(manager, category))},
            json={"formatting": False},
        )
    )
    neighbour = case.client(foreign.author, foreign.id)
    before = stored(case, foreign)
    for kind, identity in (("category", foreign.category), ("channel", foreign.conversation)):
        path = f"{ROOT}/settings/{kind}/{identity}/capabilities"
        current = _read(neighbour, path)
        _error(admin.get(path), 404)
        _error(
            admin.put(
                path,
                headers={"If-Match": _tag(current)},
                json={
                    "scope": {"kind": kind, "id": str(identity)},
                    "everyone": {},
                    "group_grants": [],
                },
            ),
            404,
        )
    assert stored(case, foreign) == before
