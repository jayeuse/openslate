"""Missing UI reads must follow real object IDs and frontend query shapes.

Transport isolation lets us exercise missing/malformed/dependency responses;
the requested live runs own real authorization and database proof.
"""

from datetime import date
from pathlib import Path

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.actions import execute_control_action
from operations.sample.controls.boards import _board_manager_and_record
from operations.sample.controls.openview_queries import select_openview_target
from operations.sample.controls.read_reviews import execute_read_review, plan_read_reviews
from operations.sample.controls.request_verification import verify_request_evidence
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.population.boards import project_board_logical_id
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.sample_manage_wire import _id, _manage_run, _workspace_profile


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
        "review_workspace_appearance",
    }
    assert sum(action.expected_end_state["read_checks"] for action in actions) == 20
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
        if path == "/api/workspace/appearance":
            body = {"theme": "stockroom"}
        elif path == "/api/workspace":
            body = _workspace_profile(dataset)
        elif path == "/api/workspace/security/caller-ip":
            body = {"address": "127.0.0.1"}
        elif path == "/api/views/data-sources":
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
            body = {
                "items": [{"id": user_ids[mine_actor], "label": "Pack colleague"}],
                "pagination": {
                    "limit": 25,
                    "offset": 0,
                    "count": 1,
                    "total": 1,
                    "has_more": False,
                },
            }
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
    assert len(requests) == 20
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
    assert requests[f"/api/boards/{board_id}/post-authors"] == {"limit": "25", "offset": "0"}
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
            return httpx.Response(
                200,
                json={
                    "items": [],
                    "pagination": {
                        "limit": 25,
                        "offset": 0,
                        "count": 0,
                        "total": 0,
                        "has_more": False,
                    },
                },
            )
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


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_manage_controls_persist_safe_policy_and_reauthenticate_every_revoked_actor(
    tmp_path, pack_key
):
    dataset, actions, context, state = _manage_run(tmp_path, pack_key)
    baseline = dict(state["policy"])
    try:
        results = [execute_control_action(a, dataset, context) for a in actions]
        assert all(row["outcome"] == "completed" for row in results)
        assert {key: value for key, value in state["policy"].items() if key != "revision"} == {
            key: value for key, value in baseline.items() if key != "revision"
        }
        assert state["policy"]["revision"] == baseline["revision"] + 2
        update, restore = state["patches"]
        retention = ("session_retention_days", "security_event_retention_days")
        assert all(
            type(update[key]) is int and 1 <= update[key] <= 3650 and update[key] != baseline[key]
            for key in retention
        )
        assert update[retention[0]] != update[retention[1]]
        assert all(restore[key] == baseline[key] for key in retention)
        assert state["revoked"] is True
        # The pack administrator ends only pack-only sessions; the operator and the members
        # who joined the partner organization keep theirs and sign in again only if ended.
        revoked = set(context.clients) - {"admin"} - state["shared"]
        assert state["shared"] >= {"operator"} and len(state["shared"]) >= 2
        assert sorted(state["logins"][len(context.clients) :]) == sorted(revoked)
        for actor, client in context.clients.items():
            assert client.request("GET", "/api/auth/me").json()["id"] == context.user_ids[actor]
        issues, observed, seen_ids = [], {"control_requests_verified": 0}, set()
        manifest = {
            "actor_ids": {
                k: v for k, v in context.user_ids.items() if k not in {"admin", "operator"}
            },
            "operator_id": context.user_ids["operator"],
        }
        for action, result in zip(actions, results, strict=True):
            verify_request_evidence(
                dataset,
                manifest,
                action,
                result,
                manifest["actor_ids"],
                context.user_ids["admin"],
                seen_ids,
                observed,
                issues,
            )
        assert issues == []
        assert observed["control_requests_verified"] == 3 + len(revoked)
        contents = (tmp_path / "manage.jsonl").read_text()
        assert "Owned-Fixture-Password-123" not in contents
        assert all(c.email not in contents for c in context.private_values["credentials"].values())
    finally:
        for client in context.clients.values():
            client.close()


@pytest.mark.parametrize("address", ("127.0.0.1", "2001:db8::42"))
def test_workspace_review_compares_public_theme_and_validates_current_caller_ip(tmp_path, address):
    dataset = build_dataset("small", 83, date(2026, 10, 2))
    action = PhaseAction(
        "control:review-workspace-appearance",
        "reorganization",
        "read_controls",
        "admin",
        "control:workspace-appearance",
        {"operation": "review_workspace_appearance"},
        200,
        None,
        {"read_checks": 3},
    )
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path))
        bodies = {
            "/api/workspace/appearance": {"theme": "stockroom"},
            "/api/workspace": _workspace_profile(dataset),
            "/api/workspace/security/caller-ip": {"address": address},
        }
        return httpx.Response(
            200 if request.url.path in bodies else 404,
            json=bodies.get(request.url.path, {"detail": "Not Found"}),
        )

    with SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / "workspace.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        context = PhaseExecutionContext(
            {"admin": client}, {"admin": _id("admin")}, {}, {}, {}, {}, {}, "private"
        )
        result = execute_read_review(action, dataset, context)
    assert result["actor_id"] == _id("admin") and result["read_checks"] == 3
    assert result["request_evidence"] == []
    assert seen == [
        ("GET", "/api/workspace/appearance"),
        ("GET", "/api/workspace"),
        ("GET", "/api/workspace/security/caller-ip"),
    ]


@pytest.mark.parametrize(
    "problem,step",
    (
        ("public_extra", "workspace_appearance"),
        ("public_theme", "workspace_appearance"),
        ("theme_mismatch", "workspace_theme"),
        ("profile_identity", "workspace_theme"),
        ("caller_ip", "caller_ip"),
        ("caller_extra", "caller_ip"),
        ("caller_type", "caller_ip"),
        ("caller_denied", "read:3"),
    ),
)
def test_workspace_review_stops_at_the_invalid_dto_or_identity_boundary(tmp_path, problem, step):
    dataset = build_dataset("small", 83, date(2026, 10, 2))
    action = PhaseAction(
        "control:review-workspace-appearance",
        "reorganization",
        "read_controls",
        "admin",
        "control:workspace-appearance",
        {"operation": "review_workspace_appearance"},
        200,
        None,
        {"read_checks": 3},
    )

    def handler(request):
        appearance, profile, address = (
            {"theme": "stockroom"},
            _workspace_profile(dataset),
            {"address": "127.0.0.1"},
        )
        if problem == "public_extra":
            appearance["display_name"] = "Private profile"
        if problem == "public_theme":
            appearance["theme"] = "unrecognized"
        if problem == "theme_mismatch":
            profile["theme"] = "triplicate"
        if problem == "profile_identity":
            profile["display_name"] = "Other workspace"
        if problem == "caller_ip":
            address["address"] = "invalid-address"
        if problem == "caller_extra":
            address["other"] = "not-the-current-dto"
        if problem == "caller_type":
            address["address"] = 1
        bodies = {
            "/api/workspace/appearance": appearance,
            "/api/workspace": profile,
            "/api/workspace/security/caller-ip": address,
        }
        return httpx.Response(
            403 if problem == "caller_denied" and request.url.path.endswith("caller-ip") else 200,
            json=bodies[request.url.path],
        )

    with SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / "workspace.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        context = PhaseExecutionContext(
            {"admin": client}, {"admin": _id("admin")}, {}, {}, {}, {}, {}, "private"
        )
        with pytest.raises(SamplePhaseActionError) as failure:
            execute_read_review(action, dataset, context)
        assert failure.value.step == step
