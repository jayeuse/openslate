"""S21 recipient decisions and captured-source privacy through real HTTP and PostgreSQL."""

from datetime import timedelta
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import Depends
from sqlalchemy import select

from app.common.dependencies.auth import get_account_user, get_current_membership, get_current_user
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.realtime.models import CommsPresence
from app.systems.platform.scheduling.models import InAppNotification
from tests.comms.conftest import NOW
from tests.comms.routes.message_support import _ok, _payload, send

pytestmark = pytest.mark.integration


def inbox_client(case, actor, org):
    api = case.client(actor, org)

    def current(
        user: Annotated[User, Depends(get_account_user)],
        membership: Annotated[Membership, Depends(get_current_membership)],
    ):
        return user

    # Supplied principal only; the real membership dependency binds every inbox request.
    api.app.dependency_overrides[get_current_user] = current
    return api


def notices(api):
    response = api.get("/api/notifications")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    body = response.json()
    assert body["pagination"]["total"] == len(body["items"])
    assert _ok(api.get("/api/notifications/unread-count"))["unread_count"] == sum(
        row["status"] == "unread" for row in body["items"]
    )
    return body["items"]


@pytest.mark.parametrize(
    ("scenario", "kind"),
    [
        ("mention", "comms-mention"), ("direct", "comms-direct"),
        ("thread", "comms-thread-reply"), ("keyword", "comms-keyword"),
        ("overlap", "comms-mention"), ("thread-keyword", "comms-thread-reply"),
        ("plain", None), ("notify-mute", None), ("conversation-mute", None),
        ("category-mute", None), ("timed-mute", None),
        ("expired-mute", "comms-mention"), ("shared-none", None),
        ("personal-none", None), ("cannot-widen", None),
        ("notify-mentions", None), ("shared-mentions", None),
        ("keyword-mentions", "comms-keyword"), ("personal-keyword", "comms-keyword"),
        ("shared-follow-off", None), ("personal-follow-off", None),
        ("shared-quiet", "comms-mention"), ("personal-quiet", "comms-mention"),
    ],
)
def test_notification_kinds_overlap_and_narrowing_policy(
    message_routes, budget_clock, scenario, kind,
):
    case, org = message_routes, message_routes.world.first
    author, peer = inbox_client(case, org.author, org.id), inbox_client(case, org.peer, org.id)
    conversation = org.conversation
    if scenario in {"direct", "overlap"}:
        conversation = UUID(_ok(author.post(
            "/api/comms/directs", json={"recipient_id": str(org.peer)},
        ), 201)["id"])
    path = f"/api/comms/conversations/{conversation}"
    settings = {"keywords": ["  NeEdLe  "]}
    if scenario == "shared-none" or scenario == "cannot-widen":
        settings["notification_mode"] = "none"
    if scenario in {"shared-mentions", "keyword-mentions"}:
        settings["notification_mode"] = "mentions"
    if scenario == "shared-follow-off":
        settings["notify_followed_threads"] = False
    if scenario == "shared-quiet":
        settings.update(quiet_hours_start="00:00", quiet_hours_end="23:59")
    case.settings(settings)
    personal = {}
    if scenario in {"personal-none", "cannot-widen"}:
        personal["notification_mode"] = "none" if scenario == "personal-none" else "all"
    if scenario == "personal-follow-off":
        personal["notify_followed_threads"] = False
    if scenario == "personal-keyword":
        personal["keywords"] = ["personal"]
    if scenario == "personal-quiet":
        personal.update(quiet_hours_start="23:00", quiet_hours_end="22:00")
    if personal:
        current = _ok(peer.get("/api/comms/preferences"))
        current["notifications"] = personal
        assert peer.put("/api/comms/preferences", json=current).status_code == 200
    if scenario in {"notify-mute", "notify-mentions"}:
        assert peer.patch(path + "/preferences", json={
            "notify": "mute" if scenario == "notify-mute" else "mentions",
        }).status_code == 200
    if scenario in {"conversation-mute", "timed-mute", "expired-mute"}:
        mute = {"kind": "indefinite"} if scenario == "conversation-mute" else {
            "kind": "until", "until": (NOW + timedelta(
                seconds=-1 if scenario == "expired-mute" else 1,
            )).isoformat(),
        }
        assert peer.patch(path + "/preferences", json={"mute": mute}).status_code == 200
    if scenario == "category-mute":
        assert peer.put(f"/api/comms/categories/{org.category}/preferences", json={
            "collapsed": False, "mute": {"kind": "indefinite"},
        }).status_code == 200
    thread = scenario in {"thread", "thread-keyword", "shared-follow-off", "personal-follow-off"}
    if thread:
        root = send(author, path + "/messages", "Thread root")
        thread_path = path + f"/threads/{root['id']}"
        assert peer.post(thread_path).status_code == 201
        assert peer.put(thread_path + "/follow", json={"followed": True}).status_code == 200
    mentioned = scenario not in {
        "plain", "direct", "thread", "thread-keyword", "keyword", "personal-keyword",
        "notify-mentions", "shared-mentions", "keyword-mentions", "shared-follow-off",
        "personal-follow-off",
    }
    body = "A NEEDLE in hay" if scenario in {
        "keyword", "thread-keyword", "overlap", "keyword-mentions", "notify-mentions",
    } else "A PERSONAL match" if scenario == "personal-keyword" else "Private body"
    events = []
    author.app.state.comms_publisher.submit = lambda rows: events.extend(rows)
    message = send(author, thread_path + "/replies" if thread else path + "/messages", body,
                   mention_user_ids=[str(org.peer)] if mentioned else [])
    rows = notices(peer)
    assert [row["kind"] for row in rows] == ([kind] if kind else [])
    assert notices(author) == []
    publication = [row for row in events if row["event"] == "notification"]
    if kind:
        row = rows[0]
        assert set(row) == {
            "id", "kind", "subject_type", "subject_id", "conversation_id", "message_id",
            "org_id", "status", "scheduled_for", "created_at", "read_at",
        }
        assert row["subject_type"] == "comms_message"
        assert row["subject_id"] == row["message_id"] == message["id"]
        assert row["org_id"] == str(org.id) and row["conversation_id"] == str(conversation)
        assert row["scheduled_for"] is None and row["read_at"] is None
        assert publication == [{"topic": f"org:{org.id}:user:{org.peer}", "private": True,
                                "event": "notification", "payload": {"id": row["id"]}}]
    else:
        assert publication == []


