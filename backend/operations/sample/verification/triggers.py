"""Read back the authored automation rules: their runs, results and audited updates."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from operations.sample.client import SampleClient
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack
from operations.sample.verification.core import list_all_rows


def trigger_evidence_issues(
    evidence: list[dict[str, Any]],
    runs: list[Mapping[str, Any]],
    record_data: Mapping[str, Mapping[str, Any]],
) -> list[str]:
    by_id = {str(run.get("id")): run for run in runs}
    issues: list[str] = []
    for item in evidence:
        if item.get("enabled") is False:
            continue
        run_ids = item.get("run_ids")
        if not isinstance(run_ids, list) or not run_ids:
            issues.append("an exercised trigger has no recorded execution")
            continue
        for run_id in run_ids:
            run = by_id.get(str(run_id), {})
            details = run.get("details")
            if (
                run.get("triggerName") != item.get("name")
                or run.get("state") != "succeeded"
                or not isinstance(details, Mapping)
                or not isinstance(details.get("actionsApplied"), int)
                or details["actionsApplied"] < 1
            ):
                issues.append("a recorded trigger execution is missing or did not apply its action")
        data = record_data.get(str(item.get("target_logical_id")), {})
        if data.get(str(item.get("target_field_id"))) != item.get("expected_value"):
            issues.append("a trigger target no longer contains the expected result")
    return issues


def _verify_triggers(
    client: SampleClient,
    manifest: Mapping[str, Any],
    *,
    organization: OrganizationPack | None = None,
) -> tuple[dict[str, int], list[str]]:
    pack = organization or default_pack()
    evidence = manifest.get("trigger_evidence", [])
    mutations = manifest.get("mutation_evidence", [])
    issues: list[str] = []
    if not isinstance(evidence, list) or len(evidence) != len(pack.generators.trigger_keys):
        return {}, ["trigger evidence must cover all authored rules"]
    if not isinstance(mutations, list) or len(mutations) != len(pack.blueprint.patch_trigger_keys):
        issues.append("trigger evidence must include the authored record updates")
        mutations = []
    runs = list_all_rows(client, "/api/sandbox/trigger-runs", page_size=50)
    record_data: dict[str, Mapping[str, Any]] = {}
    record_ids = manifest["mappings"].get("records", {})
    for item in evidence:
        if item.get("enabled") is False:
            continue
        logical = item.get("target_logical_id")
        record_id = record_ids.get(logical)
        if not record_id:
            issues.append("trigger target mapping is missing")
            continue
        response = client.request("GET", f"/api/records/{record_id}")
        if response.status_code != 200:
            issues.append("trigger target readback failed")
            continue
        data = response.json().get("data")
        if isinstance(data, dict):
            record_data[logical] = data
    issues.extend(trigger_evidence_issues(evidence, runs, record_data))
    response = client.request("GET", "/api/sandbox/document")
    if response.status_code != 200:
        issues.append("published trigger configuration could not be read")
    else:
        triggers = response.json().get("document", {}).get("triggers", [])
        for item in evidence:
            if item.get("enabled") is False and not any(
                trigger.get("name") == item.get("name") and trigger.get("enabled") is False
                for trigger in triggers
            ):
                issues.append("a scheduled trigger is not disabled in its saved configuration")
    matches = 0
    for mutation in mutations:
        rows = list_all_rows(
            client,
            "/api/audit-logs",
            params={
                "entity_type": "records",
                "entity_id": mutation.get("record_id"),
                "created_after": manifest["started_at"],
                "created_before": manifest["finished_at"],
            },
        )
        if mutation.get("request_id") and any(
            row.get("entity_id") == mutation.get("record_id")
            and row.get("performed_by") == mutation.get("actor_id")
            and row.get("action") == "update"
            and row.get("request_id") == mutation["request_id"]
            and row.get("request_method") == "PATCH"
            and row.get("request_path") == mutation.get("request_path")
            for row in rows
        ):
            matches += 1
        else:
            issues.append(
                "an authored record update lacks matching actor and request audit evidence"
            )
    return {"trigger_runs": len(runs), "record_update_audit_matches": matches}, issues
