"""Create and remove record links on temporary Board posts and events."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample_control_board_content import _board, _revision, _string
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

BOARD_LINK_ROUTES = frozenset(
    {
        ("GET", "/api/boards/{board_id}/posts/{post_id}/record-links"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/record-links"),
        ("DELETE", "/api/boards/{board_id}/posts/{post_id}/record-links/{link_id}"),
        ("GET", "/api/boards/{board_id}/events/{event_id}/record-links"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/record-links"),
        ("DELETE", "/api/boards/{board_id}/events/{event_id}/record-links/{link_id}"),
    }
)


def _record_link(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    post: bool,
    create: bool,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = str(action.values.get("operation"))
    board_key = _string(action.values, "board_key", step=operation)
    content_key = _string(action.values, "content_key", step=operation)
    board_id, board_revision = _board(
        action, context, evidence, board_key=board_key, on_substep=on_substep
    )
    kind, content_id = (
        ("post", _mapped_id(context, "control_posts", content_key, step=operation))
        if post
        else ("event", _mapped_id(context, "control_events", content_key, step=operation))
    )
    content_revision_key = "post_revision" if post else "revision"
    view = "draft" if post else None
    path = f"/api/boards/{board_id}/{kind}s/{content_id}/record-links"
    query = {"limit": 20, "offset": 0, **({"view": view} if view else {})}
    current = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/boards/{board_id}/{kind}s/{content_id}",
        step="read_link_target",
        params={"view": view} if view else None,
        on_substep=on_substep,
    )
    content_revision = _revision(current, content_revision_key, step="read_link_target")
    if create:
        record_key = _string(action.values, "record_key", step=operation)
        record_id = _mapped_id(context, "record", record_key, step=operation)
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=path,
            step=f"create_{kind}_record_link",
            expected=201,
            on_substep=on_substep,
            json_body={
                "record_id": record_id,
                "board_revision": board_revision,
                "content_revision": content_revision,
            },
            primary_entity_type="board_record_links",
            primary_entity_id=None,
            primary_action="create",
            expected_audit_rows=1,
            related_entity_types=("boards", "board_posts" if post else "board_events"),
        )
        body = _read_json(
            response, step=f"create_{kind}_record_link", request_id=_request_id(response)
        )
        link_id = _id({"link": body.get("id")}, "link", label="Record link", step=operation)
        if body.get("record_id") != record_id or body.get("available") is not True:
            raise SamplePhaseActionError("Board Record link did not match", step=operation)
        evidence[-1]["primary_entity_id"] = link_id
        _record_mapping(
            context,
            _client(context, action.actor_key, step="record_link_mapping"),
            "control_links",
            action.target_key,
            link_id,
            mappings,
        )
    else:
        link_id = _mapped_id(context, "control_links", action.target_key, step=operation)
        listed = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=path,
            step="list_control_record_links",
            params=query,
            on_substep=on_substep,
        )
        rows = listed.get("items")
        if not isinstance(rows, list) or not any(
            isinstance(row, Mapping) and row.get("id") == link_id for row in rows
        ):
            raise SamplePhaseActionError(
                "Planned Board Record link is not active", step="list_control_record_links"
            )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"{path}/{link_id}",
            step=f"delete_{kind}_record_link",
            expected=204,
            on_substep=on_substep,
            json_body={"board_revision": board_revision, "content_revision": content_revision},
            primary_entity_type="board_record_links",
            primary_entity_id=link_id,
            primary_action="delete",
            expected_audit_rows=1,
            related_entity_types=("boards", "board_posts" if post else "board_events"),
        )
        del response
    return _result(action, context, evidence, mappings, extra={"operation": operation})


def execute_board_record_link_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = action.values.get("operation")
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if operation in {"post_record_link_create", "post_record_link_delete"}:
        return _record_link(
            action,
            context,
            evidence,
            mappings,
            post=True,
            create=operation.endswith("create"),
            on_substep=on_substep,
        )
    if operation in {"event_record_link_create", "event_record_link_delete"}:
        return _record_link(
            action,
            context,
            evidence,
            mappings,
            post=False,
            create=operation.endswith("create"),
            on_substep=on_substep,
        )
    raise SamplePhaseActionError("Unsupported Board Record link action", step=action.key)
