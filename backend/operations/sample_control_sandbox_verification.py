"""Read-only verification for sample Sandbox control actions."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient
from operations.sample_control_sandbox import (
    _CHECKPOINT_KEY,
    _IMPORT_CHECKPOINT_KEY,
    _PAGE_SIZE,
    _test_matches,
)
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_expectations import read_phase_plan
from operations.sample_verification import SampleVerificationError


def _control_data(
    manifest: Mapping[str, Any], kind: str, issues: list[str]
) -> tuple[list[PhaseAction], dict[str, Mapping[str, Any]]]:
    raw_plan = manifest.get("control_plan")
    if not isinstance(raw_plan, list):
        issues.append("Sandbox control plan is missing")
        return [], {}
    try:
        actions = [
            action for action in read_phase_plan({"phase_plan": raw_plan}) if action.kind == kind
        ]
    except (SampleVerificationError, TypeError, ValueError):
        issues.append("Sandbox control plan is invalid")
        return [], {}
    raw_results = manifest.get("control_results")
    if not isinstance(raw_results, list) or any(
        not isinstance(row, Mapping) for row in raw_results
    ):
        issues.append("Sandbox control results are missing")
        return actions, {}
    results: dict[str, Mapping[str, Any]] = {}
    for row in raw_results:
        key = row.get("action_key")
        if isinstance(key, str):
            results[key] = row
    return actions, results


def _mapping_ids(result: Mapping[str, Any], kind: str) -> dict[str, str]:
    rows = result.get("mappings")
    if not isinstance(rows, list):
        return {}
    result_map: dict[str, str] = {}
    for row in rows:
        if (
            isinstance(row, Mapping)
            and row.get("kind") == kind
            and isinstance(row.get("logical_id"), str)
            and isinstance(row.get("server_id"), str)
        ):
            result_map[cast(str, row["logical_id"])] = cast(str, row["server_id"])
    return result_map


def _read_final_page(client: SampleClient, path: str) -> list[Mapping[str, Any]] | None:
    response = client.request("GET", path, params={"limit": _PAGE_SIZE, "offset": 0})
    if response.status_code != 200:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, Mapping):
        return None
    items = body.get("items")
    total = body.get("total")
    if (
        not isinstance(items, list)
        or any(not isinstance(item, Mapping) for item in items)
        or type(total) is not int
        or total != len(items)
        or body.get("hasMore") is not False
    ):
        return None
    return cast(list[Mapping[str, Any]], items)


def verify_sandbox_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Verify temporary versions were removed and every authored Test was restored."""
    del admin_id
    issues: list[str] = []
    actions, results = _control_data(manifest, "sandbox_controls", issues)
    if any(
        issue in issues
        for issue in ("Sandbox control plan is missing", "Sandbox control plan is invalid")
    ):
        return {"sandbox_test_runs_verified": 0, "sandbox_temporary_versions_removed": 0}, issues
    operations = {action.values.get("operation"): action for action in actions}
    expected_operations = {
        "create_checkpoint",
        "update_checkpoint",
        "delete_checkpoint",
        "export_import_document",
        "delete_import_checkpoint",
        "clear_test_history",
        "restore_test_history",
    }
    if set(operations) != expected_operations:
        issues.append("Sandbox control plan does not cover the required operations")
    if any(action.key not in results for action in actions):
        issues.append("Sandbox control result journal is incomplete")
    import_action = operations.get("export_import_document")
    round_trip = results.get(import_action.key, {}) if import_action is not None else {}
    if round_trip.get("document_round_trip") is not True:
        issues.append("Sandbox export and import did not preserve the document")

    version_ids: dict[str, str] = {}
    for operation, key in (
        ("create_checkpoint", _CHECKPOINT_KEY),
        ("export_import_document", _IMPORT_CHECKPOINT_KEY),
    ):
        action = operations.get(operation)
        if action is None:
            continue
        result = results.get(action.key, {})
        mapping = _mapping_ids(result, "sandbox_control_versions")
        version_id = mapping.get(key)
        if version_id is None:
            issues.append("Temporary Sandbox checkpoint mapping is missing")
            continue
        version_ids[key] = version_id

    versions = _read_final_page(admin, "/api/sandbox/versions")
    removed_versions = 0
    if versions is None:
        issues.append("Sandbox version history could not be read")
    else:
        active_ids = {row.get("id") for row in versions}
        for _key, version_id in version_ids.items():
            detail = admin.request("GET", f"/api/sandbox/versions/{version_id}")
            if version_id in active_ids or detail.status_code != 404:
                issues.append("A temporary Sandbox checkpoint remains active")
            else:
                removed_versions += 1

    test_actions = [
        action for action in actions if action.values.get("operation") == "restore_test_history"
    ]
    test_mappings: dict[str, str] = {}
    if len(test_actions) == 1:
        test_mappings = _mapping_ids(results.get(test_actions[0].key, {}), "sandbox_control_tests")
    expected_keys = {vector.key.replace("-", "_") for vector in dataset.test_vectors}
    if set(test_mappings) != expected_keys:
        issues.append("Restored Sandbox Test mappings do not cover the authored rules")
    rows = _read_final_page(admin, "/api/sandbox/tests")
    verified_tests = 0
    if rows is None:
        issues.append("Sandbox Test history could not be read")
    else:
        actual_ids = {row.get("id") for row in rows}
        expected_ids = set(test_mappings.values())
        if actual_ids != expected_ids or len(rows) != len(dataset.test_vectors):
            issues.append("Sandbox Test history does not match the authored run set")
        by_id = {row.get("id"): row for row in rows}
        for vector in dataset.test_vectors:
            test_id = test_mappings.get(vector.key.replace("-", "_"))
            if not isinstance(test_id, str):
                continue
            detail = admin.request("GET", f"/api/sandbox/tests/{test_id}")
            try:
                row = detail.json()
            except ValueError:
                row = None
            if (
                test_id not in by_id
                or detail.status_code != 200
                or not isinstance(row, Mapping)
                or not _test_matches(row, dataset, vector)
            ):
                issues.append("A restored Sandbox Test differs from its authored rule")
            else:
                verified_tests += 1

    return {
        "sandbox_test_runs_verified": verified_tests,
        "sandbox_temporary_versions_removed": removed_versions,
    }, issues
