"""Real primary/partner search sample execution, request journals and retained-tombstone checks."""

from datetime import date
from shutil import copyfile

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.operations.sample.controls.comms_support import _planned
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("organization", ["primary", "partner"])
def test_search_sample_observes_real_hits_then_excludes_its_tombstone(
    search_case, tmp_path, organization
):
    case, org = search_case, search_case.world.first
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    action = _planned(
        dataset, "search_roundtrip" if organization == "primary" else "partner_search_roundtrip"
    )
    api = case.client(org.author, org.id)
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
        context = PhaseExecutionContext(
            clients={"admin": client if organization == "primary" else primary},
            user_ids={"admin": str(org.author)},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings={
                "comms_conversations": {f"{organization}:comms:messages": str(org.conversation)}
            },
            admin_password="fixture-only",
            private_values={"partner_admin": lambda: client},
        )
        result = execute_phase_action(action, dataset, context)
        assert result["organization_id"] == str(org.id) and result["search_verified"] is True
        assert result["tombstone_hidden"] is True
        from operations.sample.controls.comms_search import verify_search_control

        assert verify_search_control(client, result, str(org.author)) == []
        result["request_evidence"].pop(0)
        assert verify_search_control(client, result, str(org.author))
    assert ("GET", "/api/comms/search") in {
        (row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]
    }
    artifact = REPOSITORY_ROOT / f"backend/test-results/s19/sample-{organization}-journal.jsonl"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    copyfile(journal, artifact)
