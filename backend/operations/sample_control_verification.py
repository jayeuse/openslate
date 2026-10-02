"""Read-only reconciliation for the UI-equivalent sample control journeys."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any
from uuid import UUID

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient, SampleClientError
from operations.sample_control_request_verification import verify_request_evidence
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_verification import SampleVerificationError


def _canonical_uuid(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        canonical = str(UUID(value))
    except ValueError:
        return None
    return canonical if canonical == value else None


_CONTROL_KINDS = frozenset(
    {
        "account_controls",
        "read_controls",
        "board_controls",
        "openview_controls",
        "access_controls",
        "sandbox_controls",
        "audit_controls",
    }
)


def _same_json_value(actual: object, expected: object) -> bool:
    if type(actual) is not type(expected):
        return False
    if isinstance(actual, Mapping) and isinstance(expected, Mapping):
        return actual.keys() == expected.keys() and all(
            _same_json_value(actual[key], expected[key]) for key in actual
        )
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _same_json_value(left, right) for left, right in zip(actual, expected, strict=True)
        )
    return actual == expected


def _validated_plan(
    dataset: SampleDataset, manifest: Mapping[str, Any], issues: list[str]
) -> tuple[PhaseAction, ...] | None:
    from operations.sample_control_actions import plan_controls
    from operations.sample_phase_expectations import read_phase_plan
    from operations.sample_phases import phase_action_to_manifest

    raw = manifest.get("control_plan")
    if not isinstance(raw, list):
        issues.append("Sample control plan is missing or invalid")
        return None
    try:
        actions = read_phase_plan({"phase_plan": raw})
        expected = plan_controls(dataset)
        serialized = [phase_action_to_manifest(action) for action in expected]
        if (
            not actions
            or any(action.kind not in _CONTROL_KINDS for action in actions)
            or not _same_json_value(raw, serialized)
            or actions != expected
        ):
            issues.append("Sample control plan differs from the pack-derived plan")
            return None
    except (SampleVerificationError, TypeError, ValueError):
        issues.append("Sample control plan is invalid")
        return None
    return actions


def _result_rows(
    actions: tuple[PhaseAction, ...],
    manifest: Mapping[str, Any],
    admin_id: str,
    issues: list[str],
) -> list[Mapping[str, Any]] | None:
    raw = manifest.get("control_results")
    if not isinstance(raw, list) or any(not isinstance(row, Mapping) for row in raw):
        issues.append("Sample control results are missing or invalid")
        return None
    rows = list(raw)
    if [row.get("action_key") for row in rows] != [action.key for action in actions]:
        issues.append("Sample control result order differs from the exact plan")
        return None
    actors = manifest.get("actor_ids")
    if not isinstance(actors, Mapping):
        actors = {}
    for action, result in zip(actions, rows, strict=True):
        expected_actor_id = (
            admin_id if action.actor_key == "admin" else actors.get(action.actor_key)
        )
        if (
            _canonical_uuid(expected_actor_id) is None
            or result.get("actor_key") != action.actor_key
            or result.get("actor_id") != expected_actor_id
            or result.get("target_key") != action.target_key
        ):
            issues.append("A sample control result differs from its planned actor or target")
            return None
        if action.kind == "account_controls":
            if result.get("status") != "complete":
                issues.append("Account control result is incomplete")
                return None
        elif result.get("outcome") != "completed":
            issues.append("A sample control action did not complete")
            return None
        if action.kind == "audit_controls":
            if (
                result.get("read_checks") != 3
                or _canonical_uuid(result.get("audit_id")) is None
                or result.get("request_evidence") != []
            ):
                issues.append("Audit review readback evidence is incomplete")
                return None
    return rows


def _run_final_verifiers(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample_control_access_verification import verify_access_controls
    from operations.sample_control_account import verify_account_controls
    from operations.sample_control_board_verification import verify_board_controls
    from operations.sample_control_openview_verification import verify_openview_controls
    from operations.sample_control_sandbox_verification import verify_sandbox_controls

    verifiers: tuple[tuple[str, Callable[[], tuple[dict[str, int], list[str]]]], ...] = (
        ("Board", lambda: verify_board_controls(client, dataset, manifest, admin_id=admin_id)),
        ("Account", lambda: verify_account_controls(client, dataset, manifest, admin_id)),
        (
            "OpenView",
            lambda: verify_openview_controls(client, dataset, manifest, admin_id=admin_id),
        ),
        ("Access", lambda: verify_access_controls(client, dataset, manifest, admin_id=admin_id)),
        ("Sandbox", lambda: verify_sandbox_controls(client, dataset, manifest, admin_id=admin_id)),
    )
    for label, verifier in verifiers:
        try:
            counts, family_issues = verifier()
        except (SampleClientError, SampleVerificationError, KeyError, TypeError, ValueError):
            issues.append(f"{label} control final-state readback failed")
            continue
        observed.update(counts)
        issues.extend(family_issues)


def verify_controls(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    observed: dict[str, int] = {"control_requests_verified": 0}
    issues: list[str] = []
    if _canonical_uuid(admin_id) is None:
        return observed, ["Sample control administrator ID is invalid"]
    actions = _validated_plan(dataset, manifest, issues)
    if actions is None:
        return observed, issues
    results = _result_rows(actions, manifest, admin_id, issues)
    if results is None:
        return observed, issues
    actors = manifest.get("actor_ids")
    if not isinstance(actors, Mapping):
        actors = {}
    seen_request_ids: set[str] = set()
    for action, result in zip(actions, results, strict=True):
        verify_request_evidence(
            dataset,
            manifest,
            action,
            result,
            actors,
            admin_id,
            seen_request_ids,
            observed,
            issues,
        )
    _run_final_verifiers(client, dataset, manifest, admin_id, observed, issues)
    return observed, issues


def configuration_mappings(
    manifest: Mapping[str, Any], dataset: SampleDataset
) -> dict[str, dict[str, str]]:
    issues: list[str] = []
    actions = _validated_plan(dataset, manifest, issues)
    if actions is None:
        raise SampleVerificationError(issues[0])
    restore_actions = [
        action
        for action in actions
        if action.kind == "sandbox_controls"
        and action.values.get("operation") == "restore_test_history"
    ]
    if len(restore_actions) != 1:
        raise SampleVerificationError("Sandbox control plan has no unique Test restore action")
    expected_keys = {vector.key.replace("-", "_") for vector in dataset.test_vectors}
    raw_mappings = manifest.get("mappings")
    if not isinstance(raw_mappings, Mapping):
        raise SampleVerificationError("Run mappings are invalid")
    copied: dict[str, dict[str, str]] = {}
    for kind, bucket in raw_mappings.items():
        if (
            not isinstance(kind, str)
            or not isinstance(bucket, Mapping)
            or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in bucket.items()
            )
        ):
            raise SampleVerificationError("Run mappings are invalid")
        copied[kind] = dict(bucket)
    original = copied.get("sandbox_tests")
    if (
        original is None
        or set(original) != expected_keys
        or any(_canonical_uuid(value) is None for value in original.values())
        or len(set(original.values())) != len(original)
    ):
        raise SampleVerificationError("Original Sandbox Test mappings are incomplete or ambiguous")
    raw_results = manifest.get("control_results")
    if not isinstance(raw_results, list) or any(
        not isinstance(row, Mapping) for row in raw_results
    ):
        raise SampleVerificationError("Sandbox Test restore result is missing or invalid")
    matches = [row for row in raw_results if row.get("action_key") == restore_actions[0].key]
    if len(matches) != 1:
        raise SampleVerificationError("Sandbox Test restore result is missing or duplicated")
    raw_result_mappings = matches[0].get("mappings")
    if not isinstance(raw_result_mappings, list):
        raise SampleVerificationError("Sandbox control Test mappings are missing")
    restored: dict[str, str] = {}
    for row in raw_result_mappings:
        if not isinstance(row, Mapping):
            raise SampleVerificationError("Sandbox control Test mapping is invalid")
        if row.get("kind") != "sandbox_control_tests":
            continue
        key, value = row.get("logical_id"), row.get("server_id")
        canonical_value = _canonical_uuid(value)
        if (
            not isinstance(key, str)
            or key not in expected_keys
            or key in restored
            or canonical_value is None
        ):
            raise SampleVerificationError("Sandbox control Test mappings are ambiguous")
        restored[key] = canonical_value
    if set(restored) != expected_keys or len(set(restored.values())) != len(restored):
        raise SampleVerificationError("Sandbox control Test mappings do not match authored Tests")
    copied["sandbox_tests"] = restored
    return copied
