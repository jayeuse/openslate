"""Explicit narrow native API/Envoy/Caddy/Realtime acceptance, never a mocked publish call."""

import json
import time
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.comms.realtime.models import CommsPresence, CommsRealtimeGrant
from tests.realtime.native_support import authenticate
from tests.realtime.native_support import native_room as native_room
from tests.realtime.test_realtime_channel_acceptance import _join, _read_until, _socket

pytestmark = pytest.mark.integration


def token(room, index):
    response = room.client.post("/api/realtime/token", headers=room.headers[index])
    assert response.status_code == 200
    return response.json()["access_token"]


def test_message_and_typing_only_reach_current_grant_holders_with_healthy_negative_sentinels(
    native_room,
):
    room, settings = native_room, get_settings()
    tokens = {index: token(room, index) for index in (1, 2, 3, 6)}
    with Session(room.owner) as db:
        for row in db.scalars(
            select(CommsRealtimeGrant).where(
                CommsRealtimeGrant.org_id == room.org,
                CommsRealtimeGrant.user_id == room.people[2].id,
            )
        ):
            db.delete(row)
        db.commit()
    topic = f"org:{room.org}:conversation:{room.conversation}"
    with ExitStack() as stack:
        reader = stack.enter_context(_socket(settings))
        assert _join(reader, topic, tokens[1])["status"] == "ok"
        negatives = []
        for index in (2, 3, 6):
            ws = stack.enter_context(_socket(settings))
            own_presence = f"org:{room.people[index].org}:presence"
            assert _join(ws, own_presence, tokens[index])["status"] == "ok"
            assert _join(ws, topic, tokens[index])["status"] == "error"
            negatives.append((index, ws))
        path = f"/api/comms/conversations/{room.conversation}"
        payload = {"client_key": str(uuid4()), "body": "Actual API private content"}
        created = room.client.post(path + "/messages", headers=room.headers[0], json=payload)
        assert created.status_code == 201
        message = _read_until(
            reader,
            lambda row: (
                row.get("event") == "broadcast" and row.get("payload", {}).get("event") == "message"
            ),
        )
        assert message["payload"]["payload"] == {
            "conversation_id": str(room.conversation),
            "seq": 1,
            "kind": "created",
        }
        assert room.client.post(path + "/typing", headers=room.headers[0]).status_code == 204
        typed = _read_until(
            reader,
            lambda row: (
                row.get("event") == "broadcast" and row.get("payload", {}).get("event") == "typing"
            ),
        )
        assert typed["payload"]["payload"] == {
            "conversation_id": str(room.conversation),
            "user_id": str(room.people[0].id),
        }
        assert (
            room.client.post(path + "/messages", headers=room.headers[0], json=payload).status_code
            == 200
        )
        for index in (0, 6):
            heartbeat = room.client.post(
                "/api/comms/presence", headers=room.headers[index], json={"state": "online"}
            )
            assert heartbeat.status_code == 200
        for index, ws in negatives:
            seen = []
            sentinel_user = str(room.people[6 if index == 6 else 0].id)
            sentinel = _read_until(
                ws,
                lambda row, seen=seen, sentinel_user=sentinel_user: (
                    seen.append(row)
                    or (
                        row.get("event") == "broadcast"
                        and row.get("payload", {}).get("event") == "presence"
                        and row.get("payload", {}).get("payload", {}).get("user_id")
                        == sentinel_user
                    )
                ),
            )
            assert sentinel is not None
            assert all(
                row.get("payload", {}).get("event") not in {"message", "typing"} for row in seen
            )
        assert "Actual API private content" not in json.dumps([message, typed])


