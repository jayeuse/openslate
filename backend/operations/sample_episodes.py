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

from operations.sample_blueprint import SampleDataset
from operations.sample_history import RecordHistory, plan_history
from operations.sample_links import REFERENCE_FIELDS, reference_parents
from operations.sample_rejections import ACTIVITY_CASES


@dataclass(frozen=True)
class SampleSession:
    """One person's short run of work in one module: new records, or history updates."""

    creator_key: str
    module_key: str
    record_ids: tuple[str, ...]
    kind: str = "create"  # create, update or reject
    steps: tuple[tuple[str, int], ...] = ()  # (record, history step index) for updates
    case_key: str = ""  # the planned rejection a reject session sends


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
    for edge in dataset.edges:
        parents[edge.target_record_id].add(edge.source_record_id)
    for record in dataset.records:
        index = int(record.logical_id.split(":")[1]) - 1
        for module_key, field_key in REFERENCE_FIELDS:
            if module_key != record.module_key:
                continue
            for target, target_index in reference_parents(
                module_key, field_key, index, dataset.module_counts
            ):
                parents[record.logical_id].add(_logical_id(target, target_index))
    return {key: tuple(sorted(value)) for key, value in parents.items()}


def _module_sessions(dataset: SampleDataset) -> dict[str, deque[SampleSession]]:
    queues: dict[str, deque[SampleSession]] = {}
    for module_key, records in groupby(dataset.records, key=lambda record: record.module_key):
        sessions = deque(
            SampleSession(creator, module_key, tuple(item.logical_id for item in run))
            for creator, run in groupby(records, key=lambda record: record.creator_key)
        )
        queues[module_key] = sessions
    return queues


def plan_sessions(dataset: SampleDataset) -> tuple[SampleSession, ...]:
    """Interleave create and update sessions so all modules and teams advance together."""
    rng = random.Random(f"{dataset.seed}:sessions")
    parents = record_parents(dataset)
    queues = _module_sessions(dataset)
    histories = plan_history(dataset)
    remaining = {key: sum(len(item.record_ids) for item in queue) for key, queue in queues.items()}
    totals = dict(remaining)
    created: set[str] = set()
    plan: list[SampleSession] = []
    department = {record.module_key: record.actor_key for record in dataset.records}
    previous_department: str | None = None
    # Due history steps: (ready at plan position, record, step index).
    pending: list[tuple[int, str, int]] = []
    rejections = list(ACTIVITY_CASES)

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
        if not any(queues.values()) and not due:
            due = [min(pending)]  # Only updates are left: the next one is due now.
        if due and (not any(queues.values()) or rng.random() < _UPDATE_TURN_SHARE):
            session = _update_session(due, histories, department, previous_department, rng)
            for item in pending[:]:
                if (item[1], item[2]) in session.steps:
                    pending.remove(item)
            for logical_id, step_index in session.steps:
                schedule_next(logical_id, step_index + 1)
            plan.append(session)
            previous_department = department[session.module_key]
            continue
        ready = [
            key
            for key, queue in queues.items()
            if queue
            and all(parent in created for item in queue[0].record_ids for parent in parents[item])
        ]
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
