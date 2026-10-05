"""Read-only reviews of authored pack work through the frontend's APIs."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
from typing import Any, cast

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.board_files import board_author
from operations.sample.controls.boards import _board_manager_and_record
from operations.sample.controls.openview_queries import select_openview_target
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _request,
    _request_object,
    _result,
)
from operations.sample.population.boards import project_board_logical_id

CONTROL_ROUTES = frozenset(
    {
        ("GET", "/api/views/data-sources"),
        ("GET", "/api/views/data-sources/{module_id}/fields"),
        ("GET", "/api/modules/{module_id}/assignable-users"),
        ("GET", "/api/fields"),
        ("GET", "/api/reports/{report_id}/runs"),
        ("GET", "/api/reports/{report_id}/runs/{run_id}"),
        ("GET", "/api/boards/{board_id}/my-access"),
        ("GET", "/api/boards/{board_id}/access-preview"),
        ("GET", "/api/boards/{board_id}/preview-users"),
        ("GET", "/api/boards/{board_id}/activity"),
        ("GET", "/api/boards/{board_id}/events/occurrences"),
        ("GET", "/api/boards/{board_id}/events/mine"),
        ("GET", "/api/boards/{board_id}/post-authors"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/manage-state"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/revisions"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/revisions/{revision_id}"),
        ("GET", "/api/access/member-candidates"),
    }
)


def _action(
    operation: str,
    actor: str,
    target: str,
    checks: int,
    values: dict[str, PhaseJsonValue] | None = None,
) -> PhaseAction:
    return PhaseAction(
        key="control:" + operation.replace("_", "-"),
        phase="reorganization",
        kind="read_controls",
        actor_key=actor,
        target_key=target,
        values={"operation": operation, **(values or {})},
        expected_status=200,
        expected_detail=None,
        expected_end_state={"read_checks": checks},
    )


def _first_event_author(dataset: SampleDataset, department: str, board_name: str) -> str:
    return board_author(dataset, department, board_name, 1)


def plan_read_reviews(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    pack = dataset.organization
    if pack.phases is None:
        return ()
    department, module, module_manager = select_openview_target(dataset)
    name, board_department = pack.phases.existing_project_board
    board_key = project_board_logical_id(board_department, name)
    manager, _, _ = _board_manager_and_record(dataset)
    content = pack.content.data
    published_index = next(
        (i for i in range(content.posts_per_board) if content.post_states[i // 2] == "published"),
        None,
    )
    if published_index is None or content.events_per_board < 1:
        raise ValueError("Read reviews require an authored published post and event")
    return (
        _action("review_view_fields", module_manager, module.key, 4),
        _action("review_report_run", module_manager, f"department:{department}:report:01", 2),
        _action(
            "review_board_tools",
            "admin",
            board_key,
            9,
            {
                "preview_person_key": manager,
                "post_key": f"{board_key}:post:{published_index + 1:02d}",
            },
        ),
        _action(
            "review_my_events", _first_event_author(dataset, board_department, name), board_key, 1
        ),
        _action("review_member_candidates", "admin", "control:member-candidates", 1),
    )


def _rows(body: Mapping[str, Any], step: str) -> list[Mapping[str, Any]]:
    rows = body.get("items")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        raise SamplePhaseActionError("Review list response is invalid", step=step)
    return cast(list[Mapping[str, Any]], rows)


def execute_read_review(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_read_reviews(dataset):
        raise SamplePhaseActionError("Read review differs from the authored plan", step=action.key)
    evidence: list[dict[str, object]] = []
    checks = 0

    def read(path: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        nonlocal checks
        body = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=path,
            step=f"read:{checks + 1}",
            on_substep=on_substep,
            params=params,
        )
        checks += 1
        return body

    page = {"limit": 25, "offset": 0}
    operation = action.values["operation"]
    if operation == "review_view_fields":
        module_id = _mapped_id(context, "modules", action.target_key, step=action.key)
        sources = _rows(read("/api/views/data-sources", {"limit": 100, "offset": 0}), action.key)
        if not any(row.get("id") == module_id for row in sources):
            raise SamplePhaseActionError("Authored data source is unavailable", step=action.key)
        fields = _rows(
            read(
                f"/api/views/data-sources/{module_id}/fields",
                {
                    "limit": 100,
                    "offset": 0,
                },
            ),
            action.key,
        )
        if not fields or any(row.get("module_id") != module_id for row in fields):
            raise SamplePhaseActionError("Source fields do not match the module", step=action.key)
        _rows(read(f"/api/modules/{module_id}/assignable-users", page), action.key)
        _rows(
            read("/api/fields", {"module_id": module_id, "type": "relationship", "limit": 100}),
            action.key,
        )
    elif operation == "review_report_run":
        report_id = _mapped_id(context, "reports", action.target_key, step=action.key)
        base = f"/api/reports/{report_id}/runs"
        rows = _rows(read(base, page), action.key)
        if not rows or rows[0].get("report_id") != report_id:
            raise SamplePhaseActionError("Authored report output is unavailable", step=action.key)
        run_id = _id({"run": rows[0].get("id")}, "run", label="report output", step=action.key)
        detail = read(f"{base}/{run_id}")
        if detail.get("id") != run_id or detail.get("report_id") != report_id:
            raise SamplePhaseActionError(
                "Report output detail differs from selection", step=action.key
            )
    elif operation == "review_member_candidates":
        _rows(read("/api/access/member-candidates", page), action.key)
    else:
        board_id = _mapped_id(context, "boards", action.target_key, step=action.key)
        base = f"/api/boards/{board_id}"
        if operation == "review_my_events":
            rows = _rows(
                read(
                    f"{base}/events/mine",
                    {
                        **page,
                        "sort_by": "created_at",
                        "sort_order": "desc",
                        "archived": "active",
                    },
                ),
                action.key,
            )
            actor_id = _id(context.user_ids, action.actor_key, label="person", step=action.key)
            if not rows or any(
                row.get("board_id") != board_id or row.get("author_id") != actor_id for row in rows
            ):
                raise SamplePhaseActionError(
                    "Authored events differ from their person", step=action.key
                )
        else:
            mine = read(f"{base}/my-access")
            if mine.get("read") is not True or mine.get("manage") is not True:
                raise SamplePhaseActionError("Board review requires manage access", step=action.key)
            preview_key = str(action.values["preview_person_key"])
            user_id = _id(context.user_ids, preview_key, label="preview person", step=action.key)
            read(f"{base}/access-preview", {"user_id": user_id})
            _rows(
                read(f"{base}/preview-users", {**page, "sort_by": "username", "sort_order": "asc"}),
                action.key,
            )
            _rows(
                read(f"{base}/activity", {**page, "sort_by": "created_at", "sort_order": "desc"}),
                action.key,
            )
            start = dataset.anchor_date - timedelta(days=1)
            end = dataset.anchor_date + timedelta(days=30)
            _rows(
                read(
                    f"{base}/events/occurrences",
                    {
                        **page,
                        "window_start": start.isoformat(),
                        "window_end": end.isoformat(),
                    },
                ),
                action.key,
            )
            response = _request(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                method="GET",
                path=f"{base}/post-authors",
                step="post_authors",
                expected=200,
                on_substep=on_substep,
            )
            try:
                authors = response.json()
            except ValueError:
                authors = None
            if not isinstance(authors, list) or any(
                not isinstance(row, Mapping) for row in authors
            ):
                raise SamplePhaseActionError("Post author options are invalid", step=action.key)
            checks += 1
            post_id = _mapped_id(context, "posts", str(action.values["post_key"]), step=action.key)
            post = f"{base}/posts/{post_id}"
            state = read(f"{post}/manage-state")
            if state.get("id") != post_id:
                raise SamplePhaseActionError("Post state differs from selection", step=action.key)
            history = read(f"{post}/revisions")
            rows = _rows(history, action.key)
            if history.get("post_id") != post_id or not rows:
                raise SamplePhaseActionError(
                    "Authored post revision is unavailable", step=action.key
                )
            revision_id = _id(
                {"revision": rows[0].get("id")}, "revision", label="post revision", step=action.key
            )
            detail = read(f"{post}/revisions/{revision_id}")
            if detail.get("id") != revision_id or detail.get("post_id") != post_id:
                raise SamplePhaseActionError(
                    "Post revision detail differs from selection", step=action.key
                )
    if checks != action.expected_end_state["read_checks"]:
        raise SamplePhaseActionError("Read review did not complete its checks", step=action.key)
    return _result(action, context, evidence, [], extra={"read_checks": checks})