def test_fifty_real_sends_recover_in_order_through_authorized_gap_fill_and_heartbeat(native_room):
    room, settings = native_room, get_settings()
    reader_token = token(room, 1)
    topic = f"org:{room.org}:conversation:{room.conversation}"
    path = f"/api/comms/conversations/{room.conversation}/messages"
    with _socket(settings) as ws:
        assert _join(ws, topic, reader_token)["status"] == "ok"
        accepted = []
        for index in range(50):
            response = room.client.post(
                path,
                headers=room.headers[(0, 4, 5)[index % 3]],
                json={"client_key": str(uuid4()), "body": f"Owned burst {index}"},
            )
            assert response.status_code == 201
            accepted.append(response.json()["id"])
        assert (
            _read_until(ws, lambda row: row.get("payload", {}).get("payload", {}).get("seq") == 50)
            is not None
        )
        # Ignore notification arrival order. Recovery always uses the committed ordered API.
        recovered, after = [], 0
        while after < 50:
            page = room.client.get(
                path, headers=room.headers[1], params={"after_seq": after, "limit": 17}
            )
            assert page.status_code == 200
            value = page.json()
            assert value["items"]
            recovered.extend(value["items"])
            after = value["items"][-1]["seq"]
        assert [row["seq"] for row in recovered] == list(range(1, 51))
        assert {row["id"] for row in recovered} == set(accepted)
    # A disconnected listener misses the final publish; the next heartbeat is stateless repair.
    final = room.client.post(
        path,
        headers=room.headers[4],
        json={"client_key": str(uuid4()), "body": "Last missing publish"},
    )
    assert final.status_code == 201
    heartbeat = room.client.post(
        "/api/comms/presence",
        headers=room.headers[1],
        json={
            "state": "online",
            "known_sequences": [{"conversation_id": str(room.conversation), "high_water_seq": 50}],
        },
    )
    assert heartbeat.status_code == 200
    assert heartbeat.json()["changed"] == [
        {"conversation_id": str(room.conversation), "high_water_seq": 51}
    ]
    assert heartbeat.json()["truncated"] is False
    repaired = room.client.get(path, headers=room.headers[1], params={"after_seq": 50})
    assert repaired.status_code == 200 and [row["id"] for row in repaired.json()["items"]] == [
        final.json()["id"]
    ]


def test_real_background_sweeper_delivers_offline_for_an_expired_owned_heartbeat(native_room):
    room, settings = native_room, get_settings()
    channel_token = token(room, 1)
    with _socket(settings) as ws:
        assert _join(ws, f"org:{room.org}:presence", channel_token)["status"] == "ok"
        beat = room.client.post(
            "/api/comms/presence", headers=room.headers[1], json={"state": "online"}
        )
        assert beat.status_code == 200
        assert (
            _read_until(
                ws, lambda row: row.get("payload", {}).get("payload", {}).get("state") == "online"
            )
            is not None
        )
        # Owned elapsed-time fixture; the lower API/SQL journey proves the exact119/120 boundary.
        # This case does not replace or invoke the worker: its real30-second loop must publish.
        with Session(room.owner) as db:
            row = db.scalar(
                select(CommsPresence).where(
                    CommsPresence.org_id == room.org, CommsPresence.user_id == room.people[1].id
                )
            )
            row.last_seen_at = datetime.now(UTC) - timedelta(seconds=121)
            db.commit()
        deadline, offline = time.monotonic() + 40, None
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                message = json.loads(ws.recv(timeout=min(10, remaining)))
            except TimeoutError:
                ws.send(
                    json.dumps(
                        {
                            "topic": "phoenix",
                            "event": "heartbeat",
                            "ref": "keepalive",
                            "payload": {},
                        }
                    )
                )
                continue
            if (
                message.get("payload", {}).get("event") == "presence"
                and message.get("payload", {}).get("payload", {}).get("state") == "offline"
            ):
                offline = message
                break
        assert offline is not None
        assert offline["payload"]["payload"] == {
            "user_id": str(room.people[1].id),
            "state": "offline",
        }
    refreshed = authenticate(room.client, room.people[1])
    snapshot = room.client.get(
        "/api/comms/presence", headers=refreshed, params={"user_ids": str(room.people[1].id)}
    )
    assert snapshot.status_code == 200 and snapshot.json()["items"] == [
        {"user_id": str(room.people[1].id), "state": "offline"}
    ]