@pytest.mark.parametrize("state,age,member,expected", [
    ("online", 119, True, True), ("online", 120, True, False),
    ("away", 0, True, False), ("offline", 0, True, False),
    ("online", 0, False, False),
])
def test_here_only_reaches_fresh_online_current_members(
    message_routes, budget_clock, state, age, member, expected,
):
    case, org = message_routes, message_routes.world.first
    with case.world.session(org) as db:
        db.add(CommsPresence(org_id=org.id, user_id=org.peer, state=state,
                             last_seen_at=NOW - timedelta(seconds=age)))
        if not member:
            row = db.scalars(select(CommsMember).where(
                CommsMember.conversation_id == org.conversation, CommsMember.user_id == org.peer,
            )).one()
            row.is_deleted, row.deleted_at = True, NOW
        db.commit()
    try:
        author = inbox_client(case, org.author, org.id)
        send(author, f"/api/comms/conversations/{org.conversation}/messages", mentions_here=True)
        assert [row["kind"] for row in notices(inbox_client(case, org.peer, org.id))] == (
            ["comms-mention"] if expected else []
        )
    finally:
        with case.world.session(org) as db:
            for row in db.scalars(select(CommsPresence).where(CommsPresence.org_id == org.id)):
                db.delete(row)
            db.commit()


