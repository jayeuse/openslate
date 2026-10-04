from __future__ import annotations

from datetime import date
from pathlib import Path

import httpx
import pytest

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.sandbox import (
    plan_sandbox_controls,
    verify_sandbox_controls,
)
from operations.sample.packs import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
TEMP_VERSION_ID = "fc550514-f60a-4e3b-b483-880eed498014"
IMPORT_VERSION_ID = "dc10c8cb-1c5a-4b99-a79e-a95e7897bc70"


def _dataset(pack_key: str = "harbor") -> SampleDataset:
    return build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )


def _login_response(request: httpx.Request) -> httpx.Response | None:
    if request.url.path != "/api/auth/login":
        return None
    return httpx.Response(
        200,
        headers=[
            ("Set-Cookie", "openslate_csrf=fixture-csrf; Path=/; SameSite=Lax"),
            ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly; SameSite=Lax"),
        ],
        json={"authenticated": True},
    )


def _client(tmp_path: Path, handler) -> SampleClient:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return client


def _context(tmp_path: Path, handler) -> PhaseExecutionContext:
    return PhaseExecutionContext(
        clients={"admin": _client(tmp_path, handler)},
        user_ids={"admin": ADMIN_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="fixture-admin-password",
    )


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_sandbox_control_plan_is_stable_and_preserves_dataset(pack_key: str) -> None:
    dataset = _dataset(pack_key)
    before = (dataset.document.copy(), dataset.test_vectors)

    actions = plan_sandbox_controls(dataset)

    assert actions == plan_sandbox_controls(dataset)
    assert [action.values["operation"] for action in actions] == [
        "create_checkpoint",
        "update_checkpoint",
        "delete_checkpoint",
        "export_import_document",
        "delete_import_checkpoint",
        "clear_test_history",
        "restore_test_history",
        "prepare_lifecycle_bindings",
        "close_field",
        "reopen_field",
        "purge_field",
        "close_module",
        "reopen_module",
        "purge_module",
        "close_department",
        "reopen_department",
        "purge_department",
    ]
    assert actions[0].expected_status == 201
    assert actions[1].expected_status == 200
    assert actions[2].expected_status == 204
    assert actions[3].expected_status == 200
    assert actions[4].expected_status == 204
    assert actions[5].expected_status == 204
    assert actions[6].expected_status == 201
    assert all(action.expected_status == 200 for action in actions[7:])
    spec = dataset.organization.phases.design
    assert actions[7].values["module_name"] == spec.new_module_name
    assert actions[7].values["field_name"] == spec.text_field_name
    assert actions[7].values["title_field_name"] == spec.new_module_title_field_name
    assert actions[7].values["department_sandbox_id"] not in dataset.department_ids.values()
    assert actions[7].values["department_name"] == (
        f"{dataset.organization.identity.workspace_name} structure review"
    )
    assert actions[7].values["field_sandbox_id"] != actions[7].values["title_sandbox_id"]
    assert dataset.document == before[0]
    assert dataset.test_vectors == before[1]


def test_sandbox_verifier_reports_malformed_recorded_plan(tmp_path: Path) -> None:
    dataset = _dataset()

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        pytest.fail(f"Unexpected request while rejecting malformed plan: {request.url.path}")

    counts, issues = verify_sandbox_controls(
        _client(tmp_path, handler),
        dataset,
        {"control_plan": [{}], "control_results": []},
        admin_id=ADMIN_ID,
    )

    assert counts == {
        "sandbox_test_runs_verified": 0,
        "sandbox_temporary_versions_removed": 0,
    }
    assert "Sandbox control plan is invalid" in issues


@pytest.mark.parametrize("has_more,total", ((True, 1), (False, 2)))
def test_sandbox_page_readers_refuse_incomplete_serialized_pages(
    tmp_path: Path, has_more: bool, total: int
) -> None:
    from operations.sample.controls.sandbox import _version_list
    from operations.sample.controls.sandbox_verification import _read_final_page

    def handler(request: httpx.Request) -> httpx.Response:
        login = _login_response(request)
        if login is not None:
            return login
        assert request.method == "GET"
        assert dict(request.url.params) == {"limit": "100", "offset": "0"}
        return httpx.Response(
            200,
            json={
                "items": [{"id": TEMP_VERSION_ID}],
                "limit": 100,
                "offset": 0,
                "count": 1,
                "total": total,
                "hasMore": has_more,
            },
        )

    dataset = _dataset()
    context = _context(tmp_path, handler)
    try:
        action = plan_sandbox_controls(dataset)[3]
        with pytest.raises(SamplePhaseActionError, match="version list was incomplete"):
            _version_list(action, context, [], step="read_versions", on_substep=None)
        for path in ("/api/sandbox/versions", "/api/sandbox/tests"):
            assert _read_final_page(context.clients["admin"], path) is None
    finally:
        context.clients["admin"].close()
