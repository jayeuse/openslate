"""Existing real message API, default-off no-egress witness and controlled enabled metadata."""

import json
import os
import time
from contextlib import ExitStack
from datetime import date
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import ScheduledWork
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.conftest import create_member
from tests.operations.sample.controls.comms_support import _planned
from tests.realtime.native_support import native_room as native_room

pytestmark = pytest.mark.integration


def test_native_default_off_is_no_fetch_and_enabled_edit_projects_controlled_plain_metadata(
    native_room,
):
    room, settings = native_room, get_settings()
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    member = next(
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    )
    with Session(room.owner) as db:
        org = db.get(WorkspaceProfile, room.other_org)
        for index, role in ((0, "admin"), (1, "member")):
            create_member(db, org, role, user=db.get(User, room.people[index].id))
        db.commit()
    directory = Path("test-results/s25/native") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    directory.mkdir(parents=True, exist_ok=True)
    journal = directory / "requests.jsonl"
    fetches = Path(os.environ["OPENSLATE_COMMS_TELEMETRY"]).with_name("preview-fetches.jsonl")
    with ExitStack() as stack:
        clients = {}
        for name, org in (("primary", room.org), ("partner", room.other_org)):
            for index in (0, 1):
                client = stack.enter_context(
                    SampleClient(
                        str(settings.public_origin),
                        str(settings.public_origin),
                        journal,
                        org,
                        transport=httpx.HTTPTransport(
                            verify=False
                        ),  # Owned local Caddy certificate.
                    )
                )
                login = client.login(room.people[index].email, room.people[index].password)
                assert login.status_code == 200
                clients[name, index] = client
        context = PhaseExecutionContext(
            clients={"admin": clients["primary", 0], member: clients["primary", 1]},
            user_ids={"admin": str(room.people[0].id), member: str(room.people[1].id)},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings={},
            admin_password=room.people[0].password,
            private_values={
                "partner_admin": lambda: clients["partner", 0],
                "partner_actor": lambda _key: clients["partner", 1],
            },
        )
        sources = {}
        for namespace, org in (("primary", room.org), ("partner", room.other_org)):
            action = _planned(
                dataset,
                "link_preview_default_off"
                if namespace == "primary"
                else "partner_link_preview_default_off",
            )
            result = execute_phase_action(action, dataset, context)
            assert result["default_off_verified"] is True and result["organization_id"] == str(org)
            sources[namespace] = result
        assert not fetches.exists() or fetches.read_text() == ""
        with Session(room.owner) as db:
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ScheduledWork)
                    .where(
                        ScheduledWork.org_id.in_([room.org, room.other_org]),
                        ScheduledWork.kind == "comms-link-preview",
                    )
                )
                == 0
            )
        for number, namespace in enumerate(("primary", "partner"), 1):
            source = sources[namespace]
            admin, author = clients[namespace, 0], clients[namespace, 1]
            settings_path = "/api/comms/settings/channel/" + source["conversation_id"]
            current = admin.request("GET", settings_path)
            configured = admin.request(
                "PATCH",
                settings_path,
                json_body={"link_previews": True},
                headers={"If-Match": current.headers["ETag"]},
            )
            assert configured.status_code == 200
            message_path = (
                "/api/comms/conversations/"
                + source["conversation_id"]
                + "/messages/"
                + source["message_id"]
            )
            url = "https://preview.example.com/controlled-" + namespace
            edited = author.request(
                "PATCH",
                message_path,
                json_body={
                    "body": url,
                    "mention_user_ids": [],
                    "mentions_channel": False,
                    "mentions_here": False,
                },
            )
            assert edited.status_code == 200
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                retained = author.request("GET", message_path)
                assert retained.status_code == 200
                if retained.json()["link_previews"]:
                    break
                time.sleep(0.05)  # Observe the real worker condition, not a fixed completion delay.
            else:
                pytest.fail("Owned preview job did not complete")
            assert retained.json()["link_previews"] == [
                {
                    "url": url,
                    "title": "Owned preview fixture",
                    "description": "Controlled parsed metadata",
                    "site_name": "OpenSlate test",
                }
            ]
            assert len(fetches.read_text().splitlines()) == number
    evidence = read_route_evidence(journal)
    expected = {
        ("POST", "/api/comms/conversations/{conversation_id}/messages"),
        ("PATCH", "/api/comms/conversations/{conversation_id}/messages/{message_id}"),
        ("GET", "/api/comms/conversations/{conversation_id}/messages/{message_id}"),
    }
    assert expected <= {(row["method"], row["path"]) for row in evidence["covered"]}
    (directory / "fetch-summary.json").write_text(
        json.dumps(
            {
                "default_off_fetches": 0,
                "enabled_controlled_fetches": 2,
                "new_endpoint": False,
                "external_network": "mock DNS/socket only",
            },
            indent=2,
        )
        + "\n"
    )
