"""Record history: records start earlier in their life cycle and people move them on."""

from __future__ import annotations

from datetime import date
from functools import cache

import pytest

from operations.sample.blueprint import SampleDataset
from operations.sample.episodes import plan_sessions
from operations.sample.history import RecordHistory, plan_history
from operations.sample.scenario import build_dataset


@cache
def _dataset(profile: str) -> SampleDataset:
    return build_dataset(profile, seed=42, anchor_date=date(2026, 9, 30))  # type: ignore[arg-type]


def _status_label(dataset: SampleDataset, module_key: str, data: dict[str, object]) -> str:
    field_id = dataset.field_ids[module_key]["status"]
    module = next(
        item
        for item in dataset.document["design"]["modules"]
        if item["id"] == dataset.module_ids[module_key]
    )
    config = next(field for field in module["fields"] if field["id"] == field_id)["config"]
    value = data.get(field_id, config["defaultValue"])
    return next(option["label"] for option in config["options"] if option["id"] == value)


def test_about_forty_percent_of_records_have_a_history() -> None:
    dataset = _dataset("standard")
    share = len(plan_history(dataset)) / len(dataset.records)
    assert 0.35 <= share <= 0.45


def test_each_history_ends_at_the_generated_status_through_real_steps() -> None:
    dataset = _dataset("standard")
    records = {record.logical_id: record for record in dataset.records}
    for logical_id, history in plan_history(dataset).items():
        record = records[logical_id]
        final = _status_label(dataset, record.module_key, record.data)
        path = dataset.organization.history.status_paths[record.module_key][final]
        assert history.initial_status == path[0]
        assert [step.status for step in history.steps] == [*path[1:], final]
        assert all(
            step.updater_key.startswith(f"internal_{record.actor_key}_") for step in history.steps
        )


@pytest.mark.parametrize("profile", ["small", "standard"])
def test_named_cases_and_automation_inputs_are_left_alone(profile: str) -> None:
    dataset = _dataset(profile)
    histories = plan_history(dataset)
    edited = {
        dataset.organization.blueprint.trigger_mutation(dataset, key)[0]
        for key in dataset.organization.blueprint.patch_trigger_keys
    }
    named = {record_id for scenario in dataset.named_scenarios for record_id in scenario.record_ids}
    protected = dataset.organization.history.protected_records
    assert not (edited | named | protected) & set(histories)


def test_update_steps_come_after_creation_and_in_order() -> None:
    dataset = _dataset("standard")
    histories = plan_history(dataset)
    created: dict[str, int] = {}
    last_step: dict[str, int] = {}
    for position, session in enumerate(plan_sessions(dataset)):
        if session.kind == "create":
            for logical_id in session.record_ids:
                created[logical_id] = position
            continue
        if session.kind in {"reject", "link"}:
            continue
        assert session.kind == "update"
        for logical_id, step_index in session.steps:
            assert logical_id in created and created[logical_id] < position
            assert step_index == last_step.get(logical_id, -1) + 1
            assert histories[logical_id].steps[step_index].updater_key == session.creator_key
            last_step[logical_id] = step_index
    assert last_step == {key: len(value.steps) - 1 for key, value in histories.items()}


def test_some_records_are_reassigned_back_to_their_final_owner() -> None:
    histories = plan_history(_dataset("standard"))
    reassigned = [item for item in histories.values() if item.initial_assignee is not None]
    assert len(reassigned) >= len(histories) // 5
    assert all(isinstance(item, RecordHistory) for item in reassigned)


def test_every_planned_status_is_a_real_option_of_its_module() -> None:
    dataset = _dataset("small")
    for module_key, paths in dataset.organization.history.status_paths.items():
        module = next(
            item
            for item in dataset.document["design"]["modules"]
            if item["id"] == dataset.module_ids[module_key]
        )
        field = next(
            f for f in module["fields"] if f["id"] == dataset.field_ids[module_key]["status"]
        )
        labels = {option["label"] for option in field["config"]["options"]}
        for final, path in paths.items():
            assert {final, *path} <= labels, module_key
