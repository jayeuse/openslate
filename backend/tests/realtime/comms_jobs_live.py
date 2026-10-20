"""Native Auth/CSRF, protected writes, background exports and private Storage in two orgs."""

import json
import os
from contextlib import ExitStack
from datetime import date
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.users.models import User
from app.systems.comms.jobs.models import CommsExport
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import ScheduledWork
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES, read_route_evidence
from tests.conftest import create_member
from tests.operations.sample.controls.comms_support import _planned
from tests.realtime.native_support import native_room as native_room

pytestmark = pytest.mark.integration


def test_primary_partner_jobs_with_real_password_storage_and_background_execution(native_room):
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
    directory = Path("test-results/s23/native") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    directory.mkdir(parents=True, exist_ok=True)
    journal = directory / "requests.jsonl"

    def purge_failure(response):
        if response.request.url.path.endswith("/purge") and response.status_code >= 500:
            response.read()
            # Only this route's safe public refusal; no headers, request body or credentials.
            with Session(room.owner) as db:
                progress = db.execute(select(
                    ScheduledWork.state, CommsExport.cleanup_pending,
                    CommsExport.artifact_upload_confirmed, CommsExport.cleanup_after,
                ).join(ScheduledWork, ScheduledWork.comms_export_id == CommsExport.id).where(
                    CommsExport.org_id.in_([room.org, room.other_org]),
                )).all()
            raise AssertionError(
                f"Owned purge refused: {response.json().get('detail')}; "
                f"cleanup progress: {progress}"
            )

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
                client._client.event_hooks["response"].append(purge_failure)
                assert (
                    client.login(room.people[index].email, room.people[index].password).status_code
                    == 200
                )
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
        for namespace, org in (("primary", room.org), ("partner", room.other_org)):
            action = _planned(
                dataset, "jobs_roundtrip" if namespace == "primary" else "partner_jobs_roundtrip"
            )
            result = execute_phase_action(action, dataset, context)
            assert result["jobs_verified"] is True and result["organization_id"] == str(org)
    expected = {
        ("GET", "/api/comms/scheduled-messages"),
        ("POST", "/api/comms/scheduled-messages"),
        ("GET", "/api/comms/scheduled-messages/{schedule_id}"),
        ("PUT", "/api/comms/scheduled-messages/{schedule_id}"),
        ("POST", "/api/comms/scheduled-messages/{schedule_id}/send"),
        ("POST", "/api/comms/scheduled-messages/{schedule_id}/cancellation"),
        ("GET", "/api/comms/retention"),
        ("PUT", "/api/comms/retention"),
        ("POST", "/api/comms/retention/preview"),
        ("GET", "/api/comms/exports"),
        ("POST", "/api/comms/exports"),
        ("GET", "/api/comms/exports/{export_id}"),
        ("GET", "/api/comms/exports/{export_id}/content"),
    }
    assert len(expected) == 13 and expected <= SEEDER_ROUTES
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    assert expected <= covered


def test_native_schedule_timestamp_serialization_preserves_microseconds(native_room):
    room = native_room
    path = "/api/comms/scheduled-messages"
    pairs = (
        ("2100-01-02T08:00:00+08:00", "2100-01-02T00:00:00Z",
         "2100-01-02T09:00:00.123456+08:00", "2100-01-02T01:00:00.123456Z"),
        ("2100-01-03T08:00:00.123456789+08:00", "2100-01-03T00:00:00.123456Z",
         "2100-01-03T08:00:00.123456001+08:00", "2100-01-03T00:00:00.123456Z"),
        ("2100-01-04T08:00:00.000001+08:00", "2100-01-04T00:00:00.000001Z",
         "2100-01-04T08:00:00.000009+08:00", "2100-01-04T00:00:00.000009Z"),
    )
    evidence = []
    for create_at, create_expected, edit_at, edit_expected in pairs:
        request = {"conversation_id": str(room.conversation), "client_key": str(uuid4()),
                   "body": "Owned timestamp serialization proof", "send_at": create_at}
        created = room.client.post(path, headers=room.headers[0], json=request)
        assert created.status_code == 201
        assert created.json()["request"]["send_at"] == create_expected
        edit_request = {**request, "send_at": edit_at}
        item_path = path + "/" + created.json()["id"]
        edited = room.client.put(item_path, json=edit_request,
                                  headers={**room.headers[0], "If-Match": created.headers["etag"]})
        assert edited.status_code == 200
        assert edited.json()["request"]["send_at"] == edit_expected
        fetched = room.client.get(item_path, headers=room.headers[0])
        assert fetched.status_code == 200
        assert fetched.json()["request"]["send_at"] == edit_expected
        evidence.append({
            "create_request": request, "create_status": created.status_code,
            "create_json_text": created.content.decode(),
            "edit_request": edit_request, "edit_status": edited.status_code,
            "edit_json_text": edited.content.decode(),
            "read_json_text": fetched.content.decode(),
        })
    directory = Path("test-results/s23/timestamps") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    directory.mkdir(parents=True, exist_ok=True)
    # Owned synthetic request/resource JSON only; never request/response auth headers or secrets.
    (directory / "serialized.json").write_text(json.dumps(evidence, indent=2) + "\n")
