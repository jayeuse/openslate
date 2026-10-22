"""Scope-complete history from real audit and protected restoration through current writers."""

from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.access.policy.models import Group
from app.systems.access.users.models import Membership
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.settings.models import CommsSettings
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)
from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient
from tests.comms.routes.message_support import _ok

pytestmark = pytest.mark.integration
ROOT = "/api/comms/settings/workspace"


def test_history_projects_real_audit_and_restores_complete_prior_configuration(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    current = api.get(ROOT)
    changed = api.patch(
        ROOT,
        json={"slow_mode_seconds": 5, "allow_export": True},
        headers={"If-Match": current.headers["etag"]},
    )
    assert changed.status_code == 200
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 7}, headers={"If-Match": changed.headers["etag"]}
    )
    assert changed.status_code == 200
    page = _ok(api.get(ROOT + "/history"))
    entry = next(
        row for row in page["items"] if row["before"]["settings"].get("slow_mode_seconds") == 5
    )
    assert entry["before"]["settings"] == {"slow_mode_seconds": 5, "allow_export": True}
    assert entry["after"]["settings"] == {"slow_mode_seconds": 7, "allow_export": True}
    assert entry["scope"] == {"kind": "workspace"}
    with case.world.session(org) as db:
        assert db.get(AuditLog, UUID(entry["id"])) is not None
    assert _ok(api.get(ROOT + "/history/" + entry["id"])) == entry
    assert case.client(org.peer, org.id).get(ROOT + "/history").status_code == 403
    request = {"history_id": entry["id"], "password": "owned-test-password"}
    assert api.post(ROOT + "/restoration-preview", json=request).status_code == 428
    assert (
        api.post(
            ROOT + "/restoration-preview",
            json={**request, "password": "wrong"},
            headers={"If-Match": changed.headers["etag"]},
        ).status_code
        == 403
    )
    preview = api.post(
        ROOT + "/restoration-preview", json=request, headers={"If-Match": changed.headers["etag"]}
    )
    body = _ok(preview)
    assert body["after"] == entry["before"]
    restored = api.post(
        ROOT + "/restoration",
        json={**request, "preview_digest": body["preview_digest"]},
        headers={"If-Match": preview.headers["etag"]},
    )
    assert _ok(restored)["settings"] == entry["before"]["settings"]
    assert _ok(api.get(ROOT))["effective"]["slow_mode_seconds"] == 5
    assert api.post(
        ROOT + "/restoration",
        json={**request, "preview_digest": body["preview_digest"]},
        headers={"If-Match": preview.headers["etag"]},
    ).status_code in (403, 409, 412)


def test_restore_preview_rechecks_workspace_version_and_current_admin(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    first = api.get(ROOT)
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 5}, headers={"If-Match": first.headers["etag"]}
    )
    assert changed.status_code == 200
    entry = _ok(api.get(ROOT + "/history"))["items"][0]
    request = {"history_id": entry["id"], "password": "owned-test-password"}
    preview = api.post(
        ROOT + "/restoration-preview", json=request, headers={"If-Match": changed.headers["etag"]}
    )
    proof = _ok(preview)
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 8}, headers={"If-Match": changed.headers["etag"]}
    )
    assert changed.status_code == 200
    assert (
        api.post(
            ROOT + "/restoration",
            json={**request, "preview_digest": proof["preview_digest"]},
            headers={"If-Match": preview.headers["etag"]},
        ).status_code
        == 412
    )
    with case.world.session(org) as db:
        db.scalars(select(Membership).where(Membership.user_id == org.author)).one().role = "member"
        db.commit()
    assert api.get(ROOT + "/history").status_code == 403


