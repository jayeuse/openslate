"""Order record creation as interleaved work sessions, the way a team fills a system.

A session is one person's short run of records in one module. Each record is created
and immediately linked to its parents, so every parent (a relationship source or a
record named by a reference field) must be created in an earlier session.
"""

from __future__ import annotations

import random
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from itertools import groupby

from operations.sample.blueprint import SampleDataset
from operations.sample.history import RecordHistory, plan_history
from operations.sample.links import reference_parents


@dataclass(frozen=True)
class SampleSession:
    """One person's short run of work in one module: new records, or history updates."""

    creator_key: str
    module_key: str
    record_ids: tuple[str, ...]
    kind: str = "create"  # create, update, link or reject
    steps: tuple[tuple[str, int], ...] = ()  # (record, history step index) for updates
    case_key: str = ""  # the planned rejection a reject session sends
    edge_indices: tuple[int, ...] = ()  # explicit differing-actor relationship writes


# Sessions that pass before a person comes back to update a record they, or a colleague,
# worked on earlier; and the share of turns that go to updates when some are due.
_UPDATE_GAP = (15, 80)
_UPDATE_TURN_SHARE = 0.45
# Planned rejections are spread through the run once the records they need exist.
_REJECTION_TURN_SHARE = 0.04


def _logical_id(module_key: str, index: int) -> str:
    return f"{module_key}:{index + 1:06d}"


def record_parents(dataset: SampleDataset) -> Mapping[str, tuple[str, ...]]:
    """Every record that must exist before each record can be created and linked."""
    parents: dict[str, set[str]] = {record.logical_id: set() for record in dataset.records}
    for child, required in dataset.organization.links.after_flags.items():
        parents[child].update(required)
    for edge in dataset.edges:
        parents[edge.target_record_id].add(edge.source_record_id)
    for record in dataset.records:
        index = int(record.logical_id.split(":")[1]) - 1
        for module_key, field_key in dataset.organization.links.reference_fields:
            if module_key != record.module_key:
                continue
            for target, target_index in reference_parents(
                module_key, field_key, index, dataset.module_counts, dataset.organization
            ):
                parents[record.logical_id].add(_logical_id(target, target_index))
    return {key: tuple(sorted(value)) for key, value in parents.items()}


def _module_sessions(dataset: SampleDataset) -> dict[str, deque[SampleSession]]:
    queues: dict[str, deque[SampleSession]] = {}
    for module_key, records in groupby(dataset.records, key=lambda record: record.module_key):
        sessions = deque(
            SampleSession(creator, module_key, batch)
            for creator, run in groupby(records, key=lambda record: record.creator_key)
            for batch in _short_batches(tuple(item.logical_id for item in run))
        )
        queues[module_key] = sessions
    return queues


def _short_batches(records: tuple[str, ...]) -> tuple[tuple[str, ...], ...]:
    """A sole eligible writer still returns in short sessions without changing owners."""
    if len(records) <= 6:
        return (records,)
    batch_count = (len(records) + 5) // 6
    size, extra = divmod(len(records), batch_count)
    batches = []
    offset = 0
    for index in range(batch_count):
        stop = offset + size + (index < extra)
        batches.append(records[offset:stop])
        offset = stop
    return tuple(batches)


def _link_sessions(dataset: SampleDataset) -> Mapping[str, tuple[tuple[int, str, str], ...]]:
    records = {record.logical_id: record for record in dataset.records}
    deferred: dict[str, list[tuple[int, str, str]]] = {}
    for index, edge in enumerate(dataset.edges):
        target = records[edge.target_record_id]
        actor = edge.creator_key or target.creator_key
        if actor != target.creator_key:
            module = records[edge.source_record_id].module_key
            deferred.setdefault(target.logical_id, []).append((index, actor, module))
    return {key: tuple(edges) for key, edges in deferred.items()}


