"""Real API token sample execution, organization binding and token-free journal evidence."""

from datetime import date

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES, read_route_evidence
from tests.comms.routes.test_realtime_grant_routes import realtime_case as realtime_case
from tests.operations.sample.controls.comms_support import _planned

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("namespace", ["primary", "partner"])
def test_token_sample_uses_the_bound_api_and_never_journals_the_channel_token(
    realtime_case, tmp_path, namespace
):
    case, _clock = realtime_case
    org = case.world.first
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    action = _planned(
        dataset, "token_roundtrip" if namespace == "primary" else "partner_token_roundtrip"
    )
    api = case.client(org.author, org.id)
    journal = tmp_path / "requests.jsonl"
    tokens = []

    def forward(request):
        assert request.headers["x-org"] == str(org.id)
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers={
                    "Set-Cookie": "openslate_csrf=fixture; Path=/",
                },
            )
        response = api.request(
            request.method,
            str(request.url),
            content=request.content,
            headers={key: value for key, value in request.headers.items() if key != "host"},
        )
        if request.url.path == "/api/realtime/token" and response.status_code == 200:
            tokens.append(response.json()["access_token"])
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
    assert result["token_verified"] is True and result["organization_id"] == str(org.id)
    assert result["conversation_count"] == 2
    assert tokens and all(
        token not in journal.read_text() and token not in str(result) for token in tokens
    )
    assert ("POST", "/api/realtime/token") in SEEDER_ROUTES
    assert ("POST", "/api/realtime/token") in {
        (row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]
    }