@pytest.mark.parametrize("kind", ["category", "channel"])
def test_scope_history_keeps_capabilities_and_refuses_new_workspace_locks(tools_routes, kind):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    identity = org.category if kind == "category" else org.conversation
    path = f"/api/comms/settings/{kind}/{identity}"
    first = api.get(path)
    original = {
        "scope": {"kind": kind, "id": str(identity)},
        "group_grants": [{"group_id": str(org.group), "capability": "pin"}],
        "everyone": {"react": False},
    }
    saved = api.put(
        path + "/capabilities", json=original, headers={"If-Match": first.headers["etag"]}
    )
    assert saved.status_code == 200
    changed = api.put(
        path + "/capabilities",
        json={**original, "group_grants": [], "everyone": {}},
        headers={"If-Match": saved.headers["etag"]},
    )
    assert changed.status_code == 200
    entries = _ok(api.get(path + "/history"))["items"]
    entry = next(row for row in entries if row["before"]["capabilities"]["group_grants"])
    assert entry["before"]["capabilities"] == original
    assert _ok(api.get(path + "/history/" + entry["id"])) == entry
    assert api.get(ROOT + "/history/" + entry["id"]).status_code == 404
    assert not {"dm_rule", "setting_locks", "capability_locks"} & entry["before"].keys()
    workspace = api.get(ROOT)
    assert (
        api.put(
            ROOT + "/capability-locks",
            json={"capabilities": ["pin"]},
            headers={"If-Match": workspace.headers["etag"]},
        ).status_code
        == 200
    )
    current = api.get(path)
    request = {"history_id": entry["id"], "password": "owned-test-password"}
    assert (
        api.post(
            path + "/restoration-preview",
            json=request,
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 403
    )
    workspace = api.get(ROOT)
    assert (
        api.put(
            ROOT + "/capability-locks",
            json={"capabilities": []},
            headers={"If-Match": workspace.headers["etag"]},
        ).status_code
        == 200
    )
    current = api.get(path)
    preview = api.post(
        path + "/restoration-preview", json=request, headers={"If-Match": current.headers["etag"]}
    )
    proof = _ok(preview)
    restored = _ok(
        api.post(
            path + "/restoration",
            json={**request, "preview_digest": proof["preview_digest"]},
            headers={"If-Match": preview.headers["etag"]},
        )
    )
    assert restored["capabilities"] == original


def test_history_read_tolerance_does_not_restore_unavailable_group_references(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    current = api.get(ROOT)
    grant = {
        "scope": {"kind": "workspace"},
        "everyone": {},
        "group_grants": [{"group_id": str(org.group), "capability": "pin"}],
    }
    saved = api.put(
        ROOT + "/capabilities", json=grant, headers={"If-Match": current.headers["etag"]}
    )
    assert saved.status_code == 200
    changed = api.put(
        ROOT + "/capabilities",
        json={**grant, "group_grants": []},
        headers={"If-Match": saved.headers["etag"]},
    )
    assert changed.status_code == 200
    with case.world.session(org) as db:
        db.get(Group, org.group).is_deleted = True
        db.commit()
    entries = _ok(api.get(ROOT + "/history"))["items"]
    entry = next(row for row in entries if row["before"]["capabilities"]["group_grants"])
    assert (
        api.post(
            ROOT + "/restoration-preview",
            json={"history_id": entry["id"], "password": "owned-test-password"},
            headers={"If-Match": changed.headers["etag"]},
        ).status_code
        == 422
    )


@pytest.mark.parametrize("operation", ["restoration-preview", "restoration"])
def test_password_verification_cannot_carry_admin_authority_across_role_loss(
    tools_routes, monkeypatch, operation
):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    current = api.get(ROOT)
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 5}, headers={"If-Match": current.headers["etag"]}
    )
    assert changed.status_code == 200
    entry = _ok(api.get(ROOT + "/history"))["items"][0]
    request = {"history_id": entry["id"], "password": "owned-test-password"}
    if operation == "restoration":
        proof = _ok(
            api.post(
                ROOT + "/restoration-preview",
                json=request,
                headers={"If-Match": changed.headers["etag"]},
            )
        )
        request["preview_digest"] = proof["preview_digest"]
    original = ProviderPasswordGrantClient.verify_password

    def demote(client, email, password):
        identity = original(client, email, password)
        with case.world.session(org, actor=org.peer) as db:
            for membership in db.scalars(select(Membership)):
                membership.role = "admin" if membership.user_id == org.peer else "member"
            db.commit()
        return identity

    monkeypatch.setattr(ProviderPasswordGrantClient, "verify_password", demote)
    assert (
        api.post(
            ROOT + "/" + operation,
            json=request,
            headers={"If-Match": changed.headers["etag"]},
        ).status_code
        == 403
    )
    replacement_admin = case.client(org.peer, org.id)
    assert _ok(replacement_admin.get(ROOT))["effective"]["slow_mode_seconds"] == 5


