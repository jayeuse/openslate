"""Missing UI reads must follow real object IDs and frontend query shapes.

Transport isolation lets us exercise missing/malformed/dependency responses;
the requested live runs own real authorization and database proof.
"""

from datetime import date
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample_boards import project_board_logical_id
from operations.sample_client import SampleClient
from operations.sample_control_boards import _board_manager_and_record
from operations.sample_control_openview_queries import select_openview_target
from operations.sample_control_read_reviews import execute_read_review, plan_read_reviews
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_packs.registry import get_pack
from operations.sample_phase_actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample_scenario import build_dataset


def _id(key: str) -> str:
    return str(uuid5(NAMESPACE_URL, "read-review:" + key))


@pytest.mark.parametrize("key", ("harbor", "school"))
def test_authored_reviews_follow_server_ids_and_frontend_queries(tmp_path: Path, key: str) -> None:
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(key))
    actions = plan_read_reviews(dataset)
    assert {action.values["operation"] for action in actions} == {
        "review_view_fields",
        "review_report_run",
        "review_board_tools",
        "review_my_events",
        "review_member_candidates",
    }
    assert sum(action.expected_end_state["read_checks"] for action in actions) == 17
    assert (
        next(a for a in actions if a.values["operation"] == "review_board_tools").actor_key
        == "admin"
    )
    post_key = str(
        next(a for a in actions if a.values["operation"] == "review_board_tools").values["post_key"]
    )
    assert (
        dataset.organization.content.data.post_states[(int(post_key.rsplit(":", 1)[1]) - 1) // 2]
        == "published"
    )
    department, module, manager = select_openview_target(dataset)
    phase = dataset.organization.phases
    assert phase is not None
    name, board_department = phase.existing_project_board
    board_key = project_board_logical_id(board_department, name)
    board_id, report_id, post_id = _id("board"), _id("report"), _id("post")
    revision_id, run_id = _id("revision"), _id("run")
    user_ids = {p.key: _id(p.key) for p in dataset.organization.actors.people}
    user_ids["admin"] = _id("admin")
    module_id = dataset.module_ids[module.key]
    mine_actor = next(a.actor_key for a in actions if a.values["operation"] == "review_my_events")
    requests: dict[str, dict[str, str]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=c; Path=/"})
        assert request.method == "GET" and not request.content
        requests[path] = dict(request.url.params)
        body: object = {"items": []}
        if path == "/api/views/data-sources":
            body = {"items": [{"id": module_id}]}
        elif path.endswith("/fields") and path.startswith("/api/views/"):
            body = {"items": [{"id": _id("field"), "module_id": module_id}]}
        elif path.endswith("/assignable-users") or path == "/api/access/member-candidates":
            body = {"items": [{"id": user_ids[manager]}]}
        elif path == f"/api/reports/{report_id}/runs":
            body = {"items": [{"id": run_id, "report_id": report_id}]}
        elif path == f"/api/reports/{report_id}/runs/{run_id}":
            body = {"id": run_id, "report_id": report_id}
        elif path.endswith("/my-access"):
            body = {"level": "manage", "read": True, "write": True, "manage": True}
        elif path.endswith("/access-preview"):
            body = {"level": "write", "read": True, "write": True, "manage": False}
        elif path.endswith("/post-authors"):
            body = [{"id": user_ids[mine_actor], "label": "Pack colleague"}]
        elif path.endswith("/manage-state"):
            body = {
                "id": post_id,
                "status": "published",
                "board_revision": 1,
                "post_revision": 1,
                "published_before": True,
            }
        elif path.endswith("/revisions"):
            body = {"post_id": post_id, "items": [{"id": revision_id, "post_id": post_id}]}
        elif path.endswith(f"/revisions/{revision_id}"):
            body = {"id": revision_id, "post_id": post_id}
        elif path.endswith("/events/mine"):
            body = {
                "items": [
                    {"id": _id("event"), "board_id": board_id, "author_id": user_ids[mine_actor]}
                ]
            }
        return httpx.Response(200, json=body)

    with SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("synthetic@example.test", "synthetic")
        context = PhaseExecutionContext(
            clients={key: client for key in user_ids},
            user_ids=user_ids,
            group_ids={},
            department_ids=dataset.department_ids,
            module_ids=dataset.module_ids,
            field_ids={},
            admin_password="synthetic",
            mappings={
                "boards": {board_key: board_id},
                "posts": {post_key: post_id},
                "reports": {f"department:{department}:report:01": report_id},
            },
        )
        for action in actions:
            result = execute_read_review(action, dataset, context)
            assert result["read_checks"] == action.expected_end_state["read_checks"]
            assert result["request_evidence"] == []
    assert len(requests) == 17
    assert requests["/api/views/data-sources"] == {"limit": "100", "offset": "0"}
    assert requests[f"/api/views/data-sources/{module_id}/fields"] == {
        "limit": "100",
        "offset": "0",
    }
    assert requests[f"/api/modules/{module_id}/assignable-users"] == {"limit": "25", "offset": "0"}
    assert requests["/api/fields"] == {
        "module_id": module_id,
        "type": "relationship",
        "limit": "100",
    }
    assert requests[f"/api/reports/{report_id}/runs"] == {"limit": "25", "offset": "0"}
    assert requests[f"/api/boards/{board_id}/preview-users"] == {
        "limit": "25",
        "offset": "0",
        "sort_by": "username",
        "sort_order": "asc",
    }
    assert requests[f"/api/boards/{board_id}/events/mine"] == {
        "limit": "25",
        "offset": "0",
        "sort_by": "created_at",
        "sort_order": "desc",
        "archived": "active",
    }
    assert requests[f"/api/boards/{board_id}/access-preview"]["user_id"] in user_ids.values()
    occurrence = requests[f"/api/boards/{board_id}/events/occurrences"]
    assert occurrence == {
        "window_start": "2026-10-01",
        "window_end": "2026-11-01",
        "limit": "25",
        "offset": "0",
    }


@pytest.mark.parametrize("problem", ("denied", "invalid_revision"))
def test_board_review_stops_when_access_or_selected_revision_is_invalid(
    tmp_path: Path,
    problem: str,
) -> None:
    dataset = build_dataset("small", 83, date(2026, 10, 2))
    phase = dataset.organization.phases
    assert phase is not None
    name, department = phase.existing_project_board
    board_key = project_board_logical_id(department, name)
    manager, _, _ = _board_manager_and_record(dataset)
    post_index = next(
        i
        for i in range(dataset.organization.content.data.posts_per_board)
        if dataset.organization.content.data.post_states[i // 2] == "published"
    )
    post_key = f"{board_key}:post:{post_index + 1:02d}"
    action = PhaseAction(
        key="control:review-board-tools",
        phase="reorganization",
        kind="read_controls",
        actor_key="admin",
        target_key=board_key,
        values={
            "operation": "review_board_tools",
            "preview_person_key": manager,
            "post_key": post_key,
        },
        expected_status=200,
        expected_detail=None,
        expected_end_state={"read_checks": 9},
    )
    post_id = _id("post")
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=c; Path=/"})
        if request.url.path.endswith("/my-access"):
            return httpx.Response(
                200, json={"read": True, "manage": True, "write": True, "level": "manage"}
            )
        if request.url.path.endswith("/access-preview"):
            return httpx.Response(
                403 if problem == "denied" else 200,
                json={"level": None, "read": False, "write": False, "manage": False},
            )
        if request.url.path.endswith("/post-authors"):
            return httpx.Response(200, json=[])
        if request.url.path.endswith("/manage-state"):
            return httpx.Response(200, json={"id": post_id})
        if request.url.path.endswith("/revisions"):
            return httpx.Response(
                200, json={"post_id": post_id, "items": [{"id": "invalid", "post_id": post_id}]}
            )
        return httpx.Response(200, json={"items": []})

    with SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("synthetic@example.test", "synthetic")
        user_ids = {p.key: _id(p.key) for p in dataset.organization.actors.people} | {
            "admin": _id("admin")
        }
        context = PhaseExecutionContext(
            clients={key: client for key in user_ids},
            user_ids=user_ids,
            group_ids={},
            department_ids=dataset.department_ids,
            module_ids=dataset.module_ids,
            field_ids={},
            admin_password="synthetic",
            mappings={"boards": {board_key: _id("board")}, "posts": {post_key: post_id}},
        )
        with pytest.raises(SamplePhaseActionError):
            execute_read_review(action, dataset, context)
    assert any(path.endswith("/access-preview") for path in paths)
    assert not any("/revisions/" in path for path in paths)
