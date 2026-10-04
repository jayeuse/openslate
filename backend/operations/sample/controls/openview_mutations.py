"""Reversible record and relationship controls for OpenView sample runs."""

from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleWriteOutcomeUnknown
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
from operations.sample.population.activity import build_record_payload

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


def _create_control_record(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    actor_key: str,
    module_key: str,
    logical_id: str,
    name: str,
    step: str,
    on_substep: PhaseSubstep | None,
) -> tuple[str, dict[str, Any]]:
    template = next((row for row in dataset.records if row.module_key == module_key), None)
    name_document_id = dataset.field_ids.get(module_key, {}).get("name")
    if template is None or name_document_id is None:
        raise SamplePhaseActionError("Control record source is unavailable", step="create_record")
    data = dict(template.data)
    data[name_document_id] = name
    temporary = replace(template, logical_id=logical_id, data=data)
    field_ids = {
        document_id: _mapped_id(
            context, "fields", f"{module_key}:{field_key}", step="create_record"
        )
        for field_key, document_id in dataset.field_ids[module_key].items()
    }
    module_id = _mapped_id(context, "modules", module_key, step="create_record")
    payload = build_record_payload(
        temporary,
        module_id=module_id,
        api_field_ids=field_ids,
        actor_ids=context.user_ids,
    )
    response = _request(
        action,
        context,
        evidence,
        actor_key=actor_key,
        method="POST",
        path="/api/records",
        step=step,
        expected=201,
        on_substep=on_substep,
        json_body=payload,
    )
    body = _read_json(response, step=step, request_id=_request_id(response))
    record_id = _id({"record": body.get("id")}, "record", label="record", step=step)
    if body.get("module_id") != payload["module_id"] or body.get("is_deleted") is not False:
        raise SamplePhaseActionError("Temporary record response did not match its plan", step=step)
    _record_mapping(
        context,
        _client(context, actor_key, step=step),
        "control_records",
        logical_id,
        record_id,
        mappings,
    )
    return record_id, body


def _delete_record(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    actor_key: str,
    record_id: str,
    step: str,
    on_substep: PhaseSubstep | None,
) -> None:
    _request(
        action,
        context,
        evidence,
        actor_key=actor_key,
        method="DELETE",
        path=f"/api/records/{record_id}",
        step=step,
        expected=204,
        on_substep=on_substep,
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
    if (
        not isinstance(preview.get("token"), str)
        or preview.get("confirmation_name") != record_id
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
            "confirmation_name": record_id,
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


def _record_lifecycle_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    module_key = str(action.values.get("module_key", ""))
    name = action.values.get("temporary_name")
    changed_name = action.values.get("edited_name")
    if not module_key or not isinstance(name, str) or not isinstance(changed_name, str):
        raise SamplePhaseActionError("Planned record lifecycle target is invalid", step=action.key)
    record_id, created = _create_control_record(
        action,
        dataset,
        context,
        evidence,
        mappings,
        actor_key=action.actor_key,
        module_key=module_key,
        logical_id="control:record_lifecycle",
        name=name,
        step="create_record",
        on_substep=on_substep,
    )
    original_data = created.get("data")
    created_at = created.get("updated_at")
    if not isinstance(original_data, dict) or not isinstance(created_at, str):
        raise SamplePhaseActionError("Temporary record response incomplete", step="create_record")
    readback = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/records/{record_id}",
        step="read_control_record",
        on_substep=on_substep,
    )
    if readback.get("data") != original_data or readback.get("is_deleted") is not False:
        raise SamplePhaseActionError("Temporary record detail mismatch", step="read_control_record")
    name_field = _mapped_id(context, "fields", f"{module_key}:name", step="patch_control_record")
    for value, step in (
        (changed_name, "patch_control_record"),
        (name, "restore_control_record_values"),
    ):
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PATCH",
            path=f"/api/records/{record_id}",
            step=step,
            expected=200,
            on_substep=on_substep,
            # PATCH replaces every active value, as the record form sends them all.
            json_body={"data": {**original_data, name_field: value}},
            headers={"If-Match": f'"{created_at}"'},
        )
        updated = _read_json(response, step=step, request_id=_request_id(response))
        if updated.get("id") != record_id or not isinstance(updated.get("updated_at"), str):
            raise SamplePhaseActionError("Record update response mismatch", step=step)
        created_at = str(updated["updated_at"])
        expected_name = value
        data = updated.get("data")
        if not isinstance(data, Mapping) or data.get(name_field) != expected_name:
            raise SamplePhaseActionError("Record update response did not save its field", step=step)
    if updated.get("data") != original_data:
        raise SamplePhaseActionError(
            "Temporary record values mismatch", step="restore_control_record_values"
        )
    _delete_record(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        record_id=record_id,
        step="delete_control_record",
        on_substep=on_substep,
    )
    restored_response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=f"/api/records/{record_id}/restore",
        step="restore_control_record",
        expected=200,
        on_substep=on_substep,
    )
    restored = _read_json(
        restored_response, step="restore_control_record", request_id=_request_id(restored_response)
    )
    if restored.get("is_deleted") is not False or restored.get("data") != original_data:
        raise SamplePhaseActionError(
            "Temporary record restore mismatch", step="restore_control_record"
        )
    _delete_record(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        record_id=record_id,
        step="delete_before_purge_record",
        on_substep=on_substep,
    )
    history_count = _purge_control_record(
        action,
        context,
        evidence,
        record_id=record_id,
        preview_step="preview_purge_record",
        purge_step="purge_record",
        on_substep=on_substep,
    )
    return _result(
        action,
        context,
        evidence,
        mappings,
        extra={"record_purged": True, "history_entries_removed": history_count},
    )


