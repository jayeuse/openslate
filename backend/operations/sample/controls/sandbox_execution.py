"""Authenticated execution for sample Sandbox control actions."""

from __future__ import annotations

from collections.abc import Callable

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.sandbox import (
    _IMPORT_CHECKPOINT_KEY,
    _PAGE_SIZE,
    OPERATIONS,
    _document,
    _revision,
    _test_matches,
    _version_id,
    _version_list,
)
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    _id,
    _read_json,
    _record_mapping,
    _request,
    _request_object,
    _result,
)


def _checkpoint_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    operation: str,
    on_substep: Callable[[str], None] | None,
) -> dict[str, object]:
    if operation == "create_checkpoint":
        _current_document, current_revision = _document(
            action,
            context,
            evidence,
            step="read_document_before_checkpoint",
            on_substep=on_substep,
        )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="POST",
            path="/api/sandbox/versions",
            step="create_checkpoint",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={
                "expectedRevision": current_revision,
                "kind": "checkpoint",
                "label": action.values.get("label"),
                "note": action.values.get("note"),
            },
            primary_entity_type="sandbox_versions",
            primary_action="create",
            expected_audit_rows=1,
            related_entity_types=("sandbox_documents",),
        )
        body = _read_json(response, step="create_checkpoint")
        version_id = _id(
            {"version": body.get("id")},
            "version",
            label="Sandbox version",
            step="create_checkpoint",
        )
        if body.get("kind") != "checkpoint" or body.get("label") != action.values.get("label"):
            raise SamplePhaseActionError(
                "Created Sandbox checkpoint did not match its plan", step="create_checkpoint"
            )
        evidence[-1]["primary_entity_id"] = version_id
        client = context.clients[action.actor_key]
        _record_mapping(
            context, client, "sandbox_control_versions", action.target_key, version_id, mappings
        )
        return _result(action, context, evidence, mappings)

    version_id = _version_id(context, action.target_key, step=operation)
    _current_document, current_revision = _document(
        action, context, evidence, step=f"read_document_for_{operation}", on_substep=on_substep
    )
    version = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=f"/api/sandbox/versions/{version_id}",
        step=f"read_checkpoint_for_{operation}",
        on_substep=on_substep,
    )
    if (
        version.get("id") != version_id
        or version.get("kind") != "checkpoint"
        or version.get("label") != action.values.get("before_label", action.values.get("label"))
    ):
        raise SamplePhaseActionError(
            "Planned Sandbox checkpoint changed unexpectedly", step=operation
        )
    if operation == "update_checkpoint":
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="PATCH",
            path=f"/api/sandbox/versions/{version_id}",
            step="update_checkpoint",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={"expectedRevision": current_revision, "label": action.values.get("label")},
            primary_entity_type="sandbox_versions",
            primary_entity_id=version_id,
            primary_action="update",
            expected_audit_rows=1,
            related_entity_types=("sandbox_documents",),
        )
        body = _read_json(response, step="update_checkpoint")
        if body.get("id") != version_id or body.get("label") != action.values.get("label"):
            raise SamplePhaseActionError(
                "Sandbox checkpoint metadata did not match its plan", step="update_checkpoint"
            )
        return _result(action, context, evidence, mappings)
    if operation == "delete_checkpoint":
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"/api/sandbox/versions/{version_id}",
            step="delete_checkpoint",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={"expectedRevision": current_revision},
            primary_entity_type="sandbox_versions",
            primary_entity_id=version_id,
            primary_action="delete",
            expected_audit_rows=1,
            related_entity_types=("sandbox_documents",),
        )
        return _result(action, context, evidence, mappings)
    if operation == "delete_import_checkpoint":
        if version.get("label") != "Before import":
            raise SamplePhaseActionError(
                "Import checkpoint label changed unexpectedly", step="read_checkpoint_for_delete"
            )
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path=f"/api/sandbox/versions/{version_id}",
            step="delete_import_checkpoint",
            expected=action.expected_status,
            on_substep=on_substep,
            json_body={"expectedRevision": current_revision},
            primary_entity_type="sandbox_versions",
            primary_entity_id=version_id,
            primary_action="delete",
            expected_audit_rows=1,
            related_entity_types=("sandbox_documents",),
        )
        return _result(action, context, evidence, mappings)
    raise SamplePhaseActionError("Unsupported Sandbox checkpoint operation", step=action.key)


def _export_import(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: Callable[[str], None] | None,
) -> dict[str, object]:
    before_document, revision = _document(
        action, context, evidence, step="read_document_before_export", on_substep=on_substep
    )
    bundle = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path="/api/sandbox/export",
        params={"includeVersions": "false"},
        step="export_document",
        on_substep=on_substep,
    )
    if bundle != before_document:
        raise SamplePhaseActionError(
            "Sandbox export did not match the current document", step="export_document"
        )
    before_versions = _version_list(
        action, context, evidence, step="list_versions_before_import", on_substep=on_substep
    )
    before_ids = {row.get("id") for row in before_versions if isinstance(row.get("id"), str)}
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path="/api/sandbox/imports",
        step="import_document",
        expected=action.expected_status,
        on_substep=on_substep,
        json_body={"expectedRevision": revision, "bundle": bundle},
        primary_entity_type="sandbox_documents",
        primary_action="update",
        expected_audit_rows=1,
        related_entity_types=("sandbox_versions",),
    )
    imported = _read_json(response, step="import_document")
    imported_document = imported.get("document")
    if not isinstance(imported_document, dict) or imported_document != bundle:
        raise SamplePhaseActionError(
            "Sandbox import changed the exported document", step="import_document"
        )
    next_revision = _revision(imported, step="import_document")
    after_versions = _version_list(
        action, context, evidence, step="list_versions_after_import", on_substep=on_substep
    )
    new_checkpoints = [
        row
        for row in after_versions
        if row.get("id") not in before_ids
        and row.get("kind") == "checkpoint"
        and row.get("label") == "Before import"
    ]
    if len(new_checkpoints) != 1 or not isinstance(new_checkpoints[0].get("id"), str):
        raise SamplePhaseActionError(
            "Sandbox import did not create one review checkpoint", step="list_versions_after_import"
        )
    checkpoint_id = _id(
        {"version": new_checkpoints[0]["id"]},
        "version",
        label="Sandbox version",
        step="list_versions_after_import",
    )
    client = context.clients[action.actor_key]
    _record_mapping(
        context,
        client,
        "sandbox_control_versions",
        _IMPORT_CHECKPOINT_KEY,
        checkpoint_id,
        mappings,
    )
    evidence[-1]["primary_entity_id"] = None
    return _result(
        action,
        context,
        evidence,
        mappings,
        extra={"document_round_trip": True, "import_revision": next_revision},
    )


