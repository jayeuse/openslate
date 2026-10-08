"""Read-only reconciliation for the UI-equivalent sample control journeys."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from app.systems.access.users.schemas import UserPreferencesResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.request_verification import _canonical_uuid, verify_request_evidence
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.verification.core import SampleVerificationError

_CONTROL_KINDS = frozenset(
    {
        "account_controls",
        "manage_controls",
        "backup_controls",
        "jobs_controls",
        "read_controls",
        "board_controls",
        "openview_controls",
        "access_controls",
        "sandbox_controls",
        "audit_controls",
        "platform_controls",
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
    from operations.sample.controls.actions import plan_controls
    from operations.sample.phases.expectations import read_phase_plan
    from operations.sample.phases.plan import phase_action_to_manifest

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
            operation = action.values.get("operation")
            if (
                operation not in {"audit_review", "audit_export"}
                or any(
                    not _same_json_value(result.get(key), value)
                    for key, value in action.expected_end_state.items()
                )
                or result.get("request_evidence") != []
                or (operation == "audit_review" and _canonical_uuid(result.get("audit_id")) is None)
                or (
                    operation == "audit_export"
                    and (
                        type(result.get("row_count")) is not int
                        or not 1 <= result["row_count"] <= 10_000
                    )
                )
            ):
                issues.append("Audit control readback evidence is incomplete")
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
    from operations.sample.controls.access_verification import verify_access_controls
    from operations.sample.controls.account import verify_account_controls
    from operations.sample.controls.board_verification import verify_board_controls
    from operations.sample.controls.jobs_verification import verify_jobs_controls
    from operations.sample.controls.openview_verification import verify_openview_controls
    from operations.sample.controls.sandbox_verification import verify_sandbox_controls

    verifiers: tuple[tuple[str, Callable[[], tuple[dict[str, int], list[str]]]], ...] = (
        ("Board", lambda: verify_board_controls(client, dataset, manifest, admin_id=admin_id)),
        ("Account", lambda: verify_account_controls(client, dataset, manifest, admin_id)),
        (
            "OpenView",
            lambda: verify_openview_controls(client, dataset, manifest, admin_id=admin_id),
        ),
        ("Access", lambda: verify_access_controls(client, dataset, manifest, admin_id=admin_id)),
        ("Sandbox", lambda: verify_sandbox_controls(client, dataset, manifest, admin_id=admin_id)),
        ("Jobs", lambda: verify_jobs_controls(client, dataset, manifest, admin_id)),
    )
    from operations.sample.controls.files_verification import verify_file_controls
    from operations.sample.controls.mfa_verification import verify_mfa_controls
    from operations.sample.controls.people_security_verification import (
        verify_people_security_controls as verify_people_controls,
    )

    plan = manifest.get("control_plan")
    operations = (
        {
            row["values"].get("operation")
            for row in plan
            if isinstance(row, Mapping) and isinstance(row.get("values"), Mapping)
        }
        if isinstance(plan, list)
        else set()
    )
    if "physical_backup_export" in operations:
        from operations.sample.controls.host_receipts import verify_host_controls

        verifiers += (("Host", lambda: verify_host_controls(client, dataset, manifest, admin_id)),)
    if "real_mfa_reset" in operations:
        verifiers += (("MFA", lambda: verify_mfa_controls(client, dataset, manifest, admin_id)),)
    if "generic_record_file" in operations:
        verifiers += (
            ("Files", lambda: verify_file_controls(client, dataset, manifest, admin_id=admin_id)),
        )
    if "review_people_security" in operations:
        verifiers += (
            (
                "People",
                lambda: verify_people_controls(client, dataset, manifest, admin_id=admin_id),
            ),
        )
    for label, verifier in verifiers:
        try:
            counts, family_issues = verifier()
        except (SampleClientError, SampleVerificationError, KeyError, TypeError, ValueError):
            issues.append(f"{label} control final-state readback failed")
            continue
        if label == "People":
            counts["people_control_requests"] = counts.pop("control_requests_verified", 0)
        observed.update(counts)
        issues.extend(family_issues)
    if isinstance(plan, list) and any(
        isinstance(row, Mapping) and row.get("kind") == "platform_controls" for row in plan
    ):
        _verify_platform_final(client, manifest, admin_id, observed, issues)
    if isinstance(plan, list) and any(
        isinstance(row, Mapping) and row.get("kind") == "backup_controls" for row in plan
    ):
        _verify_backup_final(client, dataset, manifest, observed, issues)


def _verify_backup_final(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.controls.backups import (
        HISTORY_QUERY,
        QUEUE_KEY,
        _page,
        _policy,
        _queued,
        _version,
        plan_backup_controls,
    )
    from operations.sample.phases.actions import SamplePhaseActionError

    results = manifest.get("control_results")
    mappings = manifest.get("mappings")
    mapped = mappings.get("backup_requests") if isinstance(mappings, Mapping) else None
    if (
        not isinstance(results, list)
        or not isinstance(mapped, Mapping)
        or set(mapped) != {QUEUE_KEY}
    ):
        issues.append("Backup final mappings are missing or ambiguous")
        return
    run_id = _canonical_uuid(mapped[QUEUE_KEY])
    if run_id is None:
        issues.append("Backup queued request mapping is invalid")
        return
    planned = plan_backup_controls(dataset)
    owned = {row["action_key"]: row for row in results if isinstance(row, Mapping)}
    initial, changed, queued, history, version = [owned[row.key] for row in planned]
    original, restored = changed.get("original_policy"), changed.get("restored_policy")
    if (
        not isinstance(original, Mapping)
        or not isinstance(restored, Mapping)
        or not _same_json_value(initial.get("original_policy"), original)
        or type(original.get("revision")) is not int
        or restored.get("revision") != original["revision"] + 2
        or any(
            not _same_json_value(restored.get(key), original.get(key))
            for key in ("schedule", "retention_days", "timezone", "adopted")
        )
        or queued.get("mappings")
        != [{"kind": "backup_requests", "logical_id": QUEUE_KEY, "server_id": run_id}]
        or any(row.get("mappings") != [] for row in (initial, changed, history, version))
        or not _same_json_value(queued.get("queued_run"), history.get("queued_run"))
    ):
        issues.append("Backup policy or queue receipts differ from the captured original state")
        return

    def read(path: str, params: Mapping[str, Any] | None = None) -> object:
        response = client.request("GET", path, params=params)
        if (
            response.status_code != 200
            or _canonical_uuid(response.headers.get("X-Request-ID")) is None
            or "no-store"
            not in {
                token.strip().lower()
                for token in response.headers.get("Cache-Control", "").split(",")
            }
        ):
            raise SampleVerificationError("Backup final response is invalid")
        return response.json()

    try:
        policy = _policy(read("/api/backups/status"), step="backup_final_policy")
        if not _same_json_value(policy, restored):
            issues.append("Backup original policy was not restored")
        else:
            observed["backup_policy_restored"] = 1
        page = _page(
            read("/api/backups", {**HISTORY_QUERY, "run_id": run_id}),
            run_id=run_id,
            step="backup_final_queue",
        )
        name = str(planned[2].values["name"])
        run = _queued(page["items"][0], name=name, run_id=run_id, step="backup_final_queue")
        if (
            not _same_json_value(run, queued.get("queued_run"))
            or run["schedule"] != original["schedule"]
            or run["retention_days"] != original["retention_days"]
        ):
            issues.append("Backup queued request differs from its owned admission receipt")
        else:
            observed["backup_requests_queued"] = 1
        recorded = _version(version.get("version_observation"), step="backup_recorded_version")
        current = _version(read("/api/version"), step="backup_final_version")
        if current["current_version"] != recorded["current_version"]:
            issues.append("Running version differs from its recorded observation")
        else:
            observed["backup_version_reviewed"] = 1
    except (
        SampleClientError,
        SamplePhaseActionError,
        SampleVerificationError,
        TypeError,
        ValueError,
    ):
        issues.append("Backup final state readback failed")


def _verify_platform_final(
    client: SampleClient,
    manifest: Mapping[str, Any],
    admin_id: str,
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.controls.platform import RECORD_KEYS

    mappings, results = manifest.get("mappings"), manifest.get("control_results")
    records = mappings.get("platform_records") if isinstance(mappings, Mapping) else None
    preferences = (
        [
            (row.get("original_theme"), row.get("original_appearance"))
            for row in results
            if isinstance(row, Mapping)
            and row.get("action_key")
            in ("control:platform:review_self_theme", "control:platform:toggle_restore_self_theme")
        ]
        if isinstance(results, list)
        else []
    )
    if (
        not isinstance(records, Mapping)
        or not isinstance(results, list)
        or set(records) != set(RECORD_KEYS)
        or any(_canonical_uuid(value) is None for value in records.values())
        or len(set(records.values())) != 2
        or len(preferences) != 2
        or preferences[0][0] not in ("light", "dark", "system")
        or preferences[0] != preferences[1]
    ):
        issues.append("Platform final mappings or original theme differ")
        return
    receipt = next(
        (
            row.get("mappings")
            for row in results
            if isinstance(row, Mapping)
            and row.get("action_key") == "control:platform:import_csv_rows"
        ),
        None,
    )
    if receipt != [
        {"kind": "platform_records", "logical_id": key, "server_id": records[key]}
        for key in RECORD_KEYS
    ]:
        issues.append("Platform final record mappings differ from import receipts")
        return
    try:
        if any(
            client.request("GET", f"/api/records/{identifier}").status_code != 404
            for identifier in records.values()
        ):
            issues.append("Platform imported records remain after purge")
        else:
            observed["platform_records_purged"] = 2
        response = client.request("GET", f"/api/users/{admin_id}/preferences")
        restored = UserPreferencesResponse.model_validate_json(response.content, strict=True)
        if response.status_code != 200 or restored.model_dump(mode="json") != {
            "user_id": admin_id,
            "theme": preferences[0][0],
            "appearance": preferences[0][1],
        }:
            issues.append("Platform original self theme was not restored")
        else:
            observed["platform_theme_restored"] = 1
    except (SampleClientError, TypeError, ValueError):
        issues.append("Platform final state readback failed")


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
