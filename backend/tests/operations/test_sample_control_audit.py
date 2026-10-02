"""A simulated administrator reviews the same Audit routes as Manage."""

from datetime import date
from pathlib import Path
from uuid import uuid4

import httpx

from operations.sample_client import SampleClient
from operations.sample_control_actions import execute_control_action
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import PhaseExecutionContext
from operations.sample_scenario import build_dataset


def test_audit_review_lists_entries_then_reads_options_and_a_real_detail(tmp_path: Path) -> None:
    actor_id, audit_id = str(uuid4()), str(uuid4())
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"})
        assert request.method == "GET"
        seen.append(request.url.path)
        if request.url.path == "/api/audit-logs":
            assert dict(request.url.params) == {
                "limit": "25",
                "offset": "0",
                "sort_by": "created_at",
                "sort_order": "desc",
            }
            return httpx.Response(200, json={"items": [{"id": audit_id}]})
        if request.url.path.endswith("/options"):
            return httpx.Response(200, json={"entity_types": ["records"], "actors": []})
        assert request.url.path == f"/api/audit-logs/{audit_id}"
        return httpx.Response(200, json={"id": audit_id})

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("operator@example.test", "fixture-memory-only")
        context = PhaseExecutionContext(
            clients={"admin": client},
            user_ids={"admin": actor_id},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            mappings={},
            admin_password="fixture-memory-only",
        )
        action = PhaseAction(
            key="control:audit_review",
            phase="reorganization",
            kind="audit_controls",
            actor_key="admin",
            target_key="control:audit",
            values={"operation": "audit_review"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={"reviewed": True},
        )
        result = execute_control_action(
            action, build_dataset("small", 83, date(2026, 10, 2)), context
        )
    assert seen == ["/api/audit-logs", "/api/audit-logs/options", f"/api/audit-logs/{audit_id}"]
    assert result["audit_id"] == audit_id
