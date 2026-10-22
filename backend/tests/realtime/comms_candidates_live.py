"""Primary/partner candidate discovery through actual authenticated API composition."""

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


def test_primary_partner_direct_candidates_use_real_policy_and_bounded_public_dto(native_room):
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
    directory = (
        Path("test-results/direct-candidates/native") / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    )
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
                dataset,
                "direct_candidates" if namespace == "primary" else "partner_direct_candidates",
            )
            result = execute_phase_action(action, dataset, context)
            assert result["candidates_verified"] is True and result["organization_id"] == str(org)
    endpoint = ("GET", "/api/comms/direct-candidates")
    assert endpoint in SEEDER_ROUTES
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    assert endpoint in covered
