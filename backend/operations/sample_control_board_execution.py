"""Authenticated Board copy, sharing, edit, and purge route actions."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx

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

BOARD_EXECUTION_ROUTES = frozenset(
    {
        ("POST", "/api/boards/{board_id}/archive"),
        ("POST", "/api/boards/{board_id}/purge/preview"),
        ("POST", "/api/boards/{board_id}/purge"),
    }
)


def _revision(row: Mapping[str, Any], key: str, *, step: str) -> int:
    value = row.get(key)
    if type(value) is not int or value < 1:
        raise SamplePhaseActionError("Board revision could not be read", step=step)
    return value


def _board_id(action: PhaseAction, context: PhaseExecutionContext, *, step: str) -> str:
    key = action.values.get("board_key", action.target_key)
    if not isinstance(key, str):
        raise SamplePhaseActionError("Planned Board target is invalid", step=step)
    return _mapped_id(context, "control_boards", key, step=step)


def _raw_configuration(
    action: PhaseAction,
    context: PhaseExecutionContext,
    source_id: str,
    *,
    on_substep: PhaseSubstep | None,
) -> bytes:
    step = "export_board_configuration"
    if on_substep:
        on_substep(step)
    response = _client(context, action.actor_key, step=step).request(
        "GET", f"/api/boards/{source_id}/configuration"
    )
    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if (
        response.status_code != 200
        or content_type != "application/json"
        or response.headers.get("Content-Disposition")
        != 'attachment; filename="board-configuration.json"'
        or not 0 < len(response.content) <= 1024 * 1024
    ):
        raise SamplePhaseActionError(
            "Board configuration could not be exported",
            step=step,
            status_code=response.status_code,
            request_id=_request_id(response),
        )
    try:
        bundle = json.loads(response.content)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SamplePhaseActionError("Board configuration is invalid", step=step) from None
    if (
        not isinstance(bundle, dict)
        or bundle.get("kind") != "openslate-board"
        or bundle.get("version") != 3
        or not isinstance(bundle.get("configuration"), dict)
    ):
        raise SamplePhaseActionError("Board configuration is invalid", step=step)
    return response.content


def _request_bytes(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    path: str,
    content: bytes,
    on_substep: PhaseSubstep | None,
) -> httpx.Response:
    step = "import_board"
    if on_substep:
        on_substep(step)
    actor_id = _id(context.user_ids, action.actor_key, label="user", step=step)
    response = _client(context, action.actor_key, step=step).request(
        "POST",
        path,
        content=content,
        headers={"Content-Type": "application/octet-stream"},
    )
    request_id = _request_id(response)
    evidence.append(
        {
            "step": step,
            "actor_key": action.actor_key,
            "actor_id": actor_id,
            "method": "POST",
            "path": path,
            "expected_status": 201,
            "status_code": response.status_code,
            "request_id": request_id,
            "primary_entity_type": "boards",
            "primary_entity_id": None,
            "primary_action": "create",
            "expected_audit_rows": 1,
            "related_entity_types": ["board_widgets"],
        }
    )
    if response.status_code != 201:
        raise SamplePhaseActionError(
            f"Planned phase request returned HTTP {response.status_code}",
            step=step,
            status_code=response.status_code,
            request_id=request_id,
        )
    if request_id is None:
        raise SamplePhaseActionError("Board import has no request ID", step=step)
    return response


def _create_copy(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
    imported: bool,
) -> dict[str, object]:
    source_key = action.values.get("source_board_key")
    if not isinstance(source_key, str):
        raise SamplePhaseActionError("Planned Board source is invalid", step="create_board_copy")
    source_id = _mapped_id(context, "boards", source_key, step="create_board_copy")
    if imported:
        payload = _raw_configuration(action, context, source_id, on_substep=on_substep)
        response = _request_bytes(
            action,
            context,
            evidence,
            path="/api/boards/import",
            content=payload,
            on_substep=on_substep,
        )
        step = "import_board"
    else:
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=f"/api/boards/{source_id}/duplicate",
            step="duplicate_board",
            expected=201,
            on_substep=on_substep,
            primary_entity_type="boards",
            primary_action="create",
            expected_audit_rows=1,
            related_entity_types=("board_widgets",),
        )
        step = "duplicate_board"
    body = _read_json(response, step=step, request_id=_request_id(response))
    board_id = _id({"board": body.get("id")}, "board", label="Board", step=step)
    if body.get("scope") != "project" or body.get("status") != "active":
        raise SamplePhaseActionError("Board copy did not match its plan", step=step)
    evidence[-1]["primary_entity_id"] = board_id
    _record_mapping(
        context,
        _client(context, action.actor_key, step="record_board_mapping"),
        "control_boards",
        action.target_key,
        board_id,
        mappings,
    )
    return _result(
        action, context, evidence, mappings, extra={"operation": action.values["operation"]}
    )


def _share_copy(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    board_id = _board_id(action, context, step="share_board_copy")
    current = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/boards/{board_id}/groups",
        step="read_control_board_groups",
        on_substep=on_substep,
    )
    revision = _revision(current, "revision", step="read_control_board_groups")
    raw_groups = action.values.get("groups")
    if not isinstance(raw_groups, list):
        raise SamplePhaseActionError(
            "Planned Board groups are invalid", step="replace_board_groups"
        )
    groups: list[dict[str, str]] = []
    for row in raw_groups:
        if not isinstance(row, Mapping) or not isinstance(row.get("group_key"), str):
            raise SamplePhaseActionError(
                "Planned Board groups are invalid", step="replace_board_groups"
            )
        level = row.get("level")
        if level not in {"read", "write", "manage"}:
            raise SamplePhaseActionError(
                "Planned Board groups are invalid", step="replace_board_groups"
            )
        groups.append(
            {
                "group_id": _mapped_id(
                    context, "group", str(row["group_key"]), step="replace_board_groups"
                ),
                "level": str(level),
            }
        )
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="PUT",
        path=f"/api/boards/{board_id}/groups",
        step="replace_board_groups",
        expected=200,
        on_substep=on_substep,
        json_body={"revision": revision, "groups": groups},
        primary_entity_type="boards",
        primary_entity_id=board_id,
        primary_action="update",
        expected_audit_rows=1,
        related_entity_types=("board_groups",),
    )
    updated = _read_json(response, step="replace_board_groups", request_id=_request_id(response))
    actual = updated.get("groups")
    if (
        not isinstance(actual, list)
        or any(not isinstance(row, Mapping) for row in actual)
        or updated.get("board_id") != board_id
    ):
        raise SamplePhaseActionError(
            "Board groups did not match their plan", step="replace_board_groups"
        )

    def to_pair(row: Mapping[str, Any]) -> tuple[object, object]:
        return row.get("group_id"), row.get("level")

    if sorted(map(to_pair, actual)) != sorted(map(to_pair, groups)):
        raise SamplePhaseActionError(
            "Board groups did not match their plan", step="replace_board_groups"
        )
    return _result(action, context, evidence, mappings, extra={"operation": "board_share"})


def _patch_copy(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    board_id = _board_id(action, context, step="patch_board_copy")
    path = f"/api/boards/{board_id}"
    current = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=path,
        step="read_control_board",
        on_substep=on_substep,
    )
    revision = _revision(current, "revision", step="read_control_board")
    name = action.values.get("name")
    if current.get("status") != "active" or not isinstance(name, str):
        raise SamplePhaseActionError("Board patch target is invalid", step="read_control_board")
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="PATCH",
        path=path,
        step="patch_control_board",
        expected=200,
        on_substep=on_substep,
        json_body={"revision": revision, "name": name},
        primary_entity_type="boards",
        primary_entity_id=board_id,
        primary_action="update",
        expected_audit_rows=1,
    )
    updated = _read_json(response, step="patch_control_board", request_id=_request_id(response))
    if updated.get("name") != name or updated.get("revision") != revision + 1:
        raise SamplePhaseActionError(
            "Board update did not match its plan", step="patch_control_board"
        )
    return _result(action, context, evidence, mappings, extra={"operation": "board_patch"})


def _purge_copy(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    board_id: str,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    path = f"/api/boards/{board_id}"
    board = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=path,
        step="read_control_purge_board",
        on_substep=on_substep,
    )
    revision = _revision(board, "revision", step="read_control_purge_board")
    if board.get("scope") != "project" or board.get("status") != "active":
        raise SamplePhaseActionError("Control Board is not active", step="read_control_purge_board")
    archived = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=f"{path}/archive",
        step="archive_control_board",
        expected=200,
        on_substep=on_substep,
        json_body={"revision": revision},
        primary_entity_type="boards",
        primary_entity_id=board_id,
        primary_action="update",
        expected_audit_rows=1,
    )
    archived_body = _read_json(
        archived, step="archive_control_board", request_id=_request_id(archived)
    )
    if archived_body.get("status") != "archived":
        raise SamplePhaseActionError("Control Board was not archived", step="archive_control_board")
    preview_response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=f"{path}/purge/preview",
        step="preview_control_board_purge",
        expected=200,
        on_substep=on_substep,
        primary_entity_type=None,
        primary_entity_id=None,
        primary_action=None,
        expected_audit_rows=0,
    )
    preview = _read_json(
        preview_response,
        step="preview_control_board_purge",
        request_id=_request_id(preview_response),
    )
    impact = preview.get("impact")
    token, name = preview.get("token"), preview.get("confirmation_name")
    if (
        not isinstance(token, str)
        or not token
        or name != board_id
        or not isinstance(impact, Mapping)
    ):
        raise SamplePhaseActionError(
            "Control Board purge preview did not match", step="preview_control_board_purge"
        )
    if impact.get("target_id") != board_id or impact.get("operation") != "purge":
        raise SamplePhaseActionError(
            "Control Board purge preview did not match", step="preview_control_board_purge"
        )
    private = context.private_values.setdefault("control_board_purges", {})
    private[action.target_key] = {"token": token, "confirmation_name": name}
    request = private[action.target_key]
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=f"{path}/purge",
        step="purge_control_board",
        expected=200,
        on_substep=on_substep,
        json_body={
            "token": request["token"],
            "confirmation_name": request["confirmation_name"],
            "password": context.admin_password,
        },
        primary_entity_type="boards",
        primary_entity_id=board_id,
        primary_action="delete",
        expected_audit_rows=1,
    )
    result = _read_json(response, step="purge_control_board", request_id=_request_id(response))
    impact = result.get("impact")
    if (
        not isinstance(impact, Mapping)
        or impact.get("target_id") != board_id
        or impact.get("operation") != "purge"
    ):
        raise SamplePhaseActionError(
            "Control Board purge response did not match", step="purge_control_board"
        )
    private.pop(action.target_key, None)
    return _result(
        action, context, evidence, mappings, extra={"operation": action.values["operation"]}
    )


def execute_board_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    operation = action.values.get("operation")
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if operation == "board_duplicate":
        return _create_copy(
            action, context, evidence, mappings, on_substep=on_substep, imported=False
        )
    if operation == "board_import":
        return _create_copy(
            action, context, evidence, mappings, on_substep=on_substep, imported=True
        )
    if operation == "board_share":
        return _share_copy(action, context, evidence, mappings, on_substep=on_substep)
    if operation == "board_patch":
        return _patch_copy(action, context, evidence, mappings, on_substep=on_substep)
    board_id = _board_id(action, context, step=str(operation))
    return _purge_copy(action, context, evidence, mappings, board_id, on_substep=on_substep)
