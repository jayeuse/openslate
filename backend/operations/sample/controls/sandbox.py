"""Planned Sandbox controls for a UI-equivalent sample run."""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping
from typing import Any, cast

from operations.sample.blueprint import SampleDataset
from operations.sample.catalog import _doc_id
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction, PhaseActionKind, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    _mapped_id,
    _request_object,
)
from operations.sample.phases.design_common import _canonical_document

CONTROL_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/sandbox/document"),
        ("GET", "/api/sandbox/bindings"),
        ("GET", "/api/departments/{department_id}"),
        ("POST", "/api/departments/{department_id}/close/preview"),
        ("POST", "/api/departments/{department_id}/close"),
        ("POST", "/api/departments/{department_id}/reopen"),
        ("POST", "/api/departments/{department_id}/purge/preview"),
        ("POST", "/api/departments/{department_id}/purge"),
        ("GET", "/api/modules/{module_id}"),
        ("POST", "/api/modules/{module_id}/close/preview"),
        ("POST", "/api/modules/{module_id}/close"),
        ("POST", "/api/modules/{module_id}/reopen"),
        ("POST", "/api/modules/{module_id}/purge/preview"),
        ("POST", "/api/modules/{module_id}/purge"),
        ("GET", "/api/fields/{field_id}"),
        ("POST", "/api/fields/{field_id}/close/preview"),
        ("POST", "/api/fields/{field_id}/close"),
        ("POST", "/api/fields/{field_id}/reopen"),
        ("POST", "/api/fields/{field_id}/purge/preview"),
        ("POST", "/api/fields/{field_id}/purge"),
        ("GET", "/api/boards"),
        ("GET", "/api/boards/{board_id}"),
        ("PUT", "/api/sandbox/document"),
        ("POST", "/api/sandbox/publication-previews"),
        ("POST", "/api/sandbox/publications"),
        ("GET", "/api/sandbox/versions"),
        ("POST", "/api/sandbox/versions"),
        ("GET", "/api/sandbox/versions/{version_id}"),
        ("PATCH", "/api/sandbox/versions/{version_id}"),
        ("DELETE", "/api/sandbox/versions/{version_id}"),
        ("GET", "/api/sandbox/export"),
        ("POST", "/api/sandbox/imports"),
        ("GET", "/api/sandbox/tests"),
        ("POST", "/api/sandbox/tests"),
        ("GET", "/api/sandbox/tests/{run_id}"),
        ("DELETE", "/api/sandbox/tests"),
    }
)

_CHECKPOINT_KEY = "control_temporary_checkpoint"
_IMPORT_CHECKPOINT_KEY = "control_import_checkpoint"
_PAGE_SIZE = 100


def _make_action(
    *,
    key: str,
    kind: PhaseActionKind,
    target_key: str,
    operation: str,
    values: dict[str, PhaseJsonValue],
    expected_status: int,
    expected_end_state: dict[str, PhaseJsonValue],
) -> PhaseAction:
    return PhaseAction(
        key=key,
        phase="reorganization",
        kind=kind,
        actor_key="admin",
        target_key=target_key,
        values={"operation": operation, **values},
        expected_status=expected_status,
        expected_detail=None,
        expected_end_state=expected_end_state,
    )