def _test_history_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    operation: str,
    on_substep: Callable[[str], None] | None,
) -> dict[str, object]:
    if operation == "clear_test_history":
        body = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path="/api/sandbox/tests",
            params={"limit": _PAGE_SIZE, "offset": 0},
            step="list_test_history_before_clear",
            on_substep=on_substep,
        )
        rows = body.get("items")
        total = body.get("total")
        if (
            not isinstance(rows, list)
            or any(not isinstance(row, dict) for row in rows)
            or type(total) is not int
            or len(rows) != len(dataset.test_vectors)
            or total != len(dataset.test_vectors)
            or len(rows) != action.values.get("expected_run_count")
        ):
            raise SamplePhaseActionError(
                "Sandbox Test history differs from its authored plan",
                step="list_test_history_before_clear",
            )
        test_ids = [
            _id(
                {"test": row.get("id")},
                "test",
                label="Sandbox Test",
                step="list_test_history_before_clear",
            )
            for row in rows
        ]
        _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="DELETE",
            path="/api/sandbox/tests",
            step="clear_test_history",
            expected=action.expected_status,
            on_substep=on_substep,
            primary_entity_type="sandbox_test_runs",
            primary_action="delete",
            expected_audit_rows=len(test_ids),
        )
        return _result(action, context, evidence, mappings, extra={"deleted_test_ids": test_ids})

    if operation == "restore_test_history":
        _current_document, revision = _document(
            action,
            context,
            evidence,
            step="read_document_before_test_restore",
            on_substep=on_substep,
        )
        for vector in dataset.test_vectors:
            response = _request(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                method="POST",
                path="/api/sandbox/tests",
                step=f"restore_test:{vector.key.replace('-', '_')}",
                expected=action.expected_status,
                on_substep=on_substep,
                json_body={
                    "expectedRevision": revision,
                    "moduleId": dataset.module_ids[vector.module_key],
                    "values": vector.values,
                    "event": vector.event,
                    "triggerIds": list(vector.trigger_ids),
                },
                primary_entity_type="sandbox_test_runs",
                primary_action="create",
                expected_audit_rows=1,
            )
            body = _read_json(response, step=f"restore_test:{vector.key.replace('-', '_')}")
            test_id = _id(
                {"test": body.get("id")},
                "test",
                label="Sandbox Test",
                step="restore_test",
            )
            evidence[-1]["primary_entity_id"] = test_id
            logical_id = vector.key.replace("-", "_")
            _record_mapping(
                context,
                context.clients[action.actor_key],
                "sandbox_control_tests",
                logical_id,
                test_id,
                mappings,
            )
            detail = _request_object(
                action,
                context,
                evidence,
                actor_key=action.actor_key,
                path=f"/api/sandbox/tests/{test_id}",
                step=f"read_restored_test:{logical_id}",
                on_substep=on_substep,
            )
            if not _test_matches(detail, dataset, vector):
                raise SamplePhaseActionError(
                    "Restored Sandbox Test did not match its authored input",
                    step="read_restored_test",
                )
        return _result(action, context, evidence, mappings)
    raise SamplePhaseActionError("Unsupported Sandbox Test operation", step=action.key)


def execute_sandbox_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: Callable[[str], None] | None = None,
) -> dict[str, object]:
    """Execute one planned Sandbox action through authenticated UI APIs."""
    if action.kind != "sandbox_controls":
        raise SamplePhaseActionError("Unsupported planned Sandbox control", step=action.key)
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    operation = action.values.get("operation")
    if operation == "prune_versions":
        from operations.sample.controls.version_prune import execute_version_prune

        return execute_version_prune(action, dataset, context, on_substep=on_substep)
    from operations.sample.controls.lifecycle import execute_lifecycle_control

    if operation in OPERATIONS:
        return execute_lifecycle_control(action, dataset, context, on_substep=on_substep)
    if operation in {
        "create_checkpoint",
        "update_checkpoint",
        "delete_checkpoint",
        "delete_import_checkpoint",
    }:
        return _checkpoint_action(
            action,
            context,
            evidence,
            mappings,
            operation=operation,
            on_substep=on_substep,
        )
    if operation == "export_import_document":
        return _export_import(action, context, evidence, mappings, on_substep=on_substep)
    if operation in {"clear_test_history", "restore_test_history"}:
        return _test_history_action(
            action,
            dataset,
            context,
            evidence,
            mappings,
            operation=operation,
            on_substep=on_substep,
        )
    raise SamplePhaseActionError("Unsupported planned Sandbox operation", step=action.key)
