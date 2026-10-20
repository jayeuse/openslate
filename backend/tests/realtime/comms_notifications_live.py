"""Native primary/partner sample journals and private notification wire delivery (no load)."""

import os
from contextlib import ExitStack
from datetime import date
from pathlib import Path

import httpx
import pytest
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES, read_route_evidence
from tests.conftest import create_member
from tests.operations.sample.controls.comms_support import _planned
from tests.realtime.native_support import native_room as native_room
from tests.realtime.test_realtime_channel_acceptance import _join, _read_until, _socket

pytestmark = pytest.mark.integration


def test_primary_partner_notification_samples_and_user_topic_delivery(native_room):
    room, settings = native_room, get_settings()
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    member_key = next(person.key for person in dataset.organization.actors.people
                      if person.role == "member" and person.status == "active")
    with Session(room.owner) as db:
        org = db.get(WorkspaceProfile, room.other_org)
        for index, role in ((0, "admin"), (1, "member")):
            create_member(db, org, role, user=db.get(User, room.people[index].id))
        db.commit()
    partner_headers = {**room.headers[0], "X-Org": str(room.other_org)}
    response = room.client.post("/api/comms/conversations", headers=partner_headers, json={
        "name": "Owned partner notification room", "scope": "members", "category_id": None,
        "position": 0, "topic": "", "member_ids": [str(room.people[1].id)],
    })
    assert response.status_code == 201
    partner_conversation = response.json()["id"]
    directory = Path("test-results/s21/native") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    directory.mkdir(parents=True, exist_ok=True)
    journal = directory / "requests.jsonl"
    with ExitStack() as stack:
        clients = {}
        for name, org in (("primary", room.org), ("partner", room.other_org)):
            for index in (0, 1):
                client = stack.enter_context(SampleClient(
                    str(settings.public_origin), str(settings.public_origin), journal, org,
                    # Local runner-owned Caddy certificate, never an external installation.
                    transport=httpx.HTTPTransport(verify=False),
                ))
                login = client.login(room.people[index].email, room.people[index].password)
                assert login.status_code == 200
                clients[name, index] = client
        context = PhaseExecutionContext(
            clients={"admin": clients["primary", 0], member_key: clients["primary", 1]},
            user_ids={"admin": str(room.people[0].id), member_key: str(room.people[1].id)},
            group_ids={}, department_ids={}, module_ids={}, field_ids={},
            mappings={"comms_conversations": {
                "primary:comms:messages": str(room.conversation),
                "partner:comms:messages": partner_conversation,
            }}, admin_password=room.people[0].password,
            private_values={"partner_admin": lambda: clients["partner", 0],
                            "partner_actor": lambda _key: clients["partner", 1]},
        )
        for namespace, org, conversation in (
            ("primary", room.org, str(room.conversation)),
            ("partner", room.other_org, partner_conversation),
        ):
            headers = {**room.headers[1], "X-Org": str(org)}
            token = room.client.post("/api/realtime/token", headers=headers)
            assert token.status_code == 200
            topic = f"org:{org}:user:{room.people[1].id}"
            with _socket(settings) as ws:
                assert _join(ws, topic, token.json()["access_token"])["status"] == "ok"
                action = _planned(dataset, "notification_roundtrip" if namespace == "primary"
                                  else "partner_notification_roundtrip")
                result = execute_phase_action(action, dataset, context)
                assert result["notifications_verified"] is True
                assert result["organization_id"] == str(org)
                delivered = _read_until(
                    ws, lambda row: row.get("payload", {}).get("event") == "notification",
                )
                assert delivered["payload"]["payload"] == {"id": result["notification_id"]}
                assert delivered["topic"] == "realtime:" + topic
                read = room.client.put(
                    f"/api/comms/conversations/{conversation}/read", headers=headers,
                    json={"last_read_seq": result["message_seq"]},
                )
                assert read.status_code == 200
                trailing = []
                assert _read_until(ws, lambda row, trailing=trailing: trailing.append(row) or
                                   row.get("payload", {}).get("event") == "read") is not None
                assert not any(
                    row.get("payload", {}).get("event") == "notification" for row in trailing
                )
    expected = {("GET", "/api/notifications"), ("GET", "/api/notifications/unread-count"),
                ("POST", "/api/notifications/{notification_id}/read")}
    assert expected <= SEEDER_ROUTES
    evidence = read_route_evidence(journal)
    assert expected <= {(row["method"], row["path"]) for row in evidence["covered"]}
