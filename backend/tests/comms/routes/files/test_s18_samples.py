"""S18 sample journal comes from real conversation APIs and private provider Storage."""

from datetime import date
from shutil import copyfile

import httpx
import pytest

from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, execute_phase_action
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.operations.sample.controls.comms_support import _planned
from tests.operations.sample.controls.test_sample_control_comms_content import CONTENT_ROUTES
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("organization", ["primary", "partner"])
def test_content_sample_uses_owned_bindings_and_real_files_without_cross_org_catalog_ids(
    file_routes, tmp_path, organization
):
    case, org = file_routes, file_routes.world.first
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    action = _planned(
        dataset, "s18_content" if organization == "primary" else "partner_s18_content"
    )
    api = case.client(org.author, org.id)
    mappings = {"comms_conversations": {f"{organization}:comms:messages": str(org.conversation)}}
    if organization == "primary":
        with case.world.session(org) as db:
            db.add(
                Module(
                    id=org.module,
                    org_id=org.id,
                    department_id=org.department,
                    module_name="Sample source",
                )
            )
            db.flush()
            db.add(Record(id=org.record, org_id=org.id, module_id=org.module, data={}))
            db.commit()
        mappings["records"] = {dataset.records[0].logical_id: str(org.record)}
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
            user_ids={"admin": str(org.author), "operator": str(org.author)},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings=mappings,
            admin_password="fixture-only",
            private_values={"partner_admin": lambda: client, "operator_password": "fixture-only"},
        )
        result = execute_phase_action(action, dataset, context)
        assert result["organization_id"] == str(org.id) and result["content_verified"] is True
        assert result["record_reference_verified"] is (organization == "primary")
        from operations.sample.controls.comms_content import verify_content_control

        assert verify_content_control(client, action, result, str(org.author)) == []
        result["request_evidence"].pop(0)
        assert verify_content_control(client, action, result, str(org.author))
    covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
    expected = (
        CONTENT_ROUTES
        if organization == "primary"
        else {
            route
            for route in CONTENT_ROUTES
            if not route[1].endswith("/record-references/{reference_id}")
        }
    )
    assert expected <= covered
    artifact = REPOSITORY_ROOT / f"backend/test-results/s18/sample-{organization}-journal.jsonl"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    copyfile(journal, artifact)
