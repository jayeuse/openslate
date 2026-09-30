"""Record history: a record is created earlier in its life cycle and people move it on.

Each planned history starts at an earlier status and ends at the record's generated
status, so the final data is unchanged. Named business cases and the records that
named automation checks edit are left alone.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast

from operations.sample_actors import TEAM_KEYS
from operations.sample_blueprint import SampleDataset

# For each module: final status -> the statuses a record passes through before it.
STATUS_PATHS: dict[str, dict[str, tuple[str, ...]]] = {
    "customers": {"Active": ("Prospect",), "On hold": ("Prospect", "Active")},
    "quotes": {"Sent": ("Draft",), "Accepted": ("Draft", "Sent"),
               "Expired": ("Draft", "Sent"), "Cancelled": ("Draft",)},
    "sales_orders": {"Confirmed": ("Draft",), "Partially fulfilled": ("Draft", "Confirmed"),
                     "Complete": ("Draft", "Confirmed", "Partially fulfilled"),
                     "Cancelled": ("Draft",)},
    "service_contracts": {"Renewal due": ("Active",), "Expired": ("Active", "Renewal due"),
                          "Cancelled": ("Active",)},
    "service_requests": {"In progress": ("Open",), "Overdue": ("Open", "In progress"),
                         "Resolved": ("Open", "In progress"), "Cancelled": ("Open",)},
    "equipment": {"Needs service": ("Operational",), "Retired": ("Operational",)},
    "work_orders": {"Scheduled": ("Open",), "Overdue": ("Open", "Scheduled"),
                    "In progress": ("Open", "Scheduled"),
                    "Completed": ("Open", "Scheduled", "In progress"), "Cancelled": ("Open",)},
    "stock_counts": {"Variance found": ("Open",), "Reconciled": ("Open", "Variance found")},
    "purchase_orders": {"Confirmed": ("Draft",), "Partially received": ("Draft", "Confirmed"),
                        "Received": ("Draft", "Confirmed"), "Delayed": ("Draft", "Confirmed"),
                        "Cancelled": ("Draft",)},
    "purchase_lines": {"Partially received": ("Open",), "Received": ("Open",),
                       "Cancelled": ("Open",)},
    "invoices": {"Issued": ("Draft",), "Partially paid": ("Draft", "Issued"),
                 "Paid": ("Draft", "Issued"), "Overdue": ("Draft", "Issued"),
                 "Disputed": ("Draft", "Issued"), "Cancelled": ("Draft",)},
    "payments": {"Posted": ("Pending",)},
    "expenses": {"Approved": ("Submitted",), "Rejected": ("Submitted",),
                 "Reimbursed": ("Submitted", "Approved")},
    "credit_notes": {"Approved": ("Draft",), "Issued": ("Draft", "Approved"),
                     "Cancelled": ("Draft",)},
}  # fmt: skip
# Records that named business cases or named automation checks depend on.
_PROTECTED = frozenset(
    {"invoices:000001", "payments:000001", "sales_orders:000001", "customers:000001",
     "quotes:000001", "work_orders:000001", "stock_movements:000001"}
)  # fmt: skip
_TARGET_SHARE = 0.40
_REASSIGNED_SHARE = 0.25


@dataclass(frozen=True)
class HistoryStep:
    status: str
    updater_key: str


@dataclass(frozen=True)
class RecordHistory:
    initial_status: str
    steps: tuple[HistoryStep, ...]
    initial_assignee: str | None  # Set when the record is reassigned in its first step.


def status_label(dataset: SampleDataset, module_key: str, data: Mapping[str, object]) -> str:
    """The Status label a record's data holds, falling back to the field's default."""
    field_id = dataset.field_ids[module_key]["status"]
    design = cast(dict[str, Any], dataset.document["design"])
    module = next(
        item for item in design["modules"] if item["id"] == dataset.module_ids[module_key]
    )
    config = next(field for field in module["fields"] if field["id"] == field_id)["config"]
    value = data.get(field_id, config["defaultValue"])
    return str(next(option["label"] for option in config["options"] if option["id"] == value))


def _eligible(dataset: SampleDataset) -> list[tuple[str, str, tuple[str, ...]]]:
    from operations.sample_trigger_population import _PATCH_TRIGGERS, _trigger_mutation

    # Records that named automation checks edit keep a single, known update.
    protected = _PROTECTED | {_trigger_mutation(dataset, key)[0] for key in _PATCH_TRIGGERS}
    eligible = []
    for record in dataset.records:
        paths = STATUS_PATHS.get(record.module_key)
        if paths is None or record.logical_id in protected:
            continue
        final = status_label(dataset, record.module_key, record.data)
        if final in paths:
            eligible.append((record.logical_id, final, paths[final]))
    return eligible


def plan_history(dataset: SampleDataset) -> dict[str, RecordHistory]:
    """Pick about 40% of all records and plan the status steps that bring them to today."""
    records = {record.logical_id: record for record in dataset.records}
    eligible = _eligible(dataset)
    chance = min(1.0, _TARGET_SHARE * len(dataset.records) / max(1, len(eligible)))
    histories: dict[str, RecordHistory] = {}
    for logical_id, final, path in eligible:
        rng = random.Random(f"{dataset.seed}:history:{logical_id}")
        if rng.random() >= chance:
            continue
        record = records[logical_id]
        team = TEAM_KEYS[record.actor_key]
        weights = [1] + [3] * (len(team) - 1)
        steps = tuple(
            HistoryStep(status, rng.choices(team, weights=weights)[0])
            for status in (*path[1:], final)
        )
        others = [key for key in team if key != record.assignee_key]
        initial_assignee = rng.choice(others) if rng.random() < _REASSIGNED_SHARE else None
        histories[logical_id] = RecordHistory(path[0], steps, initial_assignee)
    return histories
