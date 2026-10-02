"""Planned Sandbox controls for a UI-equivalent sample run."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, cast

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient
from operations.sample_packs.phase_types import PhaseAction, PhaseActionKind, PhaseJsonValue
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    _mapped_id,
    _request_object,
)

CONTROL_ROUTES: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/sandbox/document"),
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
    return (
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
    from operations.sample_control_sandbox_execution import execute_sandbox_control as execute

    return execute(action, dataset, context, on_substep=on_substep)


def verify_sandbox_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Verify the authored Sandbox state after control actions."""
    from operations.sample_control_sandbox_verification import verify_sandbox_controls as verify

    return verify(admin, dataset, manifest, admin_id=admin_id)
