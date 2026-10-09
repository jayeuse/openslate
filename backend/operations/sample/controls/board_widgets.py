"""Widget-order and maintenance requests on disposable Board copies."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, cast

from app.systems.boards.widget_schemas import BoardWidgetMutationResponse, BoardWidgetResponse
from operations.sample.controls.board_execution import _board_id, _revision
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
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

BOARD_WIDGET_ROUTES = frozenset(
    {
        ("GET", "/api/boards/{board_id}/widgets"),
        ("PATCH", "/api/boards/{board_id}/widgets/{widget_id}"),
        ("POST", "/api/boards/{board_id}/widgets/{widget_id}/duplicate"),
        ("PUT", "/api/boards/{board_id}/widgets/order"),
        ("DELETE", "/api/boards/{board_id}/widgets/{widget_id}"),
    }
)
_SOURCE_FIELDS = {"name", "widget_type", "module_id", "config", "chart_id", "size", "pinned"}


def _widget_list(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    board_id: str,
    *,
    on_substep: PhaseSubstep | None,
) -> tuple[list[Mapping[str, Any]], int]:
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/boards/{board_id}/widgets",
        step="read_control_widgets",
        params={"limit": 100, "offset": 0, "sort_by": "position", "sort_order": "asc"},
        on_substep=on_substep,
    )
    rows = body.get("items")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        raise SamplePhaseActionError("Board widgets could not be read", step="read_control_widgets")
    revision = _revision(body, "board_revision", step="read_control_widgets")
    return cast(list[Mapping[str, Any]], rows), revision


def execute_board_widget_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = str(action.values.get("operation"))
    board_id = _board_id(action, context, step=operation)
    rows, revision = _widget_list(action, context, [], board_id, on_substep=on_substep)
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if not rows:
        raise SamplePhaseActionError("The copied Board has no widgets", step="read_control_widgets")
    ids = [
        _id({"widget": row.get("id")}, "widget", label="widget", step="read_control_widgets")
        for row in rows
    ]
    if operation == "widget_patch":
        widget_id, source = ids[0], rows[0]
        _record_mapping(
            context,
            _client(context, action.actor_key, step="record_widget_mapping"),
            "control_widgets",
            action.target_key,
            widget_id,
            mappings,
        )
        try:
            parsed = BoardWidgetResponse.model_validate_json(json.dumps(source), strict=True)
        except ValueError:
            raise SamplePhaseActionError(
                "The copied Board widget is invalid", step="patch_control_widget"
            ) from None
        if str(parsed.board_id) != board_id:
            raise SamplePhaseActionError(
                "The copied Board widget belongs to another Board", step="patch_control_widget"
            )
        new_name = action.values.get("name")
        if not isinstance(new_name, str) or not new_name:
            raise SamplePhaseActionError("Planned widget name is invalid", step=action.key)
        wanted = {**parsed.model_dump(mode="json", include=_SOURCE_FIELDS), "name": new_name}
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PATCH",
            path=f"/api/boards/{board_id}/widgets/{widget_id}",
            step="patch_control_widget",
            expected=200,
            on_substep=on_substep,
            json_body={"revision": revision, "widget": wanted},
            primary_entity_type="board_widgets",
            primary_entity_id=widget_id,
            primary_action="update",
            expected_audit_rows=1,
            related_entity_types=("boards",),
        )
        try:
            updated = BoardWidgetMutationResponse.model_validate_json(response.content, strict=True)
        except ValueError:
            raise SamplePhaseActionError(
                "Board widget update response was invalid", step="patch_control_widget"
            ) from None
        if (
            str(updated.widget.id) != widget_id
            or str(updated.widget.board_id) != board_id
            or updated.widget.position != parsed.position
            or updated.board_revision != revision + 1
            or updated.widget.model_dump(mode="json", include=_SOURCE_FIELDS) != wanted
        ):
            raise SamplePhaseActionError(
                "Board widget update did not match", step="patch_control_widget"
            )
    elif operation == "widget_duplicate":
        source_key = action.values.get("source_widget_key")
        if not isinstance(source_key, str):
            raise SamplePhaseActionError(
                "Planned source widget is invalid", step="duplicate_control_widget"
            )
        source_id = _mapped_id(
            context, "control_widgets", source_key, step="duplicate_control_widget"
        )
        source_row = next((row for row in rows if row.get("id") == source_id), None)
        try:
            parsed = BoardWidgetResponse.model_validate_json(json.dumps(source_row), strict=True)
        except ValueError:
            raise SamplePhaseActionError(
                "The source Board widget is invalid", step="duplicate_control_widget"
            ) from None
        if str(parsed.board_id) != board_id:
            raise SamplePhaseActionError(
                "The source widget belongs to another Board", step="duplicate_control_widget"
            )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=f"/api/boards/{board_id}/widgets/{source_id}/duplicate",
            step="duplicate_control_widget",
            expected=201,
            on_substep=on_substep,
            json_body={"revision": revision},
            primary_entity_type="board_widgets",
            primary_action="create",
            expected_audit_rows=1,
            related_entity_types=("boards",),
        )
        try:
            updated = BoardWidgetMutationResponse.model_validate_json(response.content, strict=True)
        except ValueError:
            raise SamplePhaseActionError(
                "Board widget duplicate response was invalid", step="duplicate_control_widget"
            ) from None
        widget_id = str(updated.widget.id)
        if (
            widget_id in ids
            or str(updated.widget.board_id) != board_id
            or updated.board_revision != revision + 1
            or updated.widget.model_dump(mode="json", include=_SOURCE_FIELDS)
            != parsed.model_dump(mode="json", include=_SOURCE_FIELDS)
        ):
            raise SamplePhaseActionError(
                "Board widget duplicate did not match its source", step="duplicate_control_widget"
            )
        evidence[-1]["primary_entity_id"] = widget_id
        _record_mapping(
            context,
            _client(context, action.actor_key, step="record_widget_mapping"),
            "control_widgets",
            action.target_key,
            widget_id,
            mappings,
        )
    elif operation == "widget_order":
        order = list(reversed(ids))
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PUT",
            path=f"/api/boards/{board_id}/widgets/order",
            step="reorder_control_widgets",
            expected=200,
            on_substep=on_substep,
            json_body={"revision": revision, "widget_ids": order},
            primary_entity_type="boards",
            primary_entity_id=board_id,
            primary_action="update",
            expected_audit_rows=1,
            related_entity_types=("board_widgets",),
        )
        body = _read_json(
            response, step="reorder_control_widgets", request_id=_request_id(response)
        )
        ordered = body.get("items")
        if not isinstance(ordered, list) or [row.get("id") for row in ordered] != order:
            raise SamplePhaseActionError(
                "Board widget order did not match", step="reorder_control_widgets"
            )
    else:
        widget_id = _mapped_id(
            context, "control_widgets", action.target_key, step="delete_control_widget"
        )
        if widget_id not in ids:
            raise SamplePhaseActionError(
                "Planned widget is no longer active", step="delete_control_widget"
            )
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"/api/boards/{board_id}/widgets/{widget_id}",
            step="delete_control_widget",
            expected=204,
            on_substep=on_substep,
            params={"revision": revision},
            primary_entity_type="board_widgets",
            primary_entity_id=widget_id,
            primary_action="delete",
            expected_audit_rows=1,
            related_entity_types=("boards",),
        )
    return _result(action, context, evidence, mappings, extra={"operation": operation})