def plan_sessions(dataset: SampleDataset) -> tuple[SampleSession, ...]:
    """Interleave create and update sessions so all modules and teams advance together."""
    rng = random.Random(f"{dataset.seed}:sessions")
    parents = record_parents(dataset)
    queues = _module_sessions(dataset)
    deferred_links = _link_sessions(dataset)
    histories = plan_history(dataset)
    after_history = dataset.organization.links.after_history
    required = {parent for parents in after_history.values() for parent in parents}
    if required - histories.keys():
        raise ValueError("A follow-up requires a parent with planned history")
    completed_histories: set[str] = set()
    remaining = {key: sum(len(item.record_ids) for item in queue) for key, queue in queues.items()}
    totals = dict(remaining)
    created: set[str] = set()
    plan: list[SampleSession] = []
    department = {record.module_key: record.actor_key for record in dataset.records}
    previous_department: str | None = None
    # Due history steps: (ready at plan position, record, step index).
    pending: list[tuple[int, str, int]] = []
    rejections = list(dataset.organization.rejections.activity_cases)

    def schedule_next(logical_id: str, step_index: int) -> None:
        if step_index < len(histories[logical_id].steps):
            pending.append((len(plan) + rng.randint(*_UPDATE_GAP), logical_id, step_index))

    while any(queues.values()) or pending or rejections:
        ready_cases = [case for case in rejections if set(case.needs) <= created]
        if ready_cases and (not any(queues.values()) or rng.random() < _REJECTION_TURN_SHARE):
            case = ready_cases[0]
            rejections.remove(case)
            plan.append(SampleSession(case.actor_key, "", (), kind="reject", case_key=case.key))
            continue
        if not any(queues.values()) and not pending:
            raise ValueError("Planned rejections need records that are never created")
        due = [item for item in pending if item[0] <= len(plan)]
        ready = [
            key
            for key, queue in queues.items()
            if queue
            and all(parent in created for item in queue[0].record_ids for parent in parents[item])
            and all(
                parent in completed_histories
                for item in queue[0].record_ids
                for parent in after_history.get(item, ())
            )
        ]
        if not ready and pending and not due:
            due = [min(pending)]  # Only updates are left: the next one is due now.
        if due and (not ready or rng.random() < _UPDATE_TURN_SHARE):
            session = _update_session(due, histories, department, previous_department, rng)
            for item in pending[:]:
                if (item[1], item[2]) in session.steps:
                    pending.remove(item)
            for logical_id, step_index in session.steps:
                schedule_next(logical_id, step_index + 1)
                if step_index + 1 == len(histories[logical_id].steps):
                    completed_histories.add(logical_id)
            plan.append(session)
            previous_department = department[session.module_key]
            continue
        if not ready:
            raise ValueError("Activity plan cannot order records after their parents")
        # Teams work in parallel: prefer another department than the last session, and
        # weight modules by the share of their work still left so all finish together.
        others = [key for key in ready if department[key] != previous_department]
        choices = others or ready
        weights = [(remaining[key] / totals[key]) ** 2 + 0.01 for key in choices]
        module_key = rng.choices(choices, weights=weights)[0]
        session = queues[module_key].popleft()
        plan.append(session)
        created.update(session.record_ids)
        links = [
            edge for logical_id in session.record_ids for edge in deferred_links.get(logical_id, ())
        ]
        for (actor, source_module), run in groupby(links, key=lambda edge: edge[1:]):
            indices = tuple(edge[0] for edge in run)
            plan.extend(
                SampleSession(
                    actor, source_module, (), kind="link", edge_indices=indices[start : start + 6]
                )
                for start in range(0, len(indices), 6)
            )
        for logical_id in session.record_ids:
            if logical_id in histories:
                schedule_next(logical_id, 0)
        remaining[module_key] -= len(session.record_ids)
        previous_department = department[module_key]
    return tuple(plan)


def _update_session(
    due: list[tuple[int, str, int]],
    histories: Mapping[str, RecordHistory],
    department: Mapping[str, str],
    previous_department: str | None,
    rng: random.Random,
) -> SampleSession:
    """One person's run of due updates in one module, preferring another department."""

    def owner(item: tuple[int, str, int]) -> tuple[str, str]:
        return histories[item[1]].steps[item[2]].updater_key, item[1].split(":")[0]

    preferred = [item for item in due if department[owner(item)[1]] != previous_department]
    first = min(preferred or due)
    person, module_key = owner(first)
    same = sorted(item for item in due if owner(item) == (person, module_key))
    chosen = same[: rng.choice((2, 3, 4, 5, 6))]
    return SampleSession(
        person, module_key, (), kind="update", steps=tuple((item[1], item[2]) for item in chosen)
    )
