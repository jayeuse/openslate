"""The real planner/dispatcher/sample journal exercise structure APIs against PostgreSQL."""

from datetime import date
from shutil import copyfile
from uuid import UUID

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.operations.sample.controls.comms_support import _planned
from tests.operations.sample.controls.test_sample_control_comms_messages import MESSAGE_ROUTES
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration


def test_structure_executor_produces_owned_message_mapping_and_observed_route_evidence(
    structure_routes,
    tmp_path,
):
    case, org, other = structure_routes, structure_routes.world.first, structure_routes.world.second
    case.add_home_members(other.author)
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    action = _planned(dataset, "structure_roundtrip")
    members = action.values["member_keys"]
    plans = list(plan_controls(dataset))
    messages = _planned(dataset, "message_roundtrip")
    assert plans.index(action) < plans.index(messages)
    api = case.client(org.author, org.id)
    journal = tmp_path / "requests.jsonl"

    def forward(request):
        assert request.headers["x-org"] == str(org.id)
        if request.url.path == "/api/auth/login":
            # Provider authentication is outside this slice; structure requests use the
            # same supplied-principal fixture as the route integration tests.
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
            )
        response = api.request(
            request.method,
            str(request.url),
            content=request.content,
            headers={k: v for k, v in request.headers.items() if k != "host"},
        )
        return httpx.Response(
            response.status_code, headers=response.headers, content=response.content
        )

    with SampleClient(
        "http://testserver",
        "http://localhost:3000",
        journal,
        org.id,
        transport=httpx.MockTransport(forward),
    ) as client:
        assert client.login("fixture@example.test", "fixture-only").status_code == 200
        context = PhaseExecutionContext(
            clients={"admin": client},
            user_ids={
                "admin": str(org.author),
                members[0]: str(org.peer),
                members[1]: str(other.author),
            },
            department_ids={},
            group_ids={},
            module_ids={},
            field_ids={},
            mappings={},
            admin_password="fixture-only",
        )
        result = execute_phase_action(action, dataset, context)
        identity = context.runtime_mappings["comms_conversations"]["primary:comms:messages"]
        UUID(identity)
        assert result["structure_verified"] is True
        assert result["organization_id"] == str(org.id)
        assert api.get(f"/api/comms/conversations/{identity}").status_code == 200
        message_result = execute_phase_action(messages, dataset, context)
        assert message_result["conversation_id"] == identity and message_result["message_deleted"]
        from operations.sample.controls.comms_structure import verify_structure_controls

        manifest = {
            "organization_id": str(org.id),
            "control_results": [result],
            "mappings": context.runtime_mappings,
        }
        counts, issues = verify_structure_controls(client, dataset, manifest, str(org.author))
        assert issues == [] and counts["comms_structure_verified"] == 1
        result["request_evidence"].pop(0)
        assert verify_structure_controls(client, dataset, manifest, str(org.author))[1]
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    assert covered >= MESSAGE_ROUTES
    from tests.operations.sample.controls.test_sample_control_comms import STRUCTURE_ROUTES

    assert covered >= STRUCTURE_ROUTES
    artifact = REPOSITORY_ROOT / "backend/test-results/s17-structure/sample-primary-journal.jsonl"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    copyfile(journal, artifact)