@pytest.mark.parametrize("loss", ["message", "conversation", "access", "reparent", "membership"])
def test_notifications_recheck_current_source_before_count_page_and_read(message_routes, loss):
    case, org = message_routes, message_routes.world.first
    author, peer = inbox_client(case, org.author, org.id), inbox_client(case, org.peer, org.id)
    path = f"/api/comms/conversations/{org.conversation}"
    source = send(author, path + "/messages", mention_user_ids=[str(org.peer)])
    rows = notices(peer)
    assert len(rows) == 1
    notification = rows[0]["id"]
    with case.world.session(org) as db:
        conversation = db.get(CommsConversation, org.conversation)
        if loss == "message":
            row = db.get(CommsMessage, UUID(source["id"]))
            row.is_deleted, row.deleted_at = True, NOW
        elif loss == "conversation":
            conversation.is_deleted, conversation.deleted_at = True, NOW
        elif loss == "access":
            conversation.scope = "members"
            row = db.scalars(select(CommsMember).where(
                CommsMember.conversation_id == org.conversation, CommsMember.user_id == org.peer,
            )).one()
            row.is_deleted, row.deleted_at = True, NOW
        elif loss == "reparent":
            db.get(CommsMessage, UUID(source["id"])).conversation_id = org.other_conversation
        else:
            row = db.scalars(select(Membership).where(
                Membership.org_id == org.id, Membership.user_id == org.peer,
            )).one()
            row.status = "disabled"
        db.commit()
    if loss == "membership":
        for endpoint in ("/api/notifications", "/api/notifications/unread-count"):
            assert peer.get(endpoint).status_code == 403
        assert peer.post("/api/notifications/read-all").status_code == 403
        assert peer.post(f"/api/notifications/{notification}/read").status_code == 403
    else:
        assert notices(peer) == []
        assert peer.post(f"/api/notifications/{notification}/read").status_code == 404
        assert _ok(peer.post("/api/notifications/read-all")) == {"updated_count": 0}
    with case.world.session(org) as db:
        assert db.get(InAppNotification, UUID(notification)).read_at is None


def test_notification_organization_and_private_admin_boundaries(message_routes):
    case, first, second = message_routes, message_routes.world.first, message_routes.world.second
    case.add_visited_guest()
    sender = inbox_client(case, second.author, second.id)
    visitor = inbox_client(case, first.author, second.id)
    own_org = inbox_client(case, first.author, first.id)
    path = f"/api/comms/conversations/{second.conversation}/messages"
    source = send(sender, path, mention_user_ids=[str(first.author)])
    rows = notices(visitor)
    assert len(rows) == 1 and rows[0]["org_id"] == str(second.id)
    identity = rows[0]["id"]
    assert notices(own_org) == []
    assert own_org.post(f"/api/notifications/{identity}/read").status_code == 404
    assert visitor.post(path, json=_payload()).status_code == 403  # Guest remains read-only.
    marked = _ok(visitor.post(f"/api/notifications/{identity}/read"))
    assert marked["message_id"] == source["id"] and marked["status"] == "read"
    assert _ok(visitor.post(f"/api/notifications/{identity}/read"))["read_at"] == marked["read_at"]
    # An admin is not entitled to a private conversation merely by receiving a stale reference.
    with case.world.session(first) as db:
        conversation = db.get(CommsConversation, first.conversation)
        conversation.scope = "members"
        db.commit()
    first_peer = inbox_client(case, first.peer, first.id)
    send(first_peer, f"/api/comms/conversations/{first.conversation}/messages",
         mention_user_ids=[str(first.author)])
    assert len(notices(own_org)) == 1
    with case.world.session(first) as db:
        member = db.scalars(select(CommsMember).where(
            CommsMember.conversation_id == first.conversation, CommsMember.user_id == first.author,
        )).one()
        member.is_deleted, member.deleted_at = True, NOW
        db.commit()
    assert notices(own_org) == []
    assert own_org.get(f"/api/comms/conversations/{first.conversation}").status_code == 404
