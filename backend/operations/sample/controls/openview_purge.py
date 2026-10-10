"""API disposal of temporary OpenView resources, retaining authored source data."""

from __future__ import annotations

import time
from collections.abc import Mapping

from pydantic import ValidationError

from app.systems.openview.reports.schemas import ReportCreate, ReportResponse
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
    _client,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _request_object,
    _result,
)


def execute_report_purge(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    source_key = action.values.get("source_report_key")
    module_key, name = action.values.get("module_key"), action.values.get("temporary_name")
    if (
        action.actor_key != "admin"
        or not isinstance(source_key, str)
        or source_key == action.target_key
        or not isinstance(module_key, str)
        or not isinstance(name, str)
    ):
        raise SamplePhaseActionError(
            "Report purge requires an owned admin control", step=action.key
        )
    source_id = _mapped_id(context, "reports", source_key, step=action.key)
    module_id = _mapped_id(context, "modules", module_key, step=action.key)
    source_path = f"/api/reports/{source_id}"
    source_body = _request_object(
        action,
        context,
        evidence,
        actor_key="admin",
        path=source_path,
        step="read_report_purge_source",
        on_substep=on_substep,
    )
    try:
        source = ReportResponse.model_validate(source_body)
        create = ReportCreate(module_id=source.module_id, name=name, recipe=source.recipe)
    except ValidationError:
        raise SamplePhaseActionError("Report purge source is invalid", step=action.key) from None
    if (
        str(source.id) != source_id
        or str(source.module_id) != module_id
        or source.is_deleted
        or create.name == source.name
    ):
        raise SamplePhaseActionError("Report purge source did not match its plan", step=action.key)
    step = "create_control_report"
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="POST",
        path="/api/reports",
        step=step,
        expected=201,
        on_substep=on_substep,
        json_body=create.model_dump(mode="json"),
    )
    try:
        temporary = ReportResponse.model_validate(
            _read_json(response, step=step, request_id=_request_id(response))
        )
    except ValidationError:
        raise SamplePhaseActionError("Temporary report response is invalid", step=step) from None
    if (
        temporary.id == source.id
        or temporary.module_id != source.module_id
        or temporary.name != create.name
        or temporary.recipe != create.recipe
        or temporary.is_deleted
    ):
        raise SamplePhaseActionError("Temporary report response did not match its plan", step=step)
    report_id = str(temporary.id)
    path = f"/api/reports/{report_id}"
    _record_mapping(
        context,
        _client(context, "admin", step=step),
        "control_reports",
        action.target_key,
        report_id,
        mappings,
    )
    _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="DELETE",
        path=path,
        step="archive_control_report",
        expected=204,
        on_substep=on_substep,
        params={"revision": temporary.revision},
    )
    archived = _request_object(
        action,
        context,
        evidence,
        actor_key="admin",
        path=path,
        step="read_archived_control_report",
        on_substep=on_substep,
    )
    if archived.get("id") != report_id or archived.get("is_deleted") is not True:
        raise SamplePhaseActionError("Temporary report was not archived", step=step)
    preview_step = "preview_control_report_purge"
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
        raise SamplePhaseActionError("Report purge preview is invalid", step=preview_step) from None
    if (
        preview.impact.target_type != "report"
        or str(preview.impact.target_id) != report_id
        or preview.impact.operation != "purge"
        or preview.impact.blockers
    ):
        raise SamplePhaseActionError(
            "Report purge preview did not match its target", step=preview_step
        )
    purge_step = "purge_control_report"
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
        raise SamplePhaseActionError("Report purge result is invalid", step=purge_step) from None
    if (
        mutation.impact.target_type != "report"
        or str(mutation.impact.target_id) != report_id
        or mutation.impact.operation != "purge"
        or mutation.operation_id is None
    ):
        raise SamplePhaseActionError(
            "Report purge result did not match its target", step=purge_step
        )
    _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="GET",
        path=path,
        step="read_purged_control_report",
        expected=404,
        on_substep=on_substep,
    )
    retained_source = _request_object(
        action,
        context,
        evidence,
        actor_key="admin",
        path=source_path,
        step="read_retained_report_source",
        on_substep=on_substep,
    )
    if retained_source != source_body:
        raise SamplePhaseActionError("Report purge changed its authored source", step=purge_step)
    return _result(
        action, context, evidence, mappings, extra={"report_purged": True, "source_preserved": True}
    )


_ADMIN = "admin"
_PURGE_WAIT_SECONDS, _PURGE_POLL_SECONDS = 15.0, 0.5


def _automation_pending(impact: object) -> bool:
    blockers = impact.get("blockers") if isinstance(impact, Mapping) else None
    return (
        isinstance(blockers, list)
        and bool(blockers)
        and all(
            isinstance(blocker, Mapping) and blocker.get("code") == "purge_trigger_dependency"
            for blocker in blockers
        )
    )


def _purge_control_record(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    record_id: str,
    preview_step: str,
    purge_step: str,
    on_substep: PhaseSubstep | None,
) -> int:
    # Automation work queued by the delete blocks the purge until it finishes, so
    # review again for a short while, as a person would after "Review again".
    deadline = time.monotonic() + _PURGE_WAIT_SECONDS
    while True:
        preview_response = _request(
            action,
            context,
            evidence,
            actor_key=_ADMIN,
            method="POST",
            path=f"/api/records/{record_id}/purge/preview",
            step=preview_step,
            expected=200,
            on_substep=on_substep,
        )
        preview = _read_json(
            preview_response, step=preview_step, request_id=_request_id(preview_response)
        )
        impact = preview.get("impact")
        if not _automation_pending(impact) or time.monotonic() >= deadline:
            break
        time.sleep(_PURGE_POLL_SECONDS)
    confirmation_name = preview.get("confirmation_name")
    if (
        not isinstance(preview.get("token"), str)
        or not isinstance(confirmation_name, str)
        or not confirmation_name
        or not isinstance(impact, Mapping)
        or impact.get("target_id") != record_id
        or impact.get("operation") != "purge"
        or impact.get("blockers") != []
    ):
        raise SamplePhaseActionError("Temporary record purge preview is blocked", step=preview_step)
    rows = impact.get("rows", [])
    history_count = (
        sum(
            row.get("entity_type") in {"record_trigger_events", "record_trigger_runs"}
            for row in rows
            if isinstance(row, Mapping)
        )
        if isinstance(rows, list)
        else 0
    )
    response = _request(
        action,
        context,
        evidence,
        actor_key=_ADMIN,
        method="POST",
        path=f"/api/records/{record_id}/purge",
        step=purge_step,
        expected=200,
        on_substep=on_substep,
        json_body={
            "token": preview["token"],
            "confirmation_name": confirmation_name,
            "password": context.admin_password,
        },
    )
    body = _read_json(response, step=purge_step, request_id=_request_id(response))
    result_impact = body.get("impact")
    if (
        not isinstance(result_impact, Mapping)
        or result_impact.get("target_id") != record_id
        or result_impact.get("operation") != "purge"
    ):
        raise SamplePhaseActionError("Record purge response mismatch", step=purge_step)
    return history_count
