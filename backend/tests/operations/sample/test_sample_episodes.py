"""The activity plan interleaves short sessions and never links to a missing record."""

from __future__ import annotations

from datetime import date

import pytest

from operations.sample.blueprint import edge_child_ids
from operations.sample.episodes import (
    SampleSession,
    _short_batches,
    plan_sessions,
    record_parents,
)
from operations.sample.scenario import SampleDataset, build_dataset
from tests.operations.sample.sample_datasets import sample_dataset


def _dataset(profile: str) -> SampleDataset:
    return sample_dataset(profile)


def _plan(profile: str) -> tuple[SampleSession, ...]:
    # Not cached: mutation testing runs only the tests it saw call the planner, and a
    # cached plan hid every test after the first (16 planner mutants on 2026-10-13).
    return plan_sessions(_dataset(profile))


def _order(profile: str) -> list[str]:
    return [record for session in _plan(profile) for record in session.record_ids]


def test_every_record_is_created_once_in_module_order() -> None:
    dataset = _dataset("standard")
    order = _order("standard")
    assert sorted(order) == sorted(record.logical_id for record in dataset.records)
    by_module: dict[str, list[str]] = {}
    for logical_id in order:
        by_module.setdefault(logical_id.split(":")[0], []).append(logical_id)
    assert all(ids == sorted(ids) for ids in by_module.values())


def test_links_and_references_only_point_to_records_that_already_exist() -> None:
    dataset = _dataset("standard")
    position = {logical_id: index for index, logical_id in enumerate(_order("standard"))}
    parents = record_parents(dataset)
    for record in dataset.records:
        for parent in parents[record.logical_id]:
            assert position[parent] < position[record.logical_id], (parent, record.logical_id)
    for edge, child in zip(dataset.edges, edge_child_ids(dataset), strict=True):
        parent = edge.target_record_id if child == edge.source_record_id else edge.source_record_id
        assert position[parent] < position[child]


@pytest.mark.parametrize("count", [1, 5, 6, 7, 12, 13, 25])
def test_a_run_of_records_splits_into_short_sessions_in_order(count: int) -> None:
    records = tuple(f"requests:{index:06d}" for index in range(1, count + 1))
    batches = _short_batches(records)
    assert all(1 <= len(batch) <= 6 for batch in batches)
    assert tuple(record for batch in batches for record in batch) == records


def test_updates_start_while_records_are_still_being_created() -> None:
    plan = _plan("small")
    creates = [index for index, session in enumerate(plan) if session.kind == "create"]
    first_update = next(index for index, session in enumerate(plan) if session.kind == "update")
    assert first_update < creates[len(creates) // 2]


def test_sessions_belong_to_one_person_and_one_module() -> None:
    dataset = _dataset("standard")
    records = {record.logical_id: record for record in dataset.records}
    for session in _plan("standard"):
        if session.kind == "reject":
            continue
        if session.kind == "update":
            assert 1 <= len(session.steps) <= 6
            assert {item.split(":")[0] for item, _ in session.steps} == {session.module_key}
            continue
        if session.kind == "link":
            edges = [dataset.edges[index] for index in session.edge_indices]
            assert 1 <= len(edges) <= 6
            assert {edge.creator_key for edge in edges} == {session.creator_key}
            assert {records[edge.source_record_id].module_key for edge in edges} == {
                session.module_key
            }
            continue
        assert 1 <= len(session.record_ids) <= 6
        assert {records[item].creator_key for item in session.record_ids} == {session.creator_key}
        assert {records[item].module_key for item in session.record_ids} == {session.module_key}


def test_departments_take_turns() -> None:
    dataset = _dataset("standard")
    department = {record.module_key: record.actor_key for record in dataset.records}
    # A link session follows the create session it belongs to, in the same department.
    sessions = [session for session in _plan("standard") if session.kind in {"create", "update"}]
    # Teams finish at different times, so only the final stretch may narrow.
    for start in range(0, int(len(sessions) * 0.95) - 60, 60):
        window = {department[item.module_key] for item in sessions[start : start + 60]}
        assert len(window) >= 4, start
    handoffs = sum(
        department[sessions[index].module_key] != department[sessions[index + 1].module_key]
        for index in range(len(sessions) - 1)
    )
    assert handoffs >= len(sessions) * 0.9


def test_the_plan_is_repeatable() -> None:
    assert plan_sessions(_dataset("small")) == plan_sessions(
        build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
    )


def test_plan_summary_reports_sessions_and_writes_per_person(
    capsys: pytest.CaptureFixture[str],
) -> None:
    from operations.sample.plan_summary import print_plan
    from operations.seed_sample_data import build_plan_summary

    first = build_plan_summary(_dataset("small"))
    second = build_plan_summary(build_dataset("small", seed=42, anchor_date=date(2026, 9, 30)))
    assert first["session_count"] == len(_plan("small"))
    writes = first["writes_by_person"]
    from operations.sample.history import plan_history

    steps = sum(len(item.steps) for item in plan_history(_dataset("small")).values())
    records, edges = len(_dataset("small").records), len(_dataset("small").edges)
    assert sum(writes.values()) == records + edges + steps
    assert (first["session_count"], first["writes_by_person"]) == (
        second["session_count"],
        second["writes_by_person"],
    )
    print_plan(
        _dataset("small"),
        {"instance": "owned-offline-plan", "alembic_head": "synthetic-head",
         "admin_eligible": True, "storage_objects": 0, "provider_accounts": 0},
        "http://127.0.0.1:58025",
    )
    exclusions = next(
        line for line in capsys.readouterr().out.splitlines() if line.startswith("exclusions:")
    )
    assert exclusions == (
        "exclusions: custom roles; service identities/metadata; access rules/defaults; "
        "saved chart preferences; direct database writes other than creating the pack "
        "organization; provider-admin user creation"
    )
