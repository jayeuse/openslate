"""Board lifecycle route steps for recorded sample phases."""

from __future__ import annotations

from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _mapped_id,
    _read_json,
    _request,
    _request_id,
    _request_object,
    _result,
)


def execute_board_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    kind = action.kind
    mapping_kind = (
        "phase_boards"
        if kind
        in {
            "board_create_purge_target",
            "board_archive_purge_target",
            "board_purge_preview",
            "board_purge",
        }
        else "boards"
    )
    if kind == "board_create_purge_target":
        values = action.values
        path = "/api/boards"
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=path,
            step="create_purge_board",
            expected=201,
            on_substep=on_substep,
            json_body={"name": values["display_name"], "description": values["description"]},
            primary_entity_type="boards",
            primary_entity_id=None,
            primary_action="create",
            expected_audit_rows=1,
        )
        body = _read_json(response, step="create_purge_board", request_id=_request_id(response))
        board_id = _id({"board": body.get("id")}, "board", label="Board", step="create_purge_board")
        if body.get("scope") != "project" or body.get("name") != values["display_name"]:
            raise SamplePhaseActionError(
                "Created purge Board did not match its plan", step="create_purge_board"
            )
        evidence[-1]["primary_entity_id"] = board_id
        client = _client(context, action.actor_key, step="record_mapping")
        from operations.sample_phase_actions import _record_mapping

        _record_mapping(context, client, mapping_kind, action.target_key, board_id, mappings)
        return _result(action, context, evidence, mappings)

    board_id = _mapped_id(context, mapping_kind, action.target_key, step=kind)
    if kind == "board_purge_preview":
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=f"/api/boards/{board_id}/purge/preview",
            step="preview_board_purge",
            expected=200,
            on_substep=on_substep,
            primary_entity_type=None,
            primary_entity_id=None,
            primary_action=None,
            expected_audit_rows=0,
        )
        body = _read_json(response, step="preview_board_purge", request_id=_request_id(response))
        impact = body.get("impact")
        if (
            not isinstance(body.get("token"), str)
            or body.get("confirmation_name") != board_id
            or not isinstance(impact, dict)
            or impact.get("target_id") != board_id
            or impact.get("operation") != "purge"
        ):
            raise SamplePhaseActionError(
                "Board purge preview did not match its target", step="preview_board_purge"
            )
        context.private_values.setdefault("board_purge_previews", {})[action.target_key] = {
            "token": body["token"],
            "confirmation_name": board_id,
        }
        return _result(action, context, evidence, mappings)
    if kind == "board_purge":
        preview = context.private_values.get("board_purge_previews", {}).get(action.target_key)
        if not isinstance(preview, dict):
            raise SamplePhaseActionError("Board purge has no matching preview", step="purge_board")
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=f"/api/boards/{board_id}/purge",
            step="purge_board",
            expected=200,
            on_substep=on_substep,
            json_body={
                "token": preview["token"],
                "confirmation_name": preview["confirmation_name"],
                "password": context.admin_password,
            },
            primary_entity_type="boards",
            primary_entity_id=board_id,
            primary_action="delete",
            expected_audit_rows=1,
        )
        body = _read_json(response, step="purge_board", request_id=_request_id(response))
        impact = body.get("impact")
        if (
            not isinstance(impact, dict)
            or impact.get("target_id") != board_id
            or impact.get("operation") != "purge"
        ):
            raise SamplePhaseActionError(
                "Board purge response did not match its target", step="purge_board"
            )
        context.private_values["board_purge_previews"].pop(action.target_key, None)
        return _result(action, context, evidence, mappings)

    path = f"/api/boards/{board_id}"
    actor_key = action.actor_key
    board = _request_object(
        action,
        context,
        evidence,
        actor_key=actor_key,
        path=path,
        step="read_board",
        on_substep=on_substep,
    )
    if board.get("id") != board_id or board.get("scope") != "project":
        raise SamplePhaseActionError(
            "Planned phase Board is not a project Board", step="read_board"
        )
    current_status = board.get("status")
    if kind == "refuse_board_archive":
        if current_status != "active":
            raise SamplePhaseActionError(
                "Planned Board refusal target is not active", step="read_board"
            )
        _request(
            action,
            context,
            evidence,
            actor_key=actor_key,
            method="POST",
            path=f"{path}/archive",
            step="archive_board_refused",
            expected=403,
            on_substep=on_substep,
            json_body={"revision": board.get("revision")},
            expected_detail=action.expected_detail,
            primary_entity_type=None,
            primary_entity_id=None,
            primary_action=None,
            expected_audit_rows=0,
        )
        return _result(action, context, evidence, mappings, outcome="refused")

    is_restore = kind == "board_restore"
    if is_restore and current_status != "archived":
        raise SamplePhaseActionError(
            "Planned Board restore target is not archived", step="read_board"
        )
    if not is_restore and current_status != "active":
        raise SamplePhaseActionError(
            "Planned Board archive target is not active", step="read_board"
        )
    step = (
        "restore_board"
        if is_restore
        else ("archive_purge_board" if kind == "board_archive_purge_target" else "archive_board")
    )
    response = _request(
        action,
        context,
        evidence,
        actor_key=actor_key,
        method="POST",
        path=f"{path}/{'restore' if is_restore else 'archive'}",
        step=step,
        expected=action.expected_status,
        on_substep=on_substep,
        json_body={"revision": board.get("revision")},
        primary_entity_type="boards",
        primary_entity_id=board_id,
        primary_action="update",
        expected_audit_rows=1,
    )
    updated = _read_json(response, step=step, request_id=_request_id(response))
    expected_status = "active" if is_restore else "archived"
    if updated.get("status") != expected_status or updated.get("id") != board_id:
        raise SamplePhaseActionError("Board lifecycle response did not match its plan", step=step)
    return _result(action, context, evidence, mappings)
