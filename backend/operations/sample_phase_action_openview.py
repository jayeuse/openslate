"""OpenView archive and restore route steps for recorded sample phases."""

from __future__ import annotations

from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _mapped_id,
    _read_json,
    _request,
    _request_id,
    _request_object,
    _result,
)


def execute_openview_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    resource = str(action.values.get("resource_kind", ""))
    category = {"view": "views", "dashboard": "dashboards", "report": "reports"}.get(resource)
    if category is None:
        raise SamplePhaseActionError("Planned OpenView resource type is invalid", step=action.key)
    entity_type = {"view": "saved_views", "dashboard": "dashboards", "report": "reports"}[resource]
    item_id = _mapped_id(context, category, action.target_key, step="read_openview_item")
    path = f"/api/{category}/{item_id}"
    item = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=path,
        step="read_openview_item",
        on_substep=on_substep,
    )
    if item.get("id") != item_id or type(item.get("revision")) is not int:
        raise SamplePhaseActionError(
            "OpenView revision could not be read", step="read_openview_item"
        )
    restoring = action.kind == "openview_restore"
    if bool(item.get("is_deleted")) != restoring:
        raise SamplePhaseActionError(
            "OpenView item is not in the planned lifecycle state", step="read_openview_item"
        )
    if restoring:
        step = "restore_openview_item"
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path=f"{path}/restore",
            step=step,
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={"revision": item["revision"]},
            primary_entity_type=entity_type,
            primary_entity_id=item_id,
            primary_action="update",
            expected_audit_rows=1,
        )
        body = _read_json(response, step=step, request_id=_request_id(response))
        if body.get("is_deleted") is not False:
            raise SamplePhaseActionError("OpenView restore response remained archived", step=step)
    else:
        step = "archive_openview_item"
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=path,
            params={"revision": item["revision"]},
            step=step,
            expected=204,
            on_substep=on_substep,
            primary_entity_type=entity_type,
            primary_entity_id=item_id,
            primary_action="delete",
            expected_audit_rows=1,
        )
    return _result(action, context, evidence, [])
