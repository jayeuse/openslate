"""Sandbox design lifecycle steps for planned sample phases."""

from __future__ import annotations

from typing import TYPE_CHECKING

from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _mapped_id,
    _request_object,
    _result,
)
from operations.sample.phases.design_common import (
    _canonical_document,
    _expected_design_document,
    _load_document,
    _publish_and_map_version,
    _require_same_document,
    _save_document,
    _text,
)
from operations.sample.phases.design_restore import _restore_publish
from operations.sample.phases.design_structure import _map_published_structure
from operations.sample.phases.outputs import _design_spec
from operations.sample.phases.planning import _design_values, _document_version

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset


def _close_or_reopen(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    closed: bool,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    live_document, revision = _load_document(action, context, evidence, on_substep=on_substep)
    expected_current = _expected_design_document(dataset, closed=not closed)
    _require_same_document(live_document, expected_current, step="load_document")
    module_key = _text(action, "module_key", step=action.key)
    module_doc_id = _text(action, "module_id", step=action.key)
    phase_data = dataset.organization.phases
    planned_values = _design_values(dataset)
    expected_module_key = phase_data.design.new_module_key if phase_data else ""
    expected_module_id = planned_values.get("new_module_id")
    if (
        module_key != expected_module_key
        or not isinstance(expected_module_id, str)
        or module_doc_id != expected_module_id
    ):
        raise SamplePhaseActionError("Planned Sandbox module ID is inconsistent", step=action.key)
    design = live_document.get("design")
    modules = design.get("modules") if isinstance(design, dict) else None
    if not isinstance(modules, list):
        raise SamplePhaseActionError("Sandbox module list is invalid", step="load_document")
    module = next(
        (item for item in modules if isinstance(item, dict) and item.get("id") == module_doc_id),
        None,
    )
    if module is None or module.get("closed") is not (not closed):
        raise SamplePhaseActionError(
            "Planned Sandbox module has the wrong lifecycle state", step="load_document"
        )
    live_module_id = _mapped_id(context, "modules", module_key, step="count_module_records")
    record_body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path="/api/records",
        params={"module_id": live_module_id, "limit": 1, "offset": 0},
        step="count_module_records",
        on_substep=on_substep,
    )
    pagination = record_body.get("pagination")
    items = record_body.get("items")
    if (
        not isinstance(pagination, dict)
        or type(pagination.get("total")) is not int
        or not isinstance(items, list)
        or pagination["total"] != 0
        or items
    ):
        raise SamplePhaseActionError(
            "Sandbox module must be empty before lifecycle change", step="count_module_records"
        )
    module["closed"] = closed
    document = _canonical_document(live_document, step="validate_closed_document")
    suffix = "closed" if closed else "reopened"
    next_revision = _save_document(
        action,
        context,
        evidence,
        document,
        revision,
        step=f"save_{suffix}_document",
        on_substep=on_substep,
    )
    version_key = _text(action, "version_key", step=action.key)
    _publish_and_map_version(
        action,
        context,
        evidence,
        mappings,
        revision=next_revision,
        version_key=version_key,
        preview_step=f"preview_{suffix}_document",
        publish_step=f"publish_{suffix}_document",
        on_substep=on_substep,
    )
    return _result(action, context, evidence, mappings)


def execute_design_phase_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    """Execute only the planned Sandbox document actions and publish changes."""
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    if action.kind == "sandbox_edit_publish":
        values = action.values
        spec = _design_spec(action)
        live_document, revision = _load_document(action, context, evidence, on_substep=on_substep)
        _require_same_document(live_document, dataset.document, step="load_document")
        edited_document = _canonical_document(
            _document_version(
                dataset,
                spec,
                plan_values=values,
                include_new_module=False,
            ),
            step="build_edited_document",
        )
        revision = _save_document(
            action,
            context,
            evidence,
            edited_document,
            revision,
            step="save_edited_document",
            on_substep=on_substep,
        )
        _publish_and_map_version(
            action,
            context,
            evidence,
            mappings,
            revision=revision,
            version_key=_text(action, "edit_publish_version_key", step=action.key),
            preview_step="preview_edited_document",
            publish_step="publish_edited_document",
            on_substep=on_substep,
        )

        live_document, revision = _load_document(action, context, evidence, on_substep=on_substep)
        _require_same_document(live_document, edited_document, step="reload_document")
        open_document = _canonical_document(
            _document_version(dataset, spec, plan_values=values),
            step="build_open_document",
        )
        revision = _save_document(
            action,
            context,
            evidence,
            open_document,
            revision,
            step="save_open_document",
            on_substep=on_substep,
        )
        _publish_and_map_version(
            action,
            context,
            evidence,
            mappings,
            revision=revision,
            version_key=_text(action, "open_version_key", step=action.key),
            preview_step="preview_open_document",
            publish_step="publish_open_document",
            on_substep=on_substep,
        )
        _map_published_structure(
            action,
            dataset,
            context,
            evidence,
            mappings,
            values=values,
            on_substep=on_substep,
        )
        return _result(action, context, evidence, mappings)
    if action.kind == "sandbox_close_empty_publish":
        return _close_or_reopen(
            action,
            dataset,
            context,
            evidence,
            mappings,
            closed=True,
            on_substep=on_substep,
        )
    if action.kind == "sandbox_reopen_empty_publish":
        return _close_or_reopen(
            action,
            dataset,
            context,
            evidence,
            mappings,
            closed=False,
            on_substep=on_substep,
        )
    if action.kind == "sandbox_restore_publish":
        return _restore_publish(
            action,
            dataset,
            context,
            evidence,
            mappings,
            on_substep=on_substep,
        )
    raise SamplePhaseActionError("Unsupported Sandbox phase action", step=action.key)