def test_history_requires_current_private_source_and_organization_authority(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    path = f"/api/comms/settings/channel/{org.conversation}"
    current = api.get(path)
    assert (
        api.patch(
            path, json={"slow_mode_seconds": 5}, headers={"If-Match": current.headers["etag"]}
        ).status_code
        == 200
    )
    entry = _ok(api.get(path + "/history"))["items"][0]
    with case.world.session(org) as db:
        room = db.get(CommsConversation, org.conversation)
        # D43: a group message the admin is not part of; D44 has no private channel.
        room.kind, room.scope, room.category_id = "group", "members", None
        room.created_by = org.peer
        membership = db.scalars(
            select(CommsMember).where(
                CommsMember.conversation_id == org.conversation,
                CommsMember.user_id == org.author,
            )
        ).one()
        db.delete(membership)
        db.commit()
    assert api.get(path + "/history/" + entry["id"]).status_code == 404
    with case.world.session(case.world.second) as db:
        db.scalars(
            select(Membership).where(Membership.user_id == case.world.second.author)
        ).one().role = "admin"
        db.commit()
    other = case.client(case.world.second.author, case.world.second.id)
    assert other.get(path + "/history/" + entry["id"]).status_code == 404


def test_legacy_history_never_exposes_unknown_secret_keys_or_bypasses_pair_validation(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    # Legacy fixture, not a permitted public settings write. Actual AuditSession must redact it.
    with case.world.session(org) as db:
        db.add(
            CommsSettings(
                org_id=org.id,
                scope="workspace",
                values={
                    "api_key": "synthetic-secret-canary",
                    "quiet_hours_start": "22:00",
                },
            )
        )
        db.commit()
    api = case.client(org.author, org.id)
    current = api.get(ROOT)
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 5}, headers={"If-Match": current.headers["etag"]}
    )
    assert changed.status_code == 200
    history = api.get(ROOT + "/history")
    page = _ok(history)
    assert "synthetic-secret-canary" not in history.text and "api_key" not in history.text
    entry = next(
        row for row in page["items"] if row["after"]["settings"].get("slow_mode_seconds") == 5
    )
    assert entry["before"]["settings"] == {"quiet_hours_start": "22:00"}
    assert (
        api.post(
            ROOT + "/restoration-preview",
            json={"history_id": entry["id"], "password": "owned-test-password"},
            headers={"If-Match": changed.headers["etag"]},
        ).status_code
        == 422
    )


def test_history_refuses_to_invent_snapshots_when_current_state_disagrees_with_audit(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    current = api.get(ROOT)
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 5}, headers={"If-Match": current.headers["etag"]}
    )
    assert changed.status_code == 200
    # Owned out-of-band drift fixture: the recorded after-state is5, not the live9.
    # This is not an application mutation or an assertion of audit coverage for operator SQL.
    with case.world.owner.begin() as connection:
        connection.execute(
            CommsSettings.__table__.update()
            .where(
                CommsSettings.org_id == org.id,
                CommsSettings.scope == "workspace",
            )
            .values(values={"slow_mode_seconds": 9})
        )
    response = api.get(ROOT + "/history")
    assert response.status_code == 503
    assert _ok(api.get(ROOT))["effective"]["slow_mode_seconds"] == 9


@pytest.mark.parametrize("operation", ["restoration-preview", "restoration"])
@pytest.mark.parametrize("status", [429, 503])
def test_confirmation_dependency_failure_is_truthful_and_does_not_restore(
    tools_routes,
    monkeypatch,
    operation,
    status,
):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    current = api.get(ROOT)
    changed = api.patch(
        ROOT, json={"slow_mode_seconds": 5}, headers={"If-Match": current.headers["etag"]}
    )
    assert changed.status_code == 200
    entry = _ok(api.get(ROOT + "/history"))["items"][0]
    request = {"history_id": entry["id"], "password": "owned-test-password"}
    if operation == "restoration":
        proof = _ok(
            api.post(
                ROOT + "/restoration-preview",
                json=request,
                headers={"If-Match": changed.headers["etag"]},
            )
        )
        request["preview_digest"] = proof["preview_digest"]

    def unavailable(*_args):
        failure = (
            LifecyclePasswordRateLimited if status == 429 else LifecyclePasswordServiceUnavailable
        )
        raise failure("Owned provider refusal")

    with monkeypatch.context() as patch:
        patch.setattr(ProviderPasswordGrantClient, "verify_password", unavailable)
        response = api.post(
            ROOT + "/" + operation, json=request, headers={"If-Match": changed.headers["etag"]}
        )
    assert response.status_code == status
    assert response.json()["detail"]["code"] == (
        "comms_rate_limited" if status == 429 else "comms_unavailable"
    )
    if status == 429:
        assert int(response.headers["retry-after"]) >= 1
    assert _ok(api.get(ROOT))["effective"]["slow_mode_seconds"] == 5
