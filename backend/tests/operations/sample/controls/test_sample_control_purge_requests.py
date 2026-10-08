"""Actual request journeys for same-slice report and event purge executors."""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from datetime import date
from pathlib import Path

import httpx
import pytest

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.controls.boards import execute_board_control, plan_board_controls
from operations.sample.controls.openview import execute_openview_control, plan_openview_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.sample_purge_wire import (
    ADMIN_ID,
    BOARD_ID,
    EVENT_ID,
    MODULE_ID,
    PASSWORD,
    TOKEN,
    SamplePurgeWire,
)
from tests.operations.sample.controls.test_sample_control_board_requests import (
    _action as _board_copy_action,
)
from tests.operations.sample.controls.test_sample_control_board_requests import (
    _context as _board_copy_context,
)
from tests.operations.sample.controls.test_sample_control_board_requests import (
    _response as _board_copy_response,
)


@pytest.fixture(scope="module")
def dataset() -> SampleDataset:
    return build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))


def _journey(tmp_path: Path, dataset: SampleDataset, target_type: str, wire: SamplePurgeWire):
    if target_type == "board_event":
        original = next(
            action
            for action in plan_board_controls(dataset)
            if action.values["operation"] in {"event_purge", "event_delete"}
        )
        action = replace(
            original,
            actor_key="admin",
            expected_status=200,
            values={**original.values, "operation": "event_purge"},
        )
        mappings = {
            "control_boards": {str(action.values["board_key"]): BOARD_ID},
            "control_events": {action.target_key: EVENT_ID},
        }
        execute = execute_board_control
        module_ids = {}
    else:
        actions = plan_openview_controls(dataset)
        source = next(action for action in actions if action.values["operation"] == "report_patch")
        original = next(
            (action for action in actions if action.values["operation"] == "report_purge"), source
        )
        action = replace(
            original,
            actor_key="admin",
            target_key="control:report_purge",
            expected_status=200,
            values={
                "operation": "report_purge",
                "source_report_key": source.target_key,
                "module_key": source.values["module_key"],
                "temporary_name": "Temporary report / Résumé",
            },
        )
        mappings = {"reports": {source.target_key: str(wire.source["id"])}}
        execute = execute_openview_control
        module_ids = {str(source.values["module_key"]): MODULE_ID}
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "purge-requests.jsonl",
        transport=httpx.MockTransport(wire),
    )
    assert client.login("admin@sample.test", PASSWORD).status_code == 200
    context = PhaseExecutionContext(
        clients={"admin": client},
        user_ids={"admin": ADMIN_ID},
        group_ids={},
        department_ids={},
        module_ids=module_ids,
        field_ids={},
        mappings=mappings,
        admin_password=PASSWORD,
    )
    return action, context, execute


@pytest.mark.parametrize("target_type", ("report", "board_event"))
def test_purge_executor_uses_bound_preview_and_proves_disposal_without_private_values(
    tmp_path: Path,
    dataset: SampleDataset,
    target_type: str,
) -> None:
    wire = SamplePurgeWire(target_type)
    records, schedule = copy.deepcopy(wire.source_records), copy.deepcopy(wire.schedule)
    action, context, execute = _journey(tmp_path, dataset, target_type, wire)
    with context.clients["admin"]:
        result = execute(action, dataset, context)
    assert result["outcome"] == "completed"
    assert wire.preview_attempts == wire.purge_attempts == 1
    assert wire.purged
    assert any(request.method == "GET" and request.url.path == wire.path for request in wire.seen)
    assert wire.source == wire.original_source
    assert wire.source_records == records and wire.schedule == schedule
    if target_type == "report":
        assert wire.create_attempts == wire.archive_attempts == 1
        assert wire.temporary["id"] != wire.source["id"]
    else:
        assert wire.board["id"] == BOARD_ID and wire.board["revision"] > 7
    purge = next(request for request in wire.seen if request.url.path == wire.path + "/purge")
    assert "openslate_access=admin" in purge.headers["cookie"]
    assert not any(
        request.method == "DELETE" and "/events/" in request.url.path for request in wire.seen
    )
    serialized = json.dumps(result) + (tmp_path / "purge-requests.jsonl").read_text()
    assert TOKEN not in serialized and PASSWORD not in serialized


@pytest.mark.parametrize("target_type", ("report", "board_event"))
@pytest.mark.parametrize(
    "fault",
    (
        "preview_denied",
        "preview_unavailable",
        "preview_target",
        "preview_type",
        "preview_operation",
        "blockers",
        "missing_backup",
        "invalid_backup",
        "invalid_expiry",
        "empty_name",
        "malformed_name",
        "empty_token",
    ),
)
def test_purge_executor_refuses_invalid_preview_before_deletion(
    tmp_path: Path,
    dataset: SampleDataset,
    target_type: str,
    fault: str,
) -> None:
    wire = SamplePurgeWire(target_type, fault=fault)
    action, context, execute = _journey(tmp_path, dataset, target_type, wire)
    with (
        context.clients["admin"],
        pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as caught,
    ):
        execute(action, dataset, context)
    assert wire.preview_attempts == 1 and wire.purge_attempts == 0
    assert not wire.purged and wire.source == wire.original_source
    assert "Private" not in str(caught.value) and TOKEN not in str(caught.value)


