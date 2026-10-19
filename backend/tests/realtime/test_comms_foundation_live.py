"""Guarded S20A actual FastAPI → private Envoy → Realtime socket proofs, not the S02 prototype."""

import json
import socket
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Event, Thread
from typing import Annotated, Literal

import httpx
import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from pydantic import BaseModel, SecretStr
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.config import get_settings
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession, get_db, get_engine
from app.main import create_app
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsConversation, CommsMember
from app.systems.comms.messages.models import CommsConversationCounter, CommsMessage
from app.systems.comms.realtime.models import CommsRealtimeGrant
from app.systems.comms.realtime.publication import stage_comms_event
from app.systems.platform.realtime.tokens import mint_realtime_token
from tests.realtime.test_realtime_channel_acceptance import (
    _assert_refused,
    _channel_token,
    _join,
    _read_until,
    _sign_in,
    _socket,
)
from tests.realtime.test_realtime_channel_acceptance import (
    organizations as organizations,
)

pytestmark = pytest.mark.integration


class PublicationCommand(BaseModel):
    mode: Literal["commit", "rollback", "savepoint"] = "commit"
    event: Literal["message", "presence"] = "message"
    seq: int = 1


@pytest.fixture
def live_case(organizations):
    org, conversation = organizations.org_a, uuid7()
    engine = get_engine()
    with AuditSession(engine) as db:
        scope_session(db, org)
        db.add(
            CommsConversation(
                id=conversation,
                org_id=org,
                kind="channel",
                scope="members",
                name="S20A owned",
                created_by=organizations.member.user_id,
            )
        )
        db.flush()
        db.add(CommsConversationCounter(org_id=org, conversation_id=conversation, last_seq=0))
        for user in (organizations.member.user_id, organizations.outsider.user_id):
            db.add(CommsMember(org_id=org, conversation_id=conversation, user_id=user))
        db.add(
            Membership(
                org_id=org,
                user_id=organizations.outsider.user_id,
                role="guest",
                status="active",
                sponsor_user_id=organizations.member.user_id,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
            )
        )
        db.commit()
    application = create_app()
    response_sent = []
    submitted = []
    original_submit = application.state.comms_publisher.submit

    def submit(events):
        # Observe only safe facts outside HTTP, not secret headers or raw responses.
        submitted.append(
            {
                "response_sent": bool(response_sent),
                "pool_checked_out": engine.pool.checkedout(),
                "events": events,
            }
        )
        original_submit(events)

    application.state.comms_publisher.submit = submit

    class ObserveResponse:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            async def observe(message):
                await send(message)
                if message["type"] == "http.response.body" and not message.get("more_body", False):
                    response_sent.append(True)

            await self.app(scope, receive, observe)

    application.add_middleware(ObserveResponse)

    @application.post("/api/test/s20a-publication")
    def publish(
        command: PublicationCommand,
        actor: Annotated[User, Depends(get_current_user)],
        db: Annotated[Session, Depends(get_db)],
    ):
        assert actor.id == organizations.member.user_id
        response_sent.clear()
        envelope = {
            "topic": f"org:{org}:conversation:{conversation}",
            "private": True,
            "event": "message",
            "payload": {
                "conversation_id": str(conversation),
                "seq": command.seq,
                "kind": "created",
            },
        }
        if command.event == "presence":
            envelope = {
                "topic": f"org:{org}:presence",
                "private": True,
                "event": "presence",
                "payload": {"user_id": str(actor.id), "state": "online"},
            }
        else:
            counter = db.scalar(
                select(CommsConversationCounter).where(
                    CommsConversationCounter.conversation_id == conversation
                )
            )
            counter.last_seq = max(counter.last_seq, command.seq)
            db.add(
                CommsMessage(
                    org_id=org,
                    conversation_id=conversation,
                    author_id=actor.id,
                    client_key=uuid7(),
                    seq=command.seq,
                    body="Never published",
                    send_fingerprint="a" * 64,
                )
            )
        stage_comms_event(db, org_id=org, actor_id=actor.id, envelope=envelope)
        if command.mode == "savepoint":
            nested = db.begin_nested()
            stage_comms_event(
                db,
                org_id=org,
                actor_id=actor.id,
                envelope={**envelope, "payload": {**envelope["payload"], "seq": 999}},
            )
            nested.rollback()
        if command.mode == "rollback":
            db.rollback()
        else:
            db.commit()
        return {"committed": command.mode != "rollback"}

    try:
        with TestClient(application, base_url=get_settings().public_origin) as client:
            member = {**_sign_in(client, organizations.member), "X-Org": str(org)}
            guest = {**_sign_in(client, organizations.outsider), "X-Org": str(org)}
            yield client, member, guest, org, conversation, submitted
    finally:
        # Application lifespan disposes process pools, not the run-owned data.
        with AuditSession(get_engine()) as db:
            scope_session(db, org)
            for model in (
                CommsRealtimeGrant,
                CommsMessage,
                CommsMember,
                CommsConversationCounter,
                CommsConversation,
            ):
                for row in db.scalars(select(model).where(model.org_id == org)):
                    db.delete(row)
                db.flush()
            db.commit()