def plan_sandbox_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Plan reversible version work and restore the authored Sandbox test set."""
    workspace = dataset.organization.identity.workspace_name
    initial_label = f"{workspace} structure review"
    revised_label = f"{workspace} structure agreed"
    actions = (
        _make_action(
            key="controls:sandbox:create_checkpoint",
            kind="sandbox_controls",
            target_key=_CHECKPOINT_KEY,
            operation="create_checkpoint",
            values={
                "label": initial_label,
                "note": (
                    "Department leads will confirm the fields and access "
                    "needed for the next handover."
                ),
            },
            expected_status=201,
            expected_end_state={"label": initial_label, "active": True},
        ),
        _make_action(
            key="controls:sandbox:update_checkpoint",
            kind="sandbox_controls",
            target_key=_CHECKPOINT_KEY,
            operation="update_checkpoint",
            values={"before_label": initial_label, "label": revised_label},
            expected_status=200,
            expected_end_state={"label": revised_label, "active": True},
        ),
        _make_action(
            key="controls:sandbox:delete_checkpoint",
            kind="sandbox_controls",
            target_key=_CHECKPOINT_KEY,
            operation="delete_checkpoint",
            values={"label": revised_label},
            expected_status=204,
            expected_end_state={"active": False},
        ),
        _make_action(
            key="controls:sandbox:export_import_document",
            kind="sandbox_controls",
            target_key="organization_design",
            operation="export_import_document",
            values={"include_versions": False},
            expected_status=200,
            expected_end_state={"document_round_trip": True},
        ),
        _make_action(
            key="controls:sandbox:delete_import_checkpoint",
            kind="sandbox_controls",
            target_key=_IMPORT_CHECKPOINT_KEY,
            operation="delete_import_checkpoint",
            values={"label": "Before import"},
            expected_status=204,
            expected_end_state={"active": False},
        ),
        _make_action(
            key="controls:sandbox:clear_test_history",
            kind="sandbox_controls",
            target_key="authored_test_history",
            operation="clear_test_history",
            values={"expected_run_count": len(dataset.test_vectors)},
            expected_status=204,
            expected_end_state={"active_runs": 0},
        ),
        _make_action(
            key="controls:sandbox:restore_test_history",
            kind="sandbox_controls",
            target_key="authored_test_history",
            operation="restore_test_history",
            values={"expected_run_count": len(dataset.test_vectors)},
            expected_status=201,
            expected_end_state={"active_runs": len(dataset.test_vectors)},
        ),
    )
    return actions + plan_lifecycle_controls(dataset)


def _revision(body: Mapping[str, Any], *, step: str) -> int:
    revision = body.get("revision")
    if type(revision) is not int or revision < 1:
        raise SamplePhaseActionError("Sandbox revision could not be read", step=step)
    return revision


def _version_list(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    step: str,
    on_substep: Callable[[str], None] | None,
) -> list[dict[str, Any]]:
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path="/api/sandbox/versions",
        params={"limit": _PAGE_SIZE, "offset": 0},
        step=step,
        on_substep=on_substep,
    )
    rows = body.get("items")
    if (
        not isinstance(rows, list)
        or any(not isinstance(row, dict) for row in rows)
        or body.get("count") != len(rows)
        or body.get("total") != len(rows)
        or body.get("hasMore") is not False
    ):
        raise SamplePhaseActionError("Sandbox version list was incomplete", step=step)
    return cast(list[dict[str, Any]], rows)


def _document(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    step: str,
    on_substep: Callable[[str], None] | None,
) -> tuple[dict[str, Any], int]:
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path="/api/sandbox/document",
        step=step,
        on_substep=on_substep,
    )
    current = body.get("document")
    if not isinstance(current, dict):
        raise SamplePhaseActionError("Sandbox document could not be read", step=step)
    return current, _revision(body, step=step)


def _version_id(context: PhaseExecutionContext, logical_id: str, *, step: str) -> str:
    return _mapped_id(context, "sandbox_control_versions", logical_id, step=step)


def _test_matches(row: Mapping[str, Any], dataset: SampleDataset, vector: Any) -> bool:
    event = row.get("event")
    normalized_event = (
        {key: value for key, value in event.items() if value is not None}
        if isinstance(event, Mapping)
        else event
    )
    return (
        row.get("input")
        == {"moduleId": dataset.module_ids[vector.module_key], "values": vector.values}
        and normalized_event == vector.event
        and row.get("triggerIds") == list(vector.trigger_ids)
        and isinstance(row.get("result"), Mapping)
    )


def execute_sandbox_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: Callable[[str], None] | None = None,
) -> dict[str, object]:
    """Execute one planned Sandbox action through authenticated UI APIs."""
    from operations.sample.controls.sandbox_execution import execute_sandbox_control as execute

    return execute(action, dataset, context, on_substep=on_substep)


def verify_sandbox_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Verify the authored Sandbox state after control actions."""
    from operations.sample.controls.sandbox_verification import verify_sandbox_controls as verify

    return verify(admin, dataset, manifest, admin_id=admin_id)


