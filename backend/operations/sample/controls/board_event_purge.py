"""Administrator-confirmed disposal of an event on the owned temporary Board."""

from __future__ import annotations

from pydantic import ValidationError

from app.systems.sandbox.lifecycle.schemas import (
    LifecycleMutationResponse,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
)
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
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


def execute_event_purge(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    evidence: list[dict[str, object]] = []
    if action.actor_key != "admin" or action.values.get("board_key") != "control:board":
        raise SamplePhaseActionError(
            "Event purge requires the owned admin control", step=action.key
        )
    board_id = _mapped_id(context, "control_boards", "control:board", step=action.key)
    event_id = _mapped_id(context, "control_events", action.target_key, step=action.key)
    board_path, path = f"/api/boards/{board_id}", f"/api/boards/{board_id}/events/{event_id}"
    board = _request_object(
        action,
        context,
        evidence,
        actor_key="admin",
        path=board_path,
        step="read_control_purge_board",
        on_substep=on_substep,
    )
    revision = board.get("revision")
    if board.get("id") != board_id or type(revision) is not int or revision < 1:
        raise SamplePhaseActionError("Event purge Board response mismatch", step=action.key)
    event = _request_object(
        action,
        context,
        evidence,
        actor_key="admin",
        path=path,
        step="read_control_purge_event",
        on_substep=on_substep,
    )
    if (
        event.get("id") != event_id
        or event.get("board_id") != board_id
        or event.get("archived") is not True
    ):
        raise SamplePhaseActionError(
            "Event purge target is not the archived control", step=action.key
        )
    preview_step = "preview_control_event_purge"
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="POST",
        path=path + "/purge/preview",
        step=preview_step,
        expected=200,
        on_substep=on_substep,
    )
    try:
        preview = LifecyclePurgePreviewResponse.model_validate(
            _read_json(response, step=preview_step, request_id=_request_id(response))
        )
        payload = LifecyclePurgeRequest(
            token=preview.token,
            confirmation_name=preview.confirmation_name,
            password=context.admin_password,
        )
    except ValidationError:
        raise SamplePhaseActionError("Event purge preview is invalid", step=preview_step) from None
    if (
        preview.impact.target_type != "board_event"
        or str(preview.impact.target_id) != event_id
        or preview.impact.operation != "purge"
        or preview.impact.blockers
    ):
        raise SamplePhaseActionError(
            "Event purge preview did not match its target", step=preview_step
        )
    purge_step = "purge_control_event"
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="POST",
        path=path + "/purge",
        step=purge_step,
        expected=200,
        on_substep=on_substep,
        json_body=payload.model_dump(mode="json"),
    )
    try:
        mutation = LifecycleMutationResponse.model_validate(
            _read_json(response, step=purge_step, request_id=_request_id(response))
        )
    except ValidationError:
        raise SamplePhaseActionError("Event purge result is invalid", step=purge_step) from None
    if (
        mutation.impact.target_type != "board_event"
        or str(mutation.impact.target_id) != event_id
        or mutation.impact.operation != "purge"
        or mutation.operation_id is None
    ):
        raise SamplePhaseActionError("Event purge result did not match its target", step=purge_step)
    _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="GET",
        path=path,
        step="read_purged_control_event",
        expected=404,
        on_substep=on_substep,
    )
    retained_board = _request_object(
        action,
        context,
        evidence,
        actor_key="admin",
        path=board_path,
        step="read_retained_control_board",
        on_substep=on_substep,
    )
    current_revision = retained_board.get("revision")
    if (
        retained_board.get("id") != board_id
        or type(current_revision) is not int
        or current_revision <= revision
    ):
        raise SamplePhaseActionError(
            "Event purge did not preserve and advance its Board", step=purge_step
        )
    return _result(
        action, context, evidence, [], extra={"event_purged": True, "board_preserved": True}
    )