def test_committed_events_use_the_private_listener_after_response_and_rollback_delivers_nothing(
    live_case,
):
    client, member, _guest, org, conversation, submitted = live_case
    settings = get_settings()
    issued = _channel_token(client, member, org)
    assert issued.status_code == 200
    token = issued.json()["access_token"]
    topic = f"org:{org}:conversation:{conversation}"
    assert issued.json()["conversation_topics"] == [topic]
    with _socket(settings) as ws:
        assert _join(ws, topic, token)["status"] == "ok"
        for seq, mode in ((1, "commit"), (2, "rollback"), (3, "savepoint")):
            response = client.post(
                "/api/test/s20a-publication", headers=member, json={"seq": seq, "mode": mode}
            )
            assert response.status_code == 200
        received = []
        sentinel = _read_until(
            ws,
            lambda message: (
                received.append(message)
                or message.get("payload", {}).get("payload", {}).get("seq") == 3
            ),
        )
        assert sentinel is not None
        events = [message["payload"] for message in received if message.get("event") == "broadcast"]
        assert [row["payload"]["seq"] for row in events] == [1, 3]
        assert all(set(row["payload"]) == {"conversation_id", "seq", "kind"} for row in events)
        assert all(row["event"] == "message" for row in events)
    proof = [row for row in submitted if row["events"]]
    assert len(proof) == 2 and all(
        row["response_sent"] and row["pool_checked_out"] == 0 for row in proof
    )
    with httpx.Client(timeout=2, trust_env=False) as transport:
        for headers in ({}, {"apikey": settings.supabase_publishable_key.get_secret_value()}):
            assert (
                transport.post(
                    settings.realtime_publish_url, headers=headers, json={"messages": []}
                ).status_code
                == 401
            )
        assert (
            transport.post(
                settings.supabase_url + "/realtime/v1/api/broadcast",
                headers={"apikey": settings.supabase_secret_key.get_secret_value()},
                json={"messages": []},
            ).status_code
            == 404
        )


def test_guest_cannot_forge_presence_or_conversation_broadcast_and_revoked_grant_cannot_rejoin(
    live_case,
    organizations,
):
    client, member, guest, org, conversation, _submitted = live_case
    settings = get_settings()
    token_response = _channel_token(client, guest, org)
    assert token_response.status_code == 200
    token = token_response.json()["access_token"]
    for topic, event in (
        (f"org:{org}:presence", "presence"),
        (f"org:{org}:conversation:{conversation}", "message"),
    ):
        with _socket(settings) as ws:
            assert _join(ws, topic, token)["status"] == "ok"
            marker = str(uuid7())
            ws.send(
                json.dumps(
                    {
                        "topic": "realtime:" + topic,
                        "event": "broadcast",
                        "ref": "forged",
                        "join_ref": "1",
                        "payload": {
                            "type": "broadcast",
                            "event": event,
                            "payload": {"forgery": marker},
                        },
                    }
                )
            )
            seen = []
            _read_until(
                ws,
                lambda message, seen=seen: (
                    seen.append(message)
                    or (message.get("event") == "phx_reply" and message.get("ref") == "forged")
                ),
            )
            response = client.post(
                "/api/test/s20a-publication", headers=member, json={"event": event, "seq": 10}
            )
            assert response.status_code == 200
            assert (
                _read_until(
                    ws,
                    lambda message, seen=seen, event=event: (
                        seen.append(message)
                        or (
                            message.get("event") == "broadcast"
                            and message.get("payload", {}).get("event") == event
                            and "forgery" not in message.get("payload", {}).get("payload", {})
                        )
                    ),
                )
                is not None
            )
            assert all(marker not in json.dumps(message) for message in seen)
    topic = f"org:{org}:conversation:{conversation}"
    with _socket(settings) as existing:
        assert _join(existing, topic, token)["status"] == "ok"
        path = f"/api/comms/conversations/{conversation}"
        current = client.get(path, headers=member)
        assert current.status_code == 200
        removed = client.delete(
            path + f"/members/{organizations.outsider.user_id}",
            headers={**member, "If-Match": current.headers["etag"]},
        )
        assert removed.status_code == 204
        assert client.get(path, headers=guest).status_code == 404
        with AuditSession(get_engine()) as db:
            scope_session(db, org)
            assert (
                db.scalar(
                    select(CommsRealtimeGrant.id).where(
                        CommsRealtimeGrant.user_id == organizations.outsider.user_id,
                        CommsRealtimeGrant.conversation_id == conversation,
                    )
                )
                is None
            )
        # D34 explicitly permits cached IDs-only delivery until token expiry, never body access.
        assert (
            client.post("/api/test/s20a-publication", headers=member, json={"seq": 11}).status_code
            == 200
        )
        assert (
            _read_until(
                existing,
                lambda message: message.get("payload", {}).get("payload", {}).get("seq") == 11,
            )
            is not None
        )
    _assert_refused(
        settings,
        f"org:{org}:conversation:{conversation}",
        token,
        "You do not have permissions to read from this Channel topic",
    )