VERSION_KEY = "control_lifecycle_published"
OPERATIONS = (
    "prepare_lifecycle_bindings",
    "close_field",
    "reopen_field",
    "purge_field",
    "close_module",
    "reopen_module",
    "purge_module",
    "close_department",
    "reopen_department",
    "purge_department",
)


def fixture_values(dataset: SampleDataset) -> dict[str, PhaseJsonValue]:
    phases = dataset.organization.phases
    if phases is None:
        raise ValueError("Lifecycle controls require authored design phase facts")
    spec = phases.design
    logical = f"control:{spec.new_module_key}"
    return {
        "module_sandbox_id": _doc_id(dataset.seed, "module", logical, dataset.organization),
        "title_sandbox_id": _doc_id(
            dataset.seed, "field", f"{logical}:title", dataset.organization
        ),
        "field_sandbox_id": _doc_id(
            dataset.seed, "field", f"{logical}:notes", dataset.organization
        ),
        "department_sandbox_id": _doc_id(dataset.seed, "department", logical, dataset.organization),
        "department_name": f"{dataset.organization.identity.workspace_name} structure review",
        "module_name": spec.new_module_name,
        "title_field_name": spec.new_module_title_field_name,
        "field_name": spec.text_field_name,
        "version_key": VERSION_KEY,
    }


def fixture_document(dataset: SampleDataset) -> dict[str, Any]:
    values = fixture_values(dataset)
    document = copy.deepcopy(dataset.document)
    design = cast(dict[str, Any], document["design"])
    module_id = cast(str, values["module_sandbox_id"])
    department_id = cast(str, values["department_sandbox_id"])
    design["departments"].append(
        {"id": department_id, "name": values["department_name"], "closed": False}
    )
    design["modules"].append(
        {
            "id": module_id,
            "departmentId": department_id,
            "name": values["module_name"],
            "closed": False,
            "titleFieldId": values["title_sandbox_id"],
            "fields": [
                {
                    "id": values[id_key],
                    "name": values[name_key],
                    "type": field_type,
                    "required": False,
                    "closed": False,
                    "config": {"kind": config_kind},
                }
                for id_key, name_key, field_type, config_kind in (
                    ("title_sandbox_id", "title_field_name", "Text", "text"),
                    ("field_sandbox_id", "field_name", "Long text", "long-text"),
                )
            ],
        }
    )
    box = {
        "x": 0,
        "y": max(box["y"] + box["height"] for box in design["layout"].values()) + 24,
    }
    design["layout"][department_id] = {**box, "width": 760, "height": 240}
    design["layout"][module_id] = {
        "x": box["x"] + 24,
        "y": box["y"] + 64,
        "width": 320,
        "height": 152,
    }
    return _canonical_document(document, step="plan_lifecycle_fixture")


def plan_lifecycle_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    values = fixture_values(dataset)
    return tuple(
        _make_action(
            key=f"controls:sandbox:{operation}",
            kind="sandbox_controls",
            target_key="control_lifecycle_field"
            if operation.endswith("_field")
            else "control_lifecycle_department"
            if operation.endswith("_department")
            else "control_lifecycle_module",
            operation=operation,
            values=dict(values),
            expected_status=200,
            expected_end_state={"fixture_published": True, "bindings_verified": 4}
            if operation == "prepare_lifecycle_bindings"
            else {"purged": True, "document_synced": True}
            if operation.startswith("purge_")
            else {"is_deleted": operation.startswith("close_"), "document_synced": True},
        )
        for operation in OPERATIONS
    )
