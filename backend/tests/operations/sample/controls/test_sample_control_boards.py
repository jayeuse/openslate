from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.boards import (
    CONTROL_ROUTES,
    plan_board_controls,
)
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.scenario import build_dataset

ACTOR_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
BOARD_ID = "a36755cf-e6ed-4da7-bdee-d9154423b3fb"
POST_ID = "271570e8-4c3c-4a0b-8879-ab374a1fc9c3"
EVENT_ID = "9748c02c-7e61-483e-ae88-6674e1bbcc4f"
WIDGET_IDS = (
    "b4ad5c26-991c-4de9-955f-902c22ce388e",
    "d917973e-b6f0-42a9-96d7-18645d5f2094",
)


def _response(status: int, body: object | None = None, *, headers: dict[str, str] | None = None):
    response_headers = dict(headers or {})
    if status in {200, 201, 204}:
        response_headers["X-Request-ID"] = str(uuid4())
    if status == 204:
        return httpx.Response(status, headers=response_headers)
    return httpx.Response(status, headers=response_headers, json=body)


def _context(
    tmp_path: Path,
    actor_key: str,
    handler: Any,
    *,
    mappings: dict[str, dict[str, str]],
) -> PhaseExecutionContext:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "board-control-requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return PhaseExecutionContext(
        clients={actor_key: client},
        user_ids={actor_key: ACTOR_ID},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings=mappings,
        admin_password="fixture-only",
    )


def _action(dataset, operation: str):
    return next(
        action for action in plan_board_controls(dataset) if action.values["operation"] == operation
    )


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_board_control_plan_covers_ui_controls_from_pack_data(pack_key: str) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack(pack_key))

    actions = plan_board_controls(dataset)

    assert actions == plan_board_controls(dataset)
    operations = [action.values.get("operation") for action in actions]
    required = {
        "board_duplicate",
        "board_import",
        "board_share",
        "board_patch",
        "post_create",
        "post_patch",
        "post_publish",
        "post_unpublish",
        "post_delete",
        "post_restore",
        "event_create",
        "event_patch",
        "event_archive",
        "event_restore",
        "event_purge",
        "post_record_link_create",
        "post_record_link_delete",
        "event_record_link_create",
        "event_record_link_delete",
        "widget_patch",
        "widget_duplicate",
        "widget_order",
        "widget_delete",
        "purge_duplicate",
        "purge_import",
    }
    assert required <= set(operations)
    assert "event_delete" not in operations
    purge = next(action for action in actions if action.values["operation"] == "event_purge")
    assert purge.actor_key == "admin" and purge.expected_status == 200
    assert purge.values["board_key"] == "control:duplicate"
    assert purge.target_key == "control:event" and purge.expected_end_state == {"deleted": True}
    assert all(action.kind == "board_controls" for action in actions)
    assert all(action.phase == "reorganization" for action in actions)
    assert len({action.key for action in actions}) == len(actions)
    department_key = dataset.organization.phases.existing_project_board[1]
    board_manager_key = next(
        action.actor_key for action in actions if action.values["operation"] == "board_patch"
    )
    assert {action.actor_key for action in actions} <= {
        "admin",
        *dataset.organization.actors.team_keys[department_key],
    }
    manager = next(
        person for person in dataset.organization.actors.people if person.key == board_manager_key
    )
    original_grants = (
        *dataset.organization.content.data.project_groups,
        dataset.organization.content.data.department_groups[department_key],
    )
    promoted_group = next(group for group, _ in original_grants if group in manager.groups)
    expected_grants = [
        {"group_key": group, "level": "manage" if group == promoted_group else level}
        for group, level in original_grants
    ]
    share = next(action for action in actions if action.values["operation"] == "board_share")
    assert share.values["groups"] == expected_grants
    assert {("PATCH", "/api/boards/{board_id}")} <= CONTROL_ROUTES
    assert {("POST", "/api/boards/{board_id}/duplicate")} <= CONTROL_ROUTES
    assert {("POST", "/api/boards/import")} <= CONTROL_ROUTES
    assert {("DELETE", "/api/boards/{board_id}/events/{event_id}/record-links/{link_id}")} <= (
        CONTROL_ROUTES
    )
    assert {("DELETE", "/api/boards/{board_id}/posts/{post_id}/record-links/{link_id}")} <= (
        CONTROL_ROUTES
    )
