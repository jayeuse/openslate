"""Real template CRUD and atomic locked-key-aware channel application."""

import json

import pytest
from sqlalchemy import func, select

from app.systems.access.users.models import Membership
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.message_support import _ok

pytestmark = pytest.mark.integration
ROOT = "/api/comms/templates"


def template_request():
    return {
        "name": "Owned defaults",
        "description": "Template test",
        "settings": {"slow_mode_seconds": 5, "allow_export": False},
    }


def test_template_crud_is_admin_versioned_and_raw_json_is_bounded(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    assert peer.post(ROOT, json=template_request()).status_code == 403
    created = api.post(ROOT, json=template_request())
    row = _ok(created, 201)
    assert row["org_id"] == str(org.id) and row["settings"] == template_request()["settings"]
    path = ROOT + "/" + row["id"]
    assert created.headers["location"] == path and "no-store" in created.headers["cache-control"]
    assert _ok(api.get(path))["id"] == row["id"]
    assert _ok(api.get(ROOT))["pagination"]["total"] == 1
    assert api.put(path, json=template_request()).status_code == 428
    updated = api.put(
        path,
        json={**template_request(), "name": "Updated"},
        headers={"If-Match": created.headers["etag"]},
    )
    assert _ok(updated)["name"] == "Updated"
    assert (
        api.put(
            path, json=template_request(), headers={"If-Match": created.headers["etag"]}
        ).status_code
        == 412
    )
    for settings in ({"message_days": 0}, {"dm_rule": "everyone"}, {"quiet_hours_start": "22:00"}):
        assert api.post(ROOT, json={**template_request(), "settings": settings}).status_code == 422
    raw = json.dumps(template_request()).encode()
    exact = raw + b" " * (65536 - len(raw))
    assert (
        api.post(ROOT, content=exact, headers={"Content-Type": "application/json"}).status_code
        == 201
    )
    assert (
        api.post(
            ROOT, content=exact + b" ", headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )
    assert (
        api.post(
            ROOT, content=b"!" * 65537, headers={"Content-Type": "application/json"}
        ).status_code
        == 413
    )


def test_bulk_template_preview_binds_source_targets_and_workspace_locks(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    created = api.post(
        ROOT,
        json={
            **template_request(),
            "capabilities": {
                "everyone": {"react": False},
                "group_grants": [{"group_id": str(org.group), "capability": "pin"}],
            },
        },
    )
    row = _ok(created, 201)
    path = ROOT + "/" + row["id"]
    workspace = "/api/comms/settings/workspace"
    current = api.get(workspace)
    locks = api.put(
        workspace + "/locks",
        json={"keys": ["slow_mode_seconds"]},
        headers={"If-Match": current.headers["etag"]},
    )
    assert locks.status_code == 200
    current = api.get(workspace)
    assert (
        api.put(
            workspace + "/capability-locks",
            json={"capabilities": ["pin"]},
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 200
    )
    request = {
        "conversation_ids": [str(org.conversation), str(org.other_conversation)],
        "keys": ["slow_mode_seconds", "allow_export"],
        "capability_keys": ["react", "pin"],
    }
    for identity in request["conversation_ids"]:
        settings_path = "/api/comms/settings/channel/" + identity
        current = api.get(settings_path)
        seeded = api.put(
            settings_path + "/capabilities",
            json={
                "scope": {"kind": "channel", "id": identity},
                "group_grants": [],
                "everyone": {"react": True},
            },
            headers={"If-Match": current.headers["etag"]},
        )
        assert seeded.status_code == 200
    preview = api.post(path + "/application-preview", json=request)
    for item in _ok(preview)["items"]:
        assert item["after"] == {"allow_export": False}
        assert item["skipped_locked_keys"] == ["slow_mode_seconds"]
        assert item["capabilities"]["skipped_locked"] == ["pin"]
    assert api.post(path + "/applications", json=request).status_code == 428
    changed = api.put(
        path,
        json={**template_request(), "settings": {"allow_export": True}},
        headers={"If-Match": created.headers["etag"]},
    )
    assert changed.status_code == 200
    assert (
        api.post(
            path + "/applications", json=request, headers={"If-Match": preview.headers["etag"]}
        ).status_code
        == 412
    )
    fresh = api.post(path + "/application-preview", json=request)
    applied = _ok(
        api.post(path + "/applications", json=request, headers={"If-Match": fresh.headers["etag"]})
    )
    assert len(applied["items"]) == 2
    for identity in request["conversation_ids"]:
        settings = _ok(api.get("/api/comms/settings/channel/" + identity))
        assert settings["overrides"] == {"allow_export": True}
        assert settings["effective"]["slow_mode_seconds"] == 0
        caps = _ok(api.get("/api/comms/settings/channel/" + identity + "/capabilities"))
        assert caps["everyone"] == {"react": True}  # Omitted source capabilities never clear it.


def test_capability_only_templates_apply_without_duplicate_noop_audit(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    created = _ok(
        api.post(
            ROOT,
            json={
                "name": "Capability only",
                "description": "",
                "settings": {},
                "capabilities": {
                    "everyone": {},
                    "group_grants": [
                        {"group_id": str(org.group), "capability": "pin"},
                        {"group_id": str(org.group), "capability": "mentionChannel"},
                    ],
                },
            },
        ),
        201,
    )
    path = ROOT + "/" + created["id"]
    request = {
        "conversation_ids": [str(org.conversation)],
        "keys": [],
        "capability_keys": ["pin", "mentionChannel"],
    }
    preview = api.post(path + "/application-preview", json=request)
    assert preview.status_code == 200
    assert (
        api.post(
            path + "/applications", json=request, headers={"If-Match": preview.headers["etag"]}
        ).status_code
        == 200
    )
    caps = _ok(api.get(f"/api/comms/settings/channel/{org.conversation}/capabilities"))
    assert {row["capability"] for row in caps["group_grants"]} == {"pin", "mentionChannel"}
    with case.world.session(org) as db:
        before = db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.entity_type == "comms_capability_grants",
            )
        )
    preview = api.post(path + "/application-preview", json=request)
    assert (
        api.post(
            path + "/applications", json=request, headers={"If-Match": preview.headers["etag"]}
        ).status_code
        == 200
    )
    with case.world.session(org) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(
                    AuditLog.entity_type == "comms_capability_grants",
                )
            )
            == before
        )


def test_templates_reject_foreign_and_unreadable_sources_without_partial_targets(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    created = _ok(api.post(ROOT, json=template_request()), 201)
    path = ROOT + "/" + created["id"]
    with case.world.session(case.world.second) as db:
        db.scalars(
            select(Membership).where(
                Membership.user_id == case.world.second.author,
            )
        ).one().role = "admin"
        db.commit()
    other = case.client(case.world.second.author, case.world.second.id)
    assert other.get(path).status_code == 404
    for capabilities in (
        {
            "everyone": {},
            "group_grants": [{"group_id": str(case.world.second.group), "capability": "pin"}],
        },
        {
            "everyone": {},
            "group_grants": [{"group_id": str(org.group), "capability": "createChannel"}],
        },
        {"everyone": {"manageChannel": True}, "group_grants": []},
    ):
        assert (
            api.post(ROOT, json={**template_request(), "capabilities": capabilities}).status_code
            == 422
        )
    assert _ok(api.get(ROOT))["pagination"]["total"] == 1
    request = {
        "conversation_ids": [str(org.conversation), str(case.world.second.conversation)],
        "keys": ["allow_export"],
    }
    assert api.post(path + "/application-preview", json=request).status_code == 404
    with case.world.session(org) as db:
        hidden = db.get(CommsConversation, org.other_conversation)
        # D43: a group message the admin is not part of; D44 has no private channel.
        hidden.kind, hidden.scope, hidden.category_id = "group", "members", None
        hidden.created_by = org.peer
        membership = db.scalars(
            select(CommsMember).where(
                CommsMember.conversation_id == org.other_conversation,
                CommsMember.user_id == org.author,
            )
        ).one()
        db.delete(membership)
        db.commit()
    request["conversation_ids"] = [str(org.conversation), str(org.other_conversation)]
    assert api.post(path + "/application-preview", json=request).status_code == 404
    assert _ok(api.get(f"/api/comms/settings/channel/{org.conversation}"))["overrides"] == {}
