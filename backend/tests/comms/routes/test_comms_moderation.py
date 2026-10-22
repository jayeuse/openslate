"""S22 moderation is conditional and source-scoped; reporting grants no read authority."""

from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.comms.messages.models import CommsMessage
from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.message_support import _ok, _payload, send

pytestmark = pytest.mark.integration


def test_reporting_never_opens_queue_and_resolution_is_conditional(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    source = send(admin, f"/api/comms/conversations/{org.conversation}/messages", "Private source")
    path = f"/api/comms/conversations/{org.conversation}/messages/{source['id']}"
    reported = peer.post(path + "/reports", json={"reason": "Private quoted report canary"})
    assert reported.status_code == 204 and reported.content == b""
    assert peer.get("/api/comms/reports").status_code == 403
    reports = _ok(admin.get("/api/comms/reports"))
    assert reports["pagination"]["total"] == 1
    row = reports["items"][0]
    assert set(row) == {"id", "org_id", "created_at", "updated_at", "conversation_id",
                        "message_id", "reporter_id", "reason", "status"}
    assert row["message_id"] == source["id"] and row["reporter_id"] == str(org.peer)
    target = "/api/comms/reports/" + row["id"]
    assert peer.get(target).status_code == 403
    assert peer.post(target + "/resolution").status_code == 403
    current = admin.get(target)
    assert current.status_code == 200 and current.headers["etag"]
    assert admin.post(target + "/resolution").status_code == 428
    assert admin.post(target + "/resolution", headers={"If-Match": '"stale"'}).status_code == 412
    resolved = admin.post(target + "/resolution", headers={"If-Match": current.headers["etag"]})
    assert _ok(resolved)["status"] == "resolved"
    other = case.client(case.world.second.author, case.world.second.id)
    assert other.get(target).status_code == 404
    with case.world.session(org) as db:
        audit = list(db.scalars(select(AuditLog).where(AuditLog.entity_id == UUID(row["id"]))))
        assert audit
        assert all("Private quoted report canary" not in str((entry.before, entry.after))
                   for entry in audit)


def test_moderator_removal_restoration_preserves_identity_and_hides_retained_content(
    message_routes,
):
    case, org = message_routes, message_routes.world.first
    author, manager = case.client(org.peer, org.id), case.client(org.author, org.id)
    source = send(
        author, f"/api/comms/conversations/{org.conversation}/messages", "Restorable canary",
    )
    path = f"/api/comms/conversations/{org.conversation}/messages/{source['id']}"
    current = manager.get(path)
    assert author.post(
        path + "/removal", headers={"If-Match": current.headers["etag"]},
    ).status_code == 403
    assert manager.post(path + "/removal").status_code == 428
    assert manager.post(path + "/removal", headers={"If-Match": '"stale"'}).status_code == 412
    events = []
    manager.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    removed = manager.post(path + "/removal", headers={"If-Match": current.headers["etag"]})
    tombstone = _ok(removed)
    assert tombstone["state"] == "deleted" and "body" not in tombstone
    assert (tombstone["id"], tombstone["seq"]) == (source["id"], source["seq"])
    page = _ok(manager.get(f"/api/comms/conversations/{org.conversation}/removed-messages"))
    assert [row["id"] for row in page["items"]] == [source["id"]]
    assert "Restorable canary" not in str(page)
    assert author.get(path + "/revisions").status_code == 404
    assert manager.post(
        path + "/restoration", headers={"If-Match": current.headers["etag"]},
    ).status_code == 412
    restored = _ok(manager.post(
        path + "/restoration", headers={"If-Match": removed.headers["etag"]},
    ))
    assert restored["state"] == "live" and restored["body"] == source["body"]
    assert restored["id"] == source["id"] and restored["seq"] == source["seq"]
    assert len(events) == 2 and all("Restorable canary" not in str(row) for row in events)
    removed_page = manager.get(f"/api/comms/conversations/{org.conversation}/removed-messages")
    assert _ok(removed_page)["items"] == []
    with case.world.session(org) as db:
        assert db.get(CommsMessage, UUID(source["id"])).body == source["body"]


def test_report_bound_private_admin_action_does_not_open_ordinary_private_reads(message_routes):
    case, org = message_routes, message_routes.world.first
    private = case.private_conversations()
    conversation, source = private["group"]
    reporter, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    path = f"/api/comms/conversations/{conversation}/messages/{source}"
    assert admin.get(path).status_code == 404
    assert admin.post(path + "/removal", headers={"If-Match": '"not-a-grant"'}).status_code == 404
    assert reporter.post(
        path + "/reports", json={"reason": "Review this message"},
    ).status_code == 204
    reports = _ok(admin.get("/api/comms/reports"))["items"]
    assert len(reports) == 1 and reports[0]["message_id"] == str(source)
    # The queue supplies only its compound validator, never a fabricated message token.
    assert admin.get(path).status_code == 404
    report_path = "/api/comms/reports/" + reports[0]["id"]
    report = admin.get(report_path)
    assert report.status_code == 200
    assert admin.post(report_path + "/message-removal").status_code == 428
    ordinary = reporter.get(path)
    for tag in ('*', 'W/' + report.headers["etag"], ordinary.headers["etag"]):
        assert admin.post(report_path + "/message-removal",
                          headers={"If-Match": tag}).status_code == 412
    events = []
    admin.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    removed = admin.post(report_path + "/message-removal",
                         headers={"If-Match": report.headers["etag"]})
    assert removed.status_code == 200 and removed.json()["status"] == "open"
    assert set(removed.json()) == set(report.json()) and "body" not in removed.text
    assert removed.headers["cache-control"] == "private, no-store"
    assert _ok(reporter.get(path))["state"] == "deleted"
    assert admin.post(report_path + "/message-restoration",
                      headers={"If-Match": report.headers["etag"]}).status_code == 412
    before_events = list(events)
    with case.world.session(org) as db:
        before_audit = set(db.scalars(select(AuditLog.id)))
    no_change = admin.post(report_path + "/message-removal",
                           headers={"If-Match": removed.headers["etag"]})
    assert no_change.status_code == 200 and no_change.headers["etag"] == removed.headers["etag"]
    assert events == before_events
    with case.world.session(org) as db:
        assert set(db.scalars(select(AuditLog.id))) == before_audit
    restored = admin.post(report_path + "/message-restoration",
                          headers={"If-Match": removed.headers["etag"]})
    assert restored.status_code == 200 and restored.headers["etag"] != report.headers["etag"]
    assert "body" not in restored.text and restored.json()["status"] == "open"
    assert _ok(reporter.get(path))["state"] == "live"
    assert admin.get(path).status_code == 404
    resolved = admin.post(report_path + "/resolution",
                          headers={"If-Match": restored.headers["etag"]})
    assert resolved.status_code == 200
    assert admin.post(report_path + "/message-removal",
                      headers={"If-Match": resolved.headers["etag"]}).status_code == 409
    assert admin.get(f"/api/comms/conversations/{conversation}/messages").status_code == 404


def test_compound_report_tokens_do_not_survive_body_reverts_or_cross_report_use(message_routes):
    from tests.comms.routes.message_support import _edit

    case, org = message_routes, message_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    message = send(peer, f"/api/comms/conversations/{org.conversation}/messages", "Original")
    path = f"/api/comms/conversations/{org.conversation}/messages/{message['id']}"
    for _ in range(2):
        assert peer.post(path + "/reports", json={"reason": "Review"}).status_code == 204
    reports = _ok(admin.get("/api/comms/reports"))["items"]
    assert len(reports) == 2
    left, right = ["/api/comms/reports/" + row["id"] for row in reports]
    original = admin.get(left).headers["etag"]
    other = admin.get(right).headers["etag"]
    assert admin.post(left + "/message-removal", headers={"If-Match": other}).status_code == 412
    for body in ("Changed", "Original"):
        assert peer.patch(path, json=_edit(body)).status_code == 200
    assert admin.post(left + "/message-removal", headers={"If-Match": original}).status_code == 412
    current = admin.get(left).headers["etag"]
    removed = admin.post(left + "/message-removal", headers={"If-Match": current})
    assert removed.status_code == 200
    assert admin.post(
        right + "/message-restoration", headers={"If-Match": other},
    ).status_code == 412


def test_posting_restriction_uses_channel_settings_etag_and_revalidates_sends(message_routes):
    case, org = message_routes, message_routes.world.first
    admin, member = case.client(org.author, org.id), case.client(org.peer, org.id)
    path = f"/api/comms/conversations/{org.conversation}"
    settings = admin.get(f"/api/comms/settings/channel/{org.conversation}")
    request = {"user_ids": [str(org.peer)], "until": None}
    assert admin.put(path + "/restrictions", json=request).status_code == 428
    blocked = admin.put(path + "/restrictions", json=request,
                        headers={"If-Match": settings.headers["etag"]})
    assert blocked.status_code == 200
    assert _ok(blocked)["effective"]["restricted_person_ids"] == [str(org.peer)]
    assert member.post(path + "/messages", json=_payload()).status_code == 403
    assert admin.put(path + "/restrictions", json={"user_ids": [], "until": None},
                     headers={"If-Match": blocked.headers["etag"]}).status_code == 200
    assert member.post(path + "/messages", json=_payload()).status_code == 201


def test_group_moderation_grant_is_narrow_and_message_actions_need_both_capabilities(
    structure_routes,
):
    from app.systems.access.policy.models import GroupMember
    from app.systems.comms.settings.models import CommsCapabilityGrant

    case, org = structure_routes, structure_routes.world.first
    admin, moderator = case.client(org.author, org.id), case.client(org.peer, org.id)
    root = f"/api/comms/conversations/{org.conversation}"
    source = send(admin, root + "/messages", "Admin source")
    source_path = root + "/messages/" + source["id"]
    assert moderator.post(source_path + "/reports", json={"reason": "Review"}).status_code == 204
    with case.world.session(org) as db:
        membership = GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer)
        db.add(membership)
        db.add(CommsCapabilityGrant(
            org_id=org.id, scope="channel", conversation_id=org.conversation,
            subject="group", group_id=org.group, capability="moderate", granted=True,
        ))
        db.commit()
        membership_id = membership.id
    reports = _ok(moderator.get("/api/comms/reports"))["items"]
    assert len(reports) == 1
    path = "/api/comms/reports/" + reports[0]["id"]
    current = moderator.get(path)
    assert moderator.post(path + "/message-removal",
                          headers={"If-Match": current.headers["etag"]}).status_code == 403
    settings_path = f"/api/comms/settings/channel/{org.conversation}"
    settings = moderator.get(settings_path)
    assert moderator.patch(settings_path, json={"formatting": False},
                           headers={"If-Match": settings.headers["etag"]}).status_code == 403
    locked = moderator.patch(settings_path, json={"locked": True, "slow_mode_seconds": 5},
                             headers={"If-Match": settings.headers["etag"]})
    assert locked.status_code == 200
    assert _ok(locked)["effective"]["slow_mode_seconds"] == 5
    assert moderator.post(root + "/messages", json=_payload()).status_code == 403
    assert moderator.get(source_path + "/revisions").status_code == 403
    with case.world.session(org) as db:
        db.add(CommsCapabilityGrant(
            org_id=org.id, scope="channel", conversation_id=org.conversation,
            subject="group", group_id=org.group, capability="deleteOthersMessages", granted=True,
        ))
        db.commit()
    removed = moderator.post(path + "/message-removal",
                             headers={"If-Match": current.headers["etag"]})
    assert removed.status_code == 200
    with case.world.session(org) as db:
        membership = db.get(GroupMember, membership_id)
        membership.is_deleted = True
        db.commit()
    assert moderator.get(path).status_code == 403


def test_report_rejects_non_postgres_text_before_any_row_is_created(message_routes):
    case, org = message_routes, message_routes.world.first
    admin = case.client(org.author, org.id)
    message = send(admin, f"/api/comms/conversations/{org.conversation}/messages")
    path = f"/api/comms/conversations/{org.conversation}/messages/{message['id']}/reports"
    assert admin.post(path, json={"reason": "invalid\u0000text"}).status_code == 422
    assert _ok(admin.get("/api/comms/reports"))["items"] == []
