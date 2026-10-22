"""Real sample requests and journals use owned primary/partner API resources, not SQL."""

from datetime import date
from shutil import copyfile

import httpx
import pytest

from app.systems.access.policy.models import GroupAccess, GroupMember
from operations.sample.client import SampleClient
from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.comms.routes.structure_support import ROOT, _channel, _created
from tests.operations.sample.controls.comms_support import _planned
from tests.operations.sample.controls.test_sample_control_comms_settings import SETTINGS_ROUTES
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("organization", ["primary", "partner"])
def test_settings_sample_uses_owned_context_restores_values_and_reconciles_readbacks(
    structure_routes,
    tmp_path,
    organization,
):
    case, org = structure_routes, structure_routes.world.first
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    operation = (
        "preferences_settings" if organization == "primary" else "partner_preferences_settings"
    )
    action = _planned(dataset, operation)
    plans = list(plan_controls(dataset))
    assert plans.index(_planned(dataset, "partner_conversations")) < plans.index(action)
    api = case.client(org.author, org.id)
    with case.world.session(org) as db:
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        db.add(
            GroupAccess(
                org_id=org.id, group_id=org.group, department_id=org.department, level="write"
            )
        )
        db.commit()
    created, _ = _created(
        api,
        ROOT + "/conversations",
        _channel(
            "Sample settings",
            org.category,
            "department",
            department_id=str(org.department),
        ),
    )
    journal = tmp_path / "requests.jsonl"

    def forward(request):
        assert request.headers["x-org"] == str(org.id)
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
            )
        if request.url.path.endswith("preferences"):
            assert "if-match" not in request.headers
        response = api.request(
            request.method,
            str(request.url),
            content=request.content,
            headers={k: v for k, v in request.headers.items() if k != "host"},
        )
        return httpx.Response(
            response.status_code, headers=response.headers, content=response.content
        )

    with (
        SampleClient(
            "http://testserver",
            "http://localhost:3000",
            journal,
            org.id,
            transport=httpx.MockTransport(forward),
        ) as client,
        SampleClient(
            "http://testserver",
            "http://localhost:3000",
            journal,
            case.world.second.id,
        ) as primary,
    ):
        assert client.login("fixture@example.test", "fixture-only").status_code == 200
        mappings = {
            "comms_conversations": {f"{organization}:comms:messages": created["id"]},
            "comms_categories": {f"{organization}:comms:category": str(org.category)},
        }
        context = PhaseExecutionContext(
            clients={"admin": client if organization == "primary" else primary},
            user_ids={"admin": str(org.author)},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings=mappings,
            admin_password="fixture-only",
            private_values={"partner_admin": lambda: client},
        )
        result = execute_phase_action(action, dataset, context)
        assert result["organization_id"] == str(org.id)
        assert result["configuration_verified"] is True and result["preferences_restored"] is True
        from operations.sample.controls.comms_settings import verify_settings_control

        assert verify_settings_control(client, action, result, mappings, str(org.author)) == []
        result["request_evidence"].pop(0)
        assert verify_settings_control(client, action, result, mappings, str(org.author))
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    assert covered >= SETTINGS_ROUTES
    artifact = (
        REPOSITORY_ROOT / f"backend/test-results/s17-settings/sample-{organization}-journal.jsonl"
    )
    artifact.parent.mkdir(parents=True, exist_ok=True)
    copyfile(journal, artifact)