def _relationship_delete_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    source_module = str(action.values.get("source_module_key", ""))
    target_module = str(action.values.get("target_module_key", ""))
    source_name = action.values.get("source_temporary_name")
    target_name = action.values.get("target_temporary_name")
    relation_key = action.values.get("relation_key")
    if (
        not source_module
        or not target_module
        or not isinstance(source_name, str)
        or not isinstance(target_name, str)
        or not isinstance(relation_key, str)
    ):
        raise SamplePhaseActionError("Invalid relationship control target", step=action.key)
    source_id, target_id = (
        _create_control_record(
            action,
            dataset,
            context,
            evidence,
            mappings,
            actor_key=_ADMIN,
            module_key=module_key,
            logical_id=f"control:relationship_{side}",
            name=name,
            step=f"create_relationship_{side}",
            on_substep=on_substep,
        )[0]
        for side, module_key, name in (
            ("source", source_module, source_name),
            ("target", target_module, target_name),
        )
    )
    field_id = _mapped_id(
        context, "relationships", relation_key, step="create_control_relationship"
    )
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path="/api/relationships",
        step="create_control_relationship",
        expected=201,
        on_substep=on_substep,
        json_body={
            "field_id": field_id,
            "source_record_id": source_id,
            "target_record_id": target_id,
        },
    )
    relationship = _read_json(
        response, step="create_control_relationship", request_id=_request_id(response)
    )
    relationship_id = _id(
        {"relationship": relationship.get("id")},
        "relationship",
        label="relationship",
        step="create_control_relationship",
    )
    if (
        relationship.get("field_id") != field_id
        or relationship.get("source_record_id") != source_id
        or relationship.get("target_record_id") != target_id
    ):
        raise SamplePhaseActionError(
            "Created relationship response mismatch", step="create_control_relationship"
        )
    _record_mapping(
        context,
        _client(context, action.actor_key, step="create_control_relationship"),
        "control_relationships",
        "control:relationship",
        relationship_id,
        mappings,
    )
    for attempt in range(3):
        failure = None
        try:
            _request(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                method="DELETE",
                path=f"/api/relationships/{relationship_id}",
                step="delete_control_relationship",
                expected=204,
                on_substep=on_substep,
            )
        except SampleWriteOutcomeUnknown as error:
            if error.status_code != 503 or error.failure_code != "relationship_busy":
                raise
            failure = error
        readback = _client(context, action.actor_key, step="read_relationship").request(
            "GET", f"/api/relationships/{relationship_id}"
        )
        if readback.status_code == 404:
            break
        current = _read_json(readback, step="read_relationship")
        if (
            readback.status_code != 200
            or type(current.get("is_deleted")) is not bool
            or any(
                current.get(key) != relationship.get(key)
                for key in ("id", "field_id", "source_record_id", "target_record_id")
            )
        ):
            raise SamplePhaseActionError("Link readback invalid", step="read_relationship")
        if current["is_deleted"] is True:
            break
        if failure is None:
            raise SamplePhaseActionError("Deleted link remains", step="delete_control_relationship")
        if attempt == 2:
            raise failure
        time.sleep(0.3)
    for record_id, step in (
        (source_id, "delete_relationship_source"),
        (target_id, "delete_relationship_target"),
    ):
        _delete_record(
            action,
            context,
            evidence,
            actor_key=_ADMIN,
            record_id=record_id,
            step=step,
            on_substep=on_substep,
        )
    source_history = _purge_control_record(
        action,
        context,
        evidence,
        record_id=source_id,
        preview_step="preview_purge_relationship_source",
        purge_step="purge_relationship_source",
        on_substep=on_substep,
    )
    target_history = _purge_control_record(
        action,
        context,
        evidence,
        record_id=target_id,
        preview_step="preview_purge_relationship_target",
        purge_step="purge_relationship_target",
        on_substep=on_substep,
    )
    return _result(
        action,
        context,
        evidence,
        mappings,
        extra={
            "relationship_deleted": True,
            "temporary_records_purged": 2,
            "history_entries_removed": source_history + target_history,
        },
    )
