"""All23 S24 routes through real Auth/CSRF and actual primary/partner sample execution."""

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

pytestmark = pytest.mark.integration


def test_primary_partner_templates_history_proofs_and_managed_admissions(native_room):
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
    directory = Path("test-results/s24/native") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    directory.mkdir(parents=True, exist_ok=True)
    journal = directory / "requests.jsonl"
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
        for namespace, org in (("primary", room.org), ("partner", room.other_org)):
            action = _planned(
                dataset,
                "configuration_roundtrip"
                if namespace == "primary"
                else "partner_configuration_roundtrip",
            )
            result = execute_phase_action(action, dataset, context)
            assert result["configuration_verified"] is True and result["organization_id"] == str(
                org
            )
    expected = {
        ("GET", "/api/comms/templates"),
        ("POST", "/api/comms/templates"),
        ("GET", "/api/comms/templates/{template_id}"),
        ("PUT", "/api/comms/templates/{template_id}"),
        ("POST", "/api/comms/templates/{template_id}/application-preview"),
        ("POST", "/api/comms/templates/{template_id}/applications"),
        ("GET", "/api/comms/conversations/{conversation_id}/admissions"),
        ("GET", "/api/comms/conversations/{conversation_id}/admissions/{admission_id}"),
        ("POST", "/api/comms/conversations/{conversation_id}/invitations"),
        ("POST", "/api/comms/conversations/{conversation_id}/admissions/{admission_id}/decision"),
        ("POST", "/api/comms/join-requests"),
        *(
            (method, "/api/comms/settings/" + scope + suffix)
            for scope in ("workspace", "category/{category_id}", "channel/{conversation_id}")
            for method, suffix in (
                ("GET", "/history"),
                ("GET", "/history/{history_id}"),
                ("POST", "/restoration-preview"),
                ("POST", "/restoration"),
            )
        ),
    }
    assert len(expected) == 23 and expected <= SEEDER_ROUTES
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    assert expected <= covered
