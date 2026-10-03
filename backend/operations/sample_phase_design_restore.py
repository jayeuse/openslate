"""Automatic Sandbox restore-checkpoint reconciliation helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _request,
    _request_id,
    _request_object,
    _result,
)
from operations.sample_phase_design_common import (
    _DOCUMENT_ROW_ID,
    _PAGE_SIZE,
    _canonical_document,
    _expected_design_document,
    _load_document,
    _publish_and_map_version,
    _record_new_mapping,
    _require_same_document,
    _text,
)

if TYPE_CHECKING:
    from operations.sample_blueprint import SampleDataset


def _version_items(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    step: str,
    on_substep: PhaseSubstep | None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    offset = 0
    while True:
        body = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path="/api/sandbox/versions",
            params={"limit": _PAGE_SIZE, "offset": offset},
            step=step,
            on_substep=on_substep,
        )
        page = body.get("items")
        has_more = body.get("hasMore")
        total = body.get("total")
        if (
            not isinstance(page, list)
            or any(not isinstance(item, dict) for item in page)
            or type(has_more) is not bool
            or type(total) is not int
            or total < len(items) + len(page)
        ):
            raise SamplePhaseActionError("Sandbox version list was invalid", step=step)
        items.extend(page)
        if not has_more:
            if len(items) != total:
                raise SamplePhaseActionError("Sandbox version list was incomplete", step=step)
            return items
        if not page:
            raise SamplePhaseActionError("Sandbox version pagination made no progress", step=step)
        offset += len(page)


def _restore_publish(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    live_document, revision = _load_document(action, context, evidence, on_substep=on_substep)
    open_document = _expected_design_document(dataset)
    _require_same_document(live_document, open_document, step="load_document")
    version_key = _text(action, "restore_version_key", step=action.key)
    version_id = _mapped_id(
        context, "sandbox_versions", version_key, step="restore_open_version_to_draft"
    )
    before = _version_items(
        action,
        context,
        evidence,
        step="list_versions_before_restore",
        on_substep=on_substep,
    )
    before_ids = {
        _id(
            {"version": item.get("id")},
            "version",
            label="Sandbox version",
            step="list_versions_before_restore",
        )
        for item in before
    }
    if version_id not in before_ids:
        raise SamplePhaseActionError(
            "Planned restore version is not active", step="list_versions_before_restore"
        )
    restore_response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path=f"/api/sandbox/versions/{version_id}/restorations",
        step="restore_open_version_to_draft",
        expected=201,
        on_substep=on_substep,
        json_body={"expectedRevision": revision},
        primary_entity_type="sandbox_documents",
        primary_entity_id=_DOCUMENT_ROW_ID,
        primary_action="update",
        expected_audit_rows=1,
        related_entity_types=("sandbox_versions",),
    )
    restored_body = _read_json(
        restore_response,
        step="restore_open_version_to_draft",
        request_id=_request_id(restore_response),
    )
    restored_revision = restored_body.get("revision")
    if type(restored_revision) is not int or restored_revision != revision + 1:
        raise SamplePhaseActionError(
            "Sandbox restore did not advance one revision", step="restore_open_version_to_draft"
        )
    restored_document = _require_same_document(
        _canonical_document(restored_body.get("document"), step="restore_open_version_to_draft"),
        open_document,
        step="restore_open_version_to_draft",
    )
    after = _version_items(
        action,
        context,
        evidence,
        step="list_versions_after_restore",
        on_substep=on_substep,
    )
    new_items = [
        item
        for item in after
        if item.get("id") not in before_ids
        and item.get("kind") == "checkpoint"
        and item.get("label") == "Before restore"
    ]
    if len(new_items) != 1:
        raise SamplePhaseActionError(
            "Automatic Before restore checkpoint was not unique", step="list_versions_after_restore"
        )
    checkpoint_id = _id(
        {"version": new_items[0].get("id")},
        "version",
        label="Sandbox checkpoint",
        step="list_versions_after_restore",
    )
    checkpoint = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/sandbox/versions/{checkpoint_id}",
        step="read_before_restore_checkpoint",
        on_substep=on_substep,
    )
    if (
        checkpoint.get("id") != checkpoint_id
        or checkpoint.get("kind") != "checkpoint"
        or checkpoint.get("label") != "Before restore"
    ):
        raise SamplePhaseActionError(
            "Automatic restore checkpoint metadata was invalid",
            step="read_before_restore_checkpoint",
        )
    checkpoint_document = _canonical_document(
        checkpoint.get("document"), step="read_before_restore_checkpoint"
    )
    if checkpoint_document != restored_document:
        raise SamplePhaseActionError(
            "Automatic restore checkpoint did not capture the reopened draft",
            step="read_before_restore_checkpoint",
        )
    checkpoint_key = _text(action, "checkpoint_version_key", step=action.key)
    _record_new_mapping(
        context, action, "sandbox_versions", checkpoint_key, checkpoint_id, mappings
    )
    _publish_and_map_version(
        action,
        context,
        evidence,
        mappings,
        revision=restored_revision,
        version_key=_text(action, "version_key", step=action.key),
        preview_step="preview_restored_document",
        publish_step="publish_restored_document",
        on_substep=on_substep,
    )
    return _result(action, context, evidence, mappings)
