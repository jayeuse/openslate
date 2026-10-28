"""Structure readbacks see every row, not only the API's first page."""

from datetime import date
from uuid import uuid4

import httpx

from operations.sample.client import SampleClient
from operations.sample.controls.comms_structure import plan_structure_controls
from operations.sample.controls.comms_structure_common import StructureRun
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.scenario import build_dataset

ORG = "0190a000-0000-7000-8000-00000000000a"


def test_member_readback_reads_every_page(tmp_path) -> None:
    # An organization channel holds every member. Harbor Small has 45, and the API's
    # default page holds 25, so the admin fell onto page 2 and the check failed (F10).
    members = [
        {
            "user_id": str(uuid4()),
            "display_name": f"Person {index:03}",
            "member_role": "member",
            "level": "post",
            "joined_at": "2026-10-01T00:00:00Z",
            "departments": [],
        }
        for index in range(130)
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"})
        limit = int(request.url.params.get("limit", "25"))
        offset = int(request.url.params.get("offset", "0"))
        items = members[offset : offset + limit]
        return httpx.Response(
            200,
            json={
                "items": items,
                "pagination": {
                    "limit": limit,
                    "offset": offset,
                    "count": len(items),
                    "total": len(members),
                    "has_more": offset + len(items) < len(members),
                },
            },
        )

    dataset = build_dataset("small", organization=get_pack("harbor"), anchor_date=date(2026, 9, 30))
    action = plan_structure_controls(dataset)[0]
    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        ORG,
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("admin@example.test", "fixture-password")
        context = PhaseExecutionContext(
            clients={"admin": client},
            user_ids={"admin": str(uuid4())},
            department_ids={},
            group_ids={},
            module_ids={},
            field_ids={},
            mappings={},
            admin_password="fixture-password",
        )
        run = StructureRun(action, context, None)
        rows = run.page(f"/api/comms/conversations/{uuid4()}/members", "member")

    assert [row["user_id"] for row in rows] == [row["user_id"] for row in members]