@pytest.mark.parametrize("target_type", ("report", "board_event"))
@pytest.mark.parametrize(
    "fault",
    (
        "purge_denied",
        "purge_conflict",
        "purge_unavailable",
        "result_target",
        "result_type",
        "result_operation",
        "missing_operation_id",
        "malformed_result",
        "retained_target",
    ),
)
def test_purge_executor_never_reports_success_for_denial_mismatch_or_retained_target(
    tmp_path: Path,
    dataset: SampleDataset,
    target_type: str,
    fault: str,
) -> None:
    wire = SamplePurgeWire(target_type, fault=fault)
    action, context, execute = _journey(tmp_path, dataset, target_type, wire)
    with (
        context.clients["admin"],
        pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as caught,
    ):
        execute(action, dataset, context)
    assert wire.purge_attempts == 1
    assert wire.source == wire.original_source
    assert "Private" not in str(caught.value) and PASSWORD not in str(caught.value)


@pytest.mark.parametrize("fault", ("removed_board", "unchanged_board_revision", "active_event"))
def test_event_purge_preserves_the_parent_and_requires_archived_target(
    tmp_path: Path,
    dataset: SampleDataset,
    fault: str,
) -> None:
    wire = SamplePurgeWire("board_event", fault=fault)
    action, context, execute = _journey(tmp_path, dataset, "board_event", wire)
    with context.clients["admin"], pytest.raises(SamplePhaseActionError):
        execute(action, dataset, context)
    assert wire.preview_attempts == (0 if fault == "active_event" else 1)


@pytest.mark.parametrize("fault", ("created_source", "changed_source"))
def test_report_purge_never_disposes_or_changes_the_authored_source(
    tmp_path: Path,
    dataset: SampleDataset,
    fault: str,
) -> None:
    wire = SamplePurgeWire("report", fault=fault)
    action, context, execute = _journey(tmp_path, dataset, "report", wire)
    with context.clients["admin"], pytest.raises(SamplePhaseActionError):
        execute(action, dataset, context)
    assert wire.create_attempts == 1
    if fault == "created_source":
        assert wire.archive_attempts == wire.preview_attempts == wire.purge_attempts == 0


@pytest.mark.parametrize(
    ("operation", "fault"),
    (
        ("purge_duplicate", "none"),
        ("purge_import", "none"),
        ("purge_duplicate", "empty_name"),
        ("purge_duplicate", "malformed_name"),
        ("purge_duplicate", "target"),
        ("purge_duplicate", "operation"),
    ),
)
def test_board_copy_purge_submits_preview_name_and_rejects_unbound_preview(
    tmp_path: Path, operation: str, fault: str
) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    action = _board_copy_action(dataset, operation)
    path = f"/api/boards/{BOARD_ID}"
    name = "Archived  Board / Résumé"
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"},
                json={"ok": True},
            )
        seen.append(request)
        if request.method == "GET" and request.url.path == path:
            return _board_copy_response(
                200,
                {
                    "id": BOARD_ID,
                    "name": name,
                    "revision": 7,
                    "scope": "project",
                    "status": "active",
                },
            )
        if request.method == "POST" and request.url.path == f"{path}/archive":
            assert json.loads(request.content) == {"revision": 7}
            return _board_copy_response(200, {"id": BOARD_ID, "status": "archived", "revision": 8})
        if request.method == "POST" and request.url.path == f"{path}/purge/preview":
            assert not request.content
            return _board_copy_response(
                200,
                {
                    "token": "private-board-preview",
                    "confirmation_name": ""
                    if fault == "empty_name"
                    else 42
                    if fault == "malformed_name"
                    else name,
                    "impact": {
                        "target_id": EVENT_ID if fault == "target" else BOARD_ID,
                        "operation": "close" if fault == "operation" else "purge",
                    },
                },
            )
        if request.method == "POST" and request.url.path == f"{path}/purge":
            assert json.loads(request.content) == {
                "token": "private-board-preview",
                "confirmation_name": name,
                "password": "fixture-only",
            }
            return _board_copy_response(
                200, {"impact": {"target_id": BOARD_ID, "operation": "purge"}}
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    context = _board_copy_context(
        tmp_path,
        action.actor_key,
        handler,
        mappings={"control_boards": {action.target_key: BOARD_ID}},
    )
    try:
        if fault != "none":
            with pytest.raises(SamplePhaseActionError, match="purge preview did not match"):
                execute_board_control(action, dataset, context)
            assert not any(request.url.path.endswith("/purge") for request in seen)
            assert "control_board_purges" not in context.private_values
            return
        result = execute_board_control(action, dataset, context)
        assert result["outcome"] == "completed"
        assert seen[-1].url.path == f"{path}/purge"
        serialized = json.dumps(result)
        assert "private-board-preview" not in serialized and "fixture-only" not in serialized
        assert context.private_values["control_board_purges"] == {}
    finally:
        context.clients[action.actor_key].close()
