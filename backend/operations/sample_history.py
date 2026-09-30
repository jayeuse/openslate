"""Plan generic status histories from the transitions defined by each pack."""

from __future__ import annotations

import random
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, cast

from operations.sample_actors import writer_keys, writer_weights
from operations.sample_blueprint import SampleDataset
from operations.sample_packs import default_pack
from operations.sample_packs.types import JsonValue


@dataclass(frozen=True)
class HistoryStep:
    status: str
    updater_key: str
    values: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True)
class RecordHistory:
    initial_status: str
    steps: tuple[HistoryStep, ...]
    initial_assignee: str | None
    initial_values: Mapping[str, JsonValue] = field(default_factory=dict)


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
    rules = dataset.organization.history
    protected = rules.protected_records | {
        dataset.organization.blueprint.trigger_mutation(dataset, key)[0]
        for key in dataset.organization.blueprint.patch_trigger_keys
    }
    eligible = []
    for record in dataset.records:
        paths = rules.status_paths.get(record.module_key)
        if paths is None or record.logical_id in protected:
            continue
        final = status_label(dataset, record.module_key, record.data)
        if final in paths:
            eligible.append((record.logical_id, final, paths[final]))
    return eligible


def plan_history(dataset: SampleDataset) -> dict[str, RecordHistory]:
    """Plan status updates for the share of records defined by the organization."""
    records = {record.logical_id: record for record in dataset.records}
    eligible = _eligible(dataset)
    rules = dataset.organization.history
    chance = min(1.0, rules.target_share * len(dataset.records) / max(1, len(eligible)))
    histories: dict[str, RecordHistory] = {}
    eligible_ids = {item[0] for item in eligible}
    for logical_id in rules.field_paths:
        if logical_id not in eligible_ids:
            record = records[logical_id]
            final = status_label(dataset, record.module_key, record.data)
            eligible.append((logical_id, final, (final,)))
    for logical_id, final, path in eligible:
        rng = random.Random(f"{dataset.seed}:history:{logical_id}")
        if rng.random() >= chance and logical_id not in rules.field_paths:
            continue
        record = records[logical_id]
        team = writer_keys(record.module_key, record.actor_key, dataset.organization)
        weights = writer_weights(team, record.actor_key, dataset.organization)
        steps = tuple(
            HistoryStep(status, rng.choices(team, weights=weights)[0])
            for status in (*path[1:], final)
        )
        others = [key for key in team if key != record.assignee_key]
        initial_assignee = (
            rng.choice(others) if others and rng.random() < rules.reassigned_share else None
        )
        values = rules.field_paths.get(logical_id, {})
        initial_values = {key: values[0] for key, values in values.items()}
        extra_steps = tuple(
            HistoryStep(
                final,
                rng.choices(team, weights=weights)[0],
                {key: path[index] for key, path in values.items() if index < len(path)},
            )
            for index in range(1, max((len(path) for path in values.values()), default=1))
        )
        histories[logical_id] = RecordHistory(
            path[0], (*steps, *extra_steps), initial_assignee, initial_values
        )
    return histories


def __getattr__(name: str) -> Any:
    if name == "STATUS_PATHS":
        return default_pack().history.status_paths
    raise AttributeError(name)