def test_joined_socket_observes_token_expiry_and_rejoin_is_denied(live_case, organizations):
    client, member, _guest, org, conversation, _submitted = live_case
    settings = get_settings()
    assert _channel_token(client, member, org).status_code == 200
    # Same production signer and 300-second exp-iat; advance its issue time, not provider policy.
    short = mint_realtime_token(
        settings,
        org_id=org,
        user_id=organizations.member.user_id,
        now=datetime.now(UTC) - timedelta(seconds=296),
    )
    topic = f"org:{org}:conversation:{conversation}"
    with _socket(settings) as ws:
        assert _join(ws, topic, short.token)["status"] == "ok"
        terminal = _read_until(ws, lambda message: message.get("event") in {"system", "phx_error"})
        assert terminal is not None
    _assert_refused(settings, topic, short.token, "Token has expired")


def test_private_http_and_transport_failures_preserve_committed_messages(live_case):
    client, member, _guest, org, conversation, _submitted = live_case
    publisher = client.app.state.comms_publisher
    original_settings, deliver = publisher.settings, publisher.deliver
    completed = Event()

    def observe(transport, batch):
        try:
            deliver(transport, batch)
        finally:
            completed.set()

    publisher.deliver = observe
    safe_headers = []

    class Limited(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            safe_headers.append(
                len(self.headers.get_all("apikey", [])) == 1
                and "Authorization" not in self.headers
                and "Cookie" not in self.headers
            )
            self.send_response(429)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_args):
            pass  # This fixture never logs request headers or private credentials.

    with socket.socket() as unavailable, HTTPServer(("127.0.0.1", 0), Limited) as limited:
        unavailable.bind(("127.0.0.1", 0))  # Owned, reserved but not listening.
        port = unavailable.getsockname()[1]
        quota_port = limited.server_address[1]
        cases = (
            (20, {"supabase_secret_key": SecretStr("synthetic-invalid-server-key")}, "refused"),
            (
                21,
                {"realtime_publish_url": f"http://127.0.0.1:{port}/realtime/v1/api/broadcast"},
                "transport_failed",
            ),
            (
                22,
                {
                    "realtime_publish_url": f"http://127.0.0.1:{quota_port}/realtime/v1/api/broadcast"
                },
                "rate_limited",
            ),
            (23, {}, "accepted"),
        )
        for seq, override, outcome in cases:
            publisher.settings = original_settings.model_copy(update=override)
            completed.clear()
            handler = None
            if outcome == "rate_limited":
                limited.timeout = 5
                handler = Thread(target=limited.handle_request, daemon=True)
                handler.start()
            response = client.post("/api/test/s20a-publication", headers=member, json={"seq": seq})
            assert response.status_code == 200 and response.json() == {"committed": True}
            assert completed.wait(5), "bounded publication did not finish"
            assert publisher.outcomes[outcome] == 1
            if handler:
                handler.join(5)
                assert not handler.is_alive()
    assert safe_headers == [True]
    with AuditSession(get_engine()) as db:
        scope_session(db, org)
        assert list(
            db.scalars(
                select(CommsMessage.seq)
                .where(CommsMessage.conversation_id == conversation)
                .order_by(CommsMessage.seq)
            )
        ) == [20, 21, 22, 23]
