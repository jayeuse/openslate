"""Copying a channel requires both current scopes and copies configuration, never messages."""

from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import GroupAccess, GroupMember
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettingLock, CommsSettings
from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.structure_support import (
    ROOT,
    _channel,
    _configuration,
    _created,
    _error,
    _ok,
    _read,
    _snapshot,
    _tag,
    _unchanged_read,
)

pytestmark = pytest.mark.integration


def test_duplicate_copies_scope_but_not_manager_roles_or_content(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="write"
            )
        )
        db.commit()
    source, path = _created(
        admin,
        ROOT + "/conversations",
        _channel("Department source", scope="department", department_id=str(org.department)),
    )
    with case.world.session(org) as db:
        db.add(
            CommsMember(
                org_id=org.id, conversation_id=UUID(source["id"]), user_id=org.peer, role="manager"
            )
        )
        db.commit()
    assert _ok(peer.get(path))["level"] == "manage"
    copied = _ok(
        admin.post(
            path + "/duplicates",
            headers={"If-Match": _tag(_read(admin, path))},
            json={"name": "Department copy", "category_id": None},
        ),
        201,
    )
    copy_path = ROOT + "/conversations/" + copied["id"]
    current = _ok(peer.get(copy_path))
    assert (current["scope"], current["department_id"], current["level"]) == (
        "department",
        str(org.department),
        "post",
    )
    assert current["member_role"] == "member" and current["member_count"] == 2
    assert _ok(peer.get(copy_path + "/messages"))["items"] == []


def test_duplicate_checks_both_scopes_and_copies_configuration_without_content(duplicate_source):
    case, destination = duplicate_source
    org = case.world.first
    admin, actor = case.client(org.author, org.id), case.client(org.peer, org.id)
    source = f"{ROOT}/conversations/{org.conversation}"
    endpoint = source + "/duplicates"
    payload = {"name": "Copied room", "category_id": str(destination)}
    for capability in ("createChannel", "manageChannel"):
        with case.world.session(org) as db:
            grant = db.scalar(
                select(CommsCapabilityGrant).where(
                    CommsCapabilityGrant.org_id == org.id,
                    CommsCapabilityGrant.capability == capability,
                )
            )
            grant.is_deleted = True
            db.commit()
        before = _snapshot(case)
        _error(
            actor.post(endpoint, headers={"If-Match": _tag(_read(actor, source))}, json=payload),
            403,
            "comms_capability_denied",
        )
        assert _snapshot(case) == before
        with case.world.session(org) as db:
            grant = db.scalar(
                select(CommsCapabilityGrant).where(
                    CommsCapabilityGrant.org_id == org.id,
                    CommsCapabilityGrant.capability == capability,
                )
            )
            grant.is_deleted = False
            db.commit()
    stale = _read(actor, source)
    _ok(
        admin.patch(
            source,
            headers={"If-Match": _tag(_read(admin, source))},
            json={"topic": "Current source"},
        )
    )
    current = _read(actor, source)
    before = _snapshot(case)
    _error(
        actor.post(endpoint, headers={"If-Match": _tag(stale)}, json=payload),
        412,
        "comms_precondition_failed",
    )
    _error(actor.post(endpoint, json=payload), 428, "comms_precondition_required")
    _error(
        actor.post(
            endpoint,
            headers={"If-Match": _tag(current)},
            json=payload
            | {
                "category_id": str(case.world.second.category),
            },
        ),
        404,
        "comms_not_found",
    )
    assert _snapshot(case) == before
    response = actor.post(endpoint, headers={"If-Match": _tag(current)}, json=payload)
    copied = _ok(response, 201)
    identity = UUID(copied["id"])
    assert response.headers["location"] == f"{ROOT}/conversations/{identity}"
    assert (
        copied["name"],
        copied["topic"],
        copied["scope"],
        copied["category_id"],
        copied["department_id"],
        copied["level"],
    ) == (
        "Copied room",
        "Current source",
        "department",
        str(destination),
        str(org.department),
        "manage",
    )
    settings, grants = _configuration(case, identity)
    assert settings["overrides"] == {"edit_window_minutes": 17}
    assert settings["effective"]["formatting"] is False
    assert settings["sources"]["formatting"] == {"kind": "category", "id": destination}
    assert grants == [("manageChannel", "group", org.group, True)]
    assert _ok(actor.get(f"{ROOT}/conversations/{identity}/messages"))["items"] == []
    original = _ok(actor.get(source + "/messages"))
    assert [row["seq"] for row in original["items"]] == [1, 2, 3]
    assert [row["body"] for row in original["items"]] == [
        f"Private bootstrap body {n}" for n in (1, 2, 3)
    ]
    _unchanged_read(actor, source, current)
    with case.world.session(org) as db:
        row = db.get(CommsConversation, identity)
        assert row.created_by == org.peer and row.performed_by == org.peer
        assert (
            db.scalar(
                select(CommsConversationCounter.last_seq).where(
                    CommsConversationCounter.conversation_id == identity,
                )
            )
            == 0
        )
        assert (
            db.scalars(
                select(CommsMessage.id).where(CommsMessage.conversation_id == identity)
            ).all()
            == []
        )
        copied_ids = {identity}
        for model in (CommsSettings, CommsCapabilityGrant):
            new = set(db.scalars(select(model.id).where(model.conversation_id == identity)))
            old = set(db.scalars(select(model.id).where(model.conversation_id == org.conversation)))
            assert new and new.isdisjoint(old)
            copied_ids.update(new)
        logs = db.scalars(select(AuditLog).where(AuditLog.entity_id.in_(copied_ids))).all()
        assert {row.entity_id for row in logs} == copied_ids
        assert all(
            row.action == "create"
            and row.before is None
            and row.performed_by == org.peer
            and row.request_path == endpoint
            for row in logs
        )
        assert len({row.request_id for row in logs}) == 1


def test_copy_etag_includes_local_configuration_and_honors_workspace_locks(duplicate_source):
    case, destination = duplicate_source
    org = case.world.first
    actor = case.client(org.peer, org.id)
    source = f"{ROOT}/conversations/{org.conversation}"
    original = _read(actor, source)
    case.settings({"edit_window_minutes": 19, "formatting": False}, org.conversation)
    configured = _read(actor, source)
    assert _tag(configured) != _tag(original)
    payload = {"name": "Locked copy", "category_id": str(destination)}
    _error(
        actor.post(source + "/duplicates", headers={"If-Match": _tag(original)}, json=payload),
        412,
        "comms_precondition_failed",
    )
    with case.world.session(org) as db:
        db.add(
            CommsCapabilityGrant(
                org_id=org.id,
                scope="channel",
                conversation_id=org.conversation,
                subject="everyone",
                capability="reply",
                granted=False,
            )
        )
        db.commit()
    changed = _read(actor, source)
    assert _tag(changed) != _tag(configured)
    _error(
        actor.post(source + "/duplicates", headers={"If-Match": _tag(configured)}, json=payload),
        412,
        "comms_precondition_failed",
    )
    case.settings({"formatting": True})
    with case.world.session(org) as db:
        db.add(CommsSettingLock(org_id=org.id, namespace="setting", key="formatting"))
        db.commit()
    row = _ok(
        actor.post(
            source + "/duplicates", headers={"If-Match": _tag(_read(actor, source))}, json=payload
        ),
        201,
    )
    settings, _ = _configuration(case, row["id"])
    assert settings["effective"]["formatting"] is True
    assert settings["sources"]["formatting"] == {"kind": "workspace"}
    assert "formatting" in settings["locked_keys"]
