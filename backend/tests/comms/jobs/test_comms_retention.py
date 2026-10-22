"""Protected policy updates and irreversible, reference-preserving expiration."""

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.systems.access.users.models import Membership
from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision
from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.message_support import _edit, _ok, _payload

pytestmark = pytest.mark.integration
ROOT = "/api/comms/retention"
NOW = datetime(2026, 10, 21, 12, tzinfo=UTC)


def policy(api, scope, message_days, file_days):
    params = {"scope_kind": scope["kind"]}
    if scope["kind"] == "channel":
        params["channel_id"] = scope["id"]
    current = api.get(ROOT, params=params)
    assert current.status_code == 200
    request = {
        "scope": scope,
        "message_days": message_days,
        "file_days": file_days,
        "password": "owned-test-password",
    }
    preview = _ok(
        api.post(ROOT + "/preview", json=request, headers={"If-Match": current.headers["etag"]})
    )
    result = api.put(
        ROOT,
        json={**request, "preview_digest": preview["preview_digest"]},
        headers={"If-Match": current.headers["etag"]},
    )
    return _ok(result), preview


def test_retention_separate_scopes_inherit_and_require_bound_fresh_proofs(job_routes):
    case, org = job_routes, job_routes.world.first
    admin, member = case.client(org.author, org.id), case.client(org.peer, org.id)
    current = admin.get(ROOT, params={"scope_kind": "workspace"})
    assert _ok(current)["effective"] == {"message_days": 0, "file_days": 0}
    for params in (
        {"scope_kind": "workspace", "channel_id": str(org.conversation)},
        {"scope_kind": "channel"},
        {"scope_kind": "category"},
        {"scope_kind": "workspace", "unknown": "value"},
    ):
        assert admin.get(ROOT, params=params).status_code == 422
    assert member.get(ROOT, params={"scope_kind": "workspace"}).status_code == 403
    proposed = {
        "scope": {"kind": "workspace"},
        "message_days": 30,
        "file_days": 0,
        "password": "owned-test-password",
    }
    assert admin.post(ROOT + "/preview", json=proposed).status_code == 428
    assert (
        admin.post(
            ROOT + "/preview",
            json={**proposed, "password": "wrong"},
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 403
    )
    workspace, _ = policy(admin, {"kind": "workspace"}, 30, 0)
    assert workspace["effective"]["message_days"] == 30
    channel = {"kind": "channel", "id": str(org.conversation)}
    local, _ = policy(admin, channel, 7, 0)
    assert local["effective"] == {"message_days": 7, "file_days": 0}
    reset, _ = policy(admin, channel, None, 0)
    assert (
        reset["effective"]["message_days"] == 30 and reset["sources"]["message_days"] == "workspace"
    )
    policy(admin, {"kind": "workspace"}, 60, 0)
    inherited = _ok(
        admin.get(ROOT, params={"scope_kind": "channel", "channel_id": str(org.conversation)})
    )
    assert inherited["effective"]["message_days"] == 60
    assert inherited["sources"] == {"message_days": "workspace", "file_days": "channel"}
    # Ordinary settings cannot bypass the protected retention resource.
    ordinary = admin.get(f"/api/comms/settings/channel/{org.conversation}")
    assert (
        admin.patch(
            f"/api/comms/settings/channel/{org.conversation}",
            json={"message_days": 0},
            headers={"If-Match": ordinary.headers["etag"]},
        ).status_code
        == 422
    )


def test_retention_erases_root_content_preserves_younger_links_then_collects_anchor(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    path = f"/api/comms/conversations/{org.conversation}/messages"
    request = _payload("Expired original canary")
    root = _ok(api.post(path, json=request), 201)
    assert (
        api.patch(path + "/" + root["id"], json=_edit("Expired current canary")).status_code == 200
    )
    reply = _ok(
        api.post(
            f"/api/comms/conversations/{org.conversation}/threads/{root['id']}/replies",
            json=_payload("Younger reply"),
        ),
        201,
    )
    quote = _ok(api.post(path, json={**_payload("Younger quote"), "reply_to_id": root["id"]}), 201)
    with case.world.session(org) as db:
        db.get(CommsMessage, UUID(root["id"])).created_at = NOW - timedelta(days=31)
        for value in (reply, quote):
            db.get(CommsMessage, UUID(value["id"])).created_at = NOW - timedelta(days=1)
        db.commit()
    policy(api, {"kind": "workspace"}, 30, 0)
    from app.systems.comms.jobs.retention_worker import run_retention_batch

    for _ in range(10):
        if run_retention_batch(case.world.runtime, org.id, now=NOW, publish=lambda _rows: None)[
            "complete"
        ]:
            break
    with case.world.session(org) as db:
        anchor = db.get(CommsMessage, UUID(root["id"]))
        assert anchor is not None and anchor.body == "" and anchor.is_deleted
        assert anchor.retention_erased_at is not None
        assert db.get(CommsMessage, UUID(reply["id"])).parent_id == anchor.id
        assert db.get(CommsMessage, UUID(quote["id"])).reply_to_id == anchor.id
        assert not list(
            db.scalars(
                select(CommsMessageRevision).where(CommsMessageRevision.message_id == anchor.id)
            )
        )
        audit = json.dumps([(r.before, r.after) for r in db.scalars(select(AuditLog))], default=str)
        assert "Expired original canary" not in audit and "Expired current canary" not in audit
        # The migration protects erasure even from an accidental future ORM restoration path.
        with db.begin_nested():
            anchor.retention_erased_at = None
            with pytest.raises(IntegrityError):
                db.flush()
        with db.begin_nested():
            anchor.body = "Restoration must not be possible"
            with pytest.raises(IntegrityError):
                db.flush()
        with db.begin_nested():
            db.add(
                CommsMessageRevision(
                    org_id=org.id,
                    message_id=anchor.id,
                    author_id=org.author,
                    body="Forbidden revision",
                )
            )
            with pytest.raises(IntegrityError):
                db.flush()
    tombstone = api.get(path + "/" + root["id"])
    assert _ok(tombstone)["state"] == "deleted" and "body" not in tombstone.json()
    assert (
        api.post(
            path + "/" + root["id"] + "/restoration",
            headers={"If-Match": tombstone.headers["etag"]},
        ).status_code
        == 404
    )
    assert api.post(path, json=request).status_code == 409
    assert api.post(path, json={**request, "body": "Guessing erased content"}).status_code == 409
    for _ in range(10):
        if run_retention_batch(
            case.world.runtime, org.id, now=NOW + timedelta(days=40), publish=lambda _rows: None
        )["complete"]:
            break
    with case.world.session(org) as db:
        assert db.get(CommsMessage, UUID(root["id"])) is None
        assert db.get(CommsMessage, UUID(reply["id"])) is None
        assert db.get(CommsMessage, UUID(quote["id"])) is None
    # Garbage collection must not resurrect an expired message through an old send key.
    assert api.post(path, json=request).status_code == 409


def test_preview_is_bound_to_actor_org_proposal_version_and_single_consumption(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    with case.world.session(org) as db:
        db.scalars(select(Membership).where(Membership.user_id == org.peer)).one().role = "admin"
        db.commit()
    peer = case.client(org.peer, org.id)
    current = api.get(ROOT, params={"scope_kind": "workspace"})
    proposal = {
        "scope": {"kind": "workspace"},
        "message_days": 30,
        "file_days": 0,
        "password": "owned-test-password",
    }
    preview = _ok(
        api.post(ROOT + "/preview", json=proposal, headers={"If-Match": current.headers["etag"]})
    )
    request = {**proposal, "preview_digest": preview["preview_digest"]}
    headers = {"If-Match": current.headers["etag"]}
    assert peer.put(ROOT, json=request, headers=headers).status_code == 403
    assert api.put(ROOT, json={**request, "message_days": 31}, headers=headers).status_code == 409
    assert (
        api.put(
            ROOT,
            json={**request, "scope": {"kind": "channel", "id": str(org.conversation)}},
            headers=headers,
        ).status_code
        == 412
    )
    assert _ok(api.put(ROOT, json=request, headers=headers))["effective"]["message_days"] == 30
    assert api.put(ROOT, json=request, headers=headers).status_code == 412
    channel = {"kind": "channel", "id": str(org.conversation)}
    current = api.get(ROOT, params={"scope_kind": "channel", "channel_id": str(org.conversation)})
    proposal = {**proposal, "scope": channel, "message_days": None}
    preview = _ok(
        api.post(ROOT + "/preview", json=proposal, headers={"If-Match": current.headers["etag"]})
    )
    policy(api, {"kind": "workspace"}, 60, 0)
    assert (
        api.put(
            ROOT,
            json={**proposal, "preview_digest": preview["preview_digest"]},
            headers={"If-Match": current.headers["etag"]},
        ).status_code
        == 412
    )
    assert (
        _ok(api.get(ROOT, params={"scope_kind": "channel", "channel_id": str(org.conversation)}))[
            "effective"
        ]["message_days"]
        == 60
    )
