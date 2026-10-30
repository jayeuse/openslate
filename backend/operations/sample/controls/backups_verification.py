"""Final backup readback as the installation operator, who owns backups."""

from collections.abc import Mapping
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.request_verification import _canonical_uuid
from operations.sample.verification.core import SampleVerificationError


def _same_json_value(actual: object, expected: object) -> bool:
    from operations.sample.controls.verification import _same_json_value as same

    return same(actual, expected)


def verify_backup_final(
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
