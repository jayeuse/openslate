"""Post and Event control requests for temporary Board copies."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from operations.sample_blueprint import SampleDataset
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _request_object,
    _result,
)

BOARD_CONTENT_ROUTES = frozenset(
    {
        ("GET", "/api/boards/{board_id}/posts"),
        ("POST", "/api/boards/{board_id}/posts"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}"),
        ("PATCH", "/api/boards/{board_id}/posts/{post_id}"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/publish"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/unpublish"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/restore"),
        ("DELETE", "/api/boards/{board_id}/posts/{post_id}"),
        ("GET", "/api/boards/{board_id}/events"),
        ("POST", "/api/boards/{board_id}/events"),
        ("GET", "/api/boards/{board_id}/events/{event_id}"),
        ("PATCH", "/api/boards/{board_id}/events/{event_id}"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/archive"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/restore"),
        ("DELETE", "/api/boards/{board_id}/events/{event_id}"),
    }
)


def _string(values: Mapping[str, Any], key: str, *, step: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value:
        raise SamplePhaseActionError("Planned Board content is invalid", step=step)
    return value


def _revision(body: Mapping[str, Any], key: str, *, step: str) -> int:
    value = body.get(key)
    if type(value) is not int or value < 1:
        raise SamplePhaseActionError("Board content revision could not be read", step=step)
    return value


def _board(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    board_key: str,
    on_substep: PhaseSubstep | None,
) -> tuple[str, int]:
    board_id = _mapped_id(context, "control_boards", board_key, step="read_control_board")
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/boards/{board_id}",
        step="read_control_board",
        on_substep=on_substep,
    )
    return board_id, _revision(body, "revision", step="read_control_board")


def _post(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    board_id: str,
    post_key: str,
    view: str,
    on_substep: PhaseSubstep | None,
) -> tuple[str, int, Mapping[str, Any]]:
    post_id = _mapped_id(context, "control_posts", post_key, step="read_control_post")
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/boards/{board_id}/posts/{post_id}",
        step="read_control_post",
        params={"view": view},
        on_substep=on_substep,
    )
    if body.get("id") != post_id or body.get("board_id") != board_id:
        raise SamplePhaseActionError(
            "Planned Board post could not be read", step="read_control_post"
        )
    return post_id, _revision(body, "post_revision", step="read_control_post"), body


def _event(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    board_id: str,
    event_key: str,
    on_substep: PhaseSubstep | None,
) -> tuple[str, int]:
    event_id = _mapped_id(context, "control_events", event_key, step="read_control_event")
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/boards/{board_id}/events/{event_id}",
        step="read_control_event",
        on_substep=on_substep,
    )
    if body.get("id") != event_id or body.get("board_id") != board_id:
        raise SamplePhaseActionError(
            "Planned Board event could not be read", step="read_control_event"
        )
    return event_id, _revision(body, "revision", step="read_control_event")


def _write_post(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = str(action.values.get("operation"))
    board_key = _string(action.values, "board_key", step=operation)
    board_id, board_revision = _board(
        action, context, evidence, board_key=board_key, on_substep=on_substep
    )
    is_create = operation == "post_create"
    post_key = action.target_key
    post_id: str | None = None
    post_revision: int | None = None
    if not is_create:
        view = (
            "archive"
            if operation == "post_restore"
            else "editable"
            if operation in {"post_unpublish", "post_delete"}
            else "draft"
        )
        post_id, post_revision, _ = _post(
            action,
            context,
            evidence,
            board_id=board_id,
            post_key=post_key,
            view=view,
            on_substep=on_substep,
        )
    path = f"/api/boards/{board_id}/posts"
    body: dict[str, Any] = {"board_revision": board_revision}
    if is_create:
        path = f"{path}"
        body.update(
            {
                key: action.values.get(key)
                for key in ("title", "body", "links", "expires_at", "pinned")
            }
        )
        method, expected, step = "POST", 201, "create_control_post"
        entity, primary = "board_posts", "create"
    elif operation == "post_patch":
        assert post_id is not None and post_revision is not None
        path, method, expected, step = f"{path}/{post_id}", "PATCH", 200, "patch_control_post"
        body.update(
            {
                "post_revision": post_revision,
                "title": action.values["title"],
                "body": action.values["body"],
            }
        )
        entity, primary = "board_posts", "update"
    else:
        assert post_id is not None and post_revision is not None
        body["post_revision"] = post_revision
        if operation == "post_publish":
            path, method, expected, step = (
                f"{path}/{post_id}/publish",
                "POST",
                200,
                "publish_control_post",
            )
            body["publication_key"] = action.values.get("publication_key")
            entity, primary = "board_post_revisions", "create"
        elif operation == "post_unpublish":
            path, method, expected, step = (
                f"{path}/{post_id}/unpublish",
                "POST",
                200,
                "unpublish_control_post",
            )
            entity, primary = "board_posts", "update"
        elif operation == "post_delete":
            path, method, expected, step = f"{path}/{post_id}", "DELETE", 200, "delete_control_post"
            entity, primary = "board_posts", "update"
        else:
            path, method, expected, step = (
                f"{path}/{post_id}/restore",
                "POST",
                200,
                "restore_control_post",
            )
            entity, primary = "board_posts", "update"
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method=method,
        path=path,
        step=step,
        expected=expected,
        on_substep=on_substep,
        json_body=body,
        primary_entity_type=entity,
        primary_entity_id=post_id,
        primary_action=primary,
        expected_audit_rows=1,
        related_entity_types=("boards",),
    )
    result_body = _read_json(response, step=step, request_id=_request_id(response))
    if is_create:
        post_id = _id({"post": result_body.get("id")}, "post", label="post", step=step)
        _record_mapping(
            context,
            _client(context, action.actor_key, step="record_post_mapping"),
            "control_posts",
            post_key,
            post_id,
            mappings,
        )
        evidence[-1]["primary_entity_id"] = post_id
        page = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=f"/api/boards/{board_id}/posts",
            step="list_control_posts",
            params={
                "view": "draft",
                "limit": 25,
                "offset": 0,
                "sort_by": "updated_at",
                "sort_order": "desc",
            },
            on_substep=on_substep,
        )
        items = page.get("items")
        if not isinstance(items, list) or not any(
            isinstance(row, Mapping) and row.get("id") == post_id for row in items
        ):
            raise SamplePhaseActionError(
                "Created Board post is missing from its list", step="list_control_posts"
            )
    elif operation == "post_publish":
        evidence[-1]["primary_entity_id"] = _id(
            {"revision": result_body.get("id")}, "revision", label="post revision", step=step
        )
        if result_body.get("post_id") != post_id:
            raise SamplePhaseActionError("Published Board post did not match", step=step)
    elif operation == "post_delete" and result_body.get("outcome") != "archived":
        raise SamplePhaseActionError("Published Board post was not archived", step=step)
    elif result_body.get("id") != post_id:
        raise SamplePhaseActionError("Board post response did not match", step=step)
    return _result(action, context, evidence, mappings, extra={"operation": operation})


def _write_event(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = str(action.values.get("operation"))
    board_key = _string(action.values, "board_key", step=operation)
    board_id, board_revision = _board(
        action, context, evidence, board_key=board_key, on_substep=on_substep
    )
    is_create = operation == "event_create"
    event_id: str | None = None
    event_revision: int | None = None
    if not is_create:
        event_id, event_revision = _event(
            action,
            context,
            evidence,
            board_id=board_id,
            event_key=action.target_key,
            on_substep=on_substep,
        )
    path = f"/api/boards/{board_id}/events"
    body: dict[str, Any] = {"board_revision": board_revision}
    if is_create:
        body.update(
            {
                "title": action.values["title"],
                "details": action.values["details"],
                "location": action.values["location"],
                "links": action.values["links"],
                "all_day": True,
                "start_date": action.values["start_date"],
                "end_date": action.values["end_date"],
                "timezone_name": action.values["timezone_name"],
                "recurrence": "none",
                "reminders": [],
            }
        )
        method, expected, step = "POST", 201, "create_control_event"
        entity, primary = "board_events", "create"
    else:
        assert event_id is not None and event_revision is not None
        body["event_revision"] = event_revision
        if operation == "event_patch":
            path, method, expected, step = f"{path}/{event_id}", "PATCH", 200, "patch_control_event"
            body["details"] = action.values["details"]
            entity, primary = "board_events", "update"
        elif operation in {"event_archive", "event_restore"}:
            lifecycle = "archive" if operation == "event_archive" else "restore"
            path, method, expected, step = (
                f"{path}/{event_id}/{lifecycle}",
                "POST",
                200,
                f"{lifecycle}_control_event",
            )
            entity, primary = "board_events", "update"
        else:
            path, method, expected, step = (
                f"{path}/{event_id}",
                "DELETE",
                204,
                "delete_control_event",
            )
            entity, primary = "board_events", "delete"
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method=method,
        path=path,
        step=step,
        expected=expected,
        on_substep=on_substep,
        json_body=body if method != "DELETE" or operation == "event_delete" else None,
        primary_entity_type=entity,
        primary_entity_id=event_id,
        primary_action=primary,
        expected_audit_rows=1,
        related_entity_types=("boards",),
    )
    if not is_create and operation == "event_delete":
        return _result(action, context, evidence, mappings, extra={"operation": operation})
    result_body = _read_json(response, step=step, request_id=_request_id(response))
    if is_create:
        event_id = _id({"event": result_body.get("id")}, "event", label="event", step=step)
        evidence[-1]["primary_entity_id"] = event_id
        _record_mapping(
            context,
            _client(context, action.actor_key, step="record_event_mapping"),
            "control_events",
            action.target_key,
            event_id,
            mappings,
        )
        page = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=f"/api/boards/{board_id}/events",
            step="list_control_events",
            params={
                "limit": 25,
                "offset": 0,
                "sort_by": "created_at",
                "sort_order": "desc",
                "archived": "active",
            },
            on_substep=on_substep,
        )
        items = page.get("items")
        if not isinstance(items, list) or not any(
            isinstance(row, Mapping) and row.get("id") == event_id for row in items
        ):
            raise SamplePhaseActionError(
                "Created Board event is missing from its list", step="list_control_events"
            )
    elif result_body.get("id") != event_id:
        raise SamplePhaseActionError("Board event response did not match", step=step)
    return _result(action, context, evidence, mappings, extra={"operation": operation})


def execute_board_content_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    del dataset
    operation = action.values.get("operation")
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if operation in {
        "post_create",
        "post_patch",
        "post_publish",
        "post_unpublish",
        "post_delete",
        "post_restore",
    }:
        return _write_post(action, context, evidence, mappings, on_substep=on_substep)
    if operation in {
        "event_create",
        "event_patch",
        "event_archive",
        "event_restore",
        "event_delete",
    }:
        return _write_event(action, context, evidence, mappings, on_substep=on_substep)
    raise SamplePhaseActionError("Unsupported Board content action", step=action.key)
