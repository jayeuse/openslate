"""The real planner/dispatcher/sample journal exercise D45 grant APIs against PostgreSQL."""

from datetime import date

import httpx
import pytest
from sqlalchemy import text

from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.operations.sample.controls.comms_support import _planned

pytestmark = pytest.mark.integration

GRANT_ROUTES = {
    (method, target + suffix)
    for target in (
        "/api/comms/conversations/{conversation_id}",
        "/api/comms/categories/{category_id}",
    )
    for method, suffix in (
        ("GET", "/access-grants"),
        ("GET", "/access-candidates"),
        ("PUT", "/access-grants/group/{subject_id}"),
        ("PUT", "/access-grants/user/{subject_id}"),
        ("DELETE", "/access-grants/group/{subject_id}"),
        ("DELETE", "/access-grants/user/{subject_id}"),
    )
}


def test_access_grant_executor_covers_every_grant_route_and_leaves_no_grant(
    structure_routes, tmp_path
):
    case, org = structure_routes, structure_routes.world.first
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    action = _planned(dataset, "access_grants_roundtrip")
    values = action.values
    with case.world.owner.begin() as connection:
        connection.execute(
            text("UPDATE public.groups SET name = :name WHERE id = :id"),
            {"name": values["group_name"], "id": org.group},
        )
    api = case.client(org.author, org.id)
    journal = tmp_path / "requests.jsonl"

    def forward(request):
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
            user_ids={"admin": str(org.author), values["member_key"]: str(org.peer)},
            department_ids={values["department_key"]: str(org.department)},
            group_ids={values["group_key"]: str(org.group)},
            module_ids={},
            field_ids={},
            mappings={},
            admin_password="fixture-only",
        )
        result = execute_phase_action(action, dataset, context)
    assert result["access_grants_verified"] is True
    assert result["organization_id"] == str(org.id)
    channel = f"/api/comms/conversations/{result['conversation_id']}"
    assert api.get(f"{channel}/access-grants").json() == {"items": []}
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    assert covered >= GRANT_ROUTES
