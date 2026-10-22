"""D21: primary/partner executors call the real presence and typing routes."""

from datetime import date

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES, read_route_evidence
from tests.comms.routes.test_presence_typing_routes import presence_case as presence_case
from tests.operations.sample.controls.comms_support import _planned

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("namespace", ["primary", "partner"])
def test_presence_sample_exercises_all_three_real_http_calls(presence_case, tmp_path, namespace):
    case, _clock = presence_case
    org = case.world.first
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    action = _planned(
        dataset, "presence_roundtrip" if namespace == "primary" else "partner_presence_roundtrip"
    )
    api, journal = case.client(org.author, org.id), tmp_path / "requests.jsonl"

    def forward(request):
        assert request.headers["x-org"] == str(org.id)
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"},
            )
        response = api.request(
            request.method,
            str(request.url),
            content=request.content,
            headers={key: value for key, value in request.headers.items() if key != "host"},
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
        context = PhaseExecutionContext(
            clients={"admin": client if namespace == "primary" else primary},
            user_ids={"admin": str(org.author)},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings={
                "comms_conversations": {f"{namespace}:comms:messages": str(org.conversation)}
            },
            admin_password="fixture-only",
            private_values={"partner_admin": lambda: client},
        )
        result = execute_phase_action(action, dataset, context)
    assert result["presence_verified"] is True and result["typing_verified"] is True
    assert result["organization_id"] == str(org.id)
    expected = {
        ("GET", "/api/comms/presence"),
        ("POST", "/api/comms/presence"),
        ("POST", "/api/comms/conversations/{conversation_id}/typing"),
    }
    assert expected <= SEEDER_ROUTES
    assert expected <= {
        (row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]
    }
