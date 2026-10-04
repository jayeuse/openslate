"""Check that every record history update was made by the person planned for it."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.history import RecordHistory, plan_history
from operations.sample.verification.core import list_all_rows


def compare_history_audits(
    dataset: SampleDataset,
    histories: Mapping[str, RecordHistory],
    record_ids: Mapping[str, str],
    actor_ids: Mapping[str, str],
    skipped: Sequence[str],
    rows: Sequence[Mapping[str, Any]],
) -> tuple[int, list[str]]:
    """Match (record, person) update audits to the planned, not-already-done steps."""
    del dataset
    planned: Counter[tuple[str, str]] = Counter()
    for logical_id, history in histories.items():
        record_id = record_ids.get(logical_id, "")
        for index, step in enumerate(history.steps):
            if f"{logical_id}:{index}" not in skipped:
                planned[(record_id, actor_ids.get(step.updater_key, ""))] += 1
    history_records = {record_ids.get(logical_id, "") for logical_id in histories}
    actual: Counter[tuple[str, str]] = Counter(
        (str(row.get("entity_id")), str(row.get("performed_by")))
        for row in rows
        if row.get("action") == "update"
        and row.get("request_method") == "PATCH"
        and str(row.get("request_path", "")).startswith("/api/records/")
        # Automation updates carry no user; they are not planned history steps.
        and row.get("performed_by") is not None
        and str(row.get("entity_id")) in history_records
    )
    issues = []
    if actual != planned:
        issues.append("record history updates differ from the planned people and steps")
    return sum((actual & planned).values()), issues


def verify_history(
    client: SampleClient,
    *,
    dataset: SampleDataset,
    mappings: Mapping[str, Mapping[str, str]],
    actor_ids: Mapping[str, str],
    skipped: Sequence[str],
    started_at: str,
    finished_at: str,
) -> tuple[dict[str, int], list[str]]:
    rows = list_all_rows(
        client,
        "/api/audit-logs",
        params={
            "entity_type": "records",
            "created_after": started_at,
            "created_before": finished_at,
        },
    )
    histories = plan_history(dataset)
    matches, issues = compare_history_audits(
        dataset, histories, mappings.get("records", {}), actor_ids, skipped, rows
    )
    return {"history_update_matches": matches}, issues
