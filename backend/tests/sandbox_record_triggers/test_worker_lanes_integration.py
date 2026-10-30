"""Several trigger lanes keep automations fast, one record's events in order, and stop clean."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, create_engine, delete, func, select, update
from sqlalchemy.exc import OperationalError
from uuid6 import uuid7

from app.core.config import Settings
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.boards.models import Board
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import TriggerDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.record_triggers import worker as worker_module
from app.systems.sandbox.record_triggers.execution import ClaimedTriggerEvent, claim_due_events
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.record_triggers.outbox import enqueue_record_event
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from tests.config_support import settings_values
from tests.postgres_runtime import assert_runner_database_url
from tests.race_support import WAIT, StatementPause
from tests.sandbox_record_triggers.support import (
    DocumentBaseline,
    cleanup_committed_trigger,
    document_baseline,
    field_change_trigger,
    option_id,
    publish_trigger,
)

pytestmark = pytest.mark.integration

LANES = 4
_UNFINISHED = (TriggerEventState.PENDING, TriggerEventState.RUNNING)


@dataclass(frozen=True)
class _Organization:
    org_id: UUID
    actor_id: UUID
    module_id: UUID
    definition_id: UUID
    baseline: DocumentBaseline
    fields: dict[str, Field]
    data: dict[str, object]


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    """The owner builds and removes committed rows; lanes use the RLS-bound runtime role."""

    # The runner always provides both; a missing one fails here instead of skipping.
    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    runtime_url = os.environ["TEST_DATABASE_URL"]
    assert_runner_database_url(owner_url, allowed_roles=frozenset({"openslate_owner"}))
    assert_runner_database_url(runtime_url, allowed_roles=frozenset({"openslate_runtime"}))
    owner = create_engine(owner_url, pool_size=2, max_overflow=0)
    runtime = create_engine(runtime_url, pool_size=LANES + 2, max_overflow=0)
    try:
        yield owner, runtime
    finally:
        runtime.dispose()
        owner.dispose()


@pytest.fixture
def organizations(engines: tuple[Engine, Engine]) -> Iterator[list[_Organization]]:
    created: list[_Organization] = []
    try:
        yield created
    finally:
        for organization in created:
            _remove(engines[0], organization)


def _record_created_trigger() -> TriggerDocument:
    """A record-created trigger with no conditions that sets the status to In progress."""

    payload = field_change_trigger().model_dump(by_alias=True, mode="json")
    payload["trigger"] = {"kind": "record-created", "moduleId": "sample-requests"}
    payload["conditionGroup"] = {"operator": "all", "conditions": []}
    return TriggerDocument.model_validate(payload)


def _publish(owner: Engine, created: list[_Organization]) -> _Organization:
    with AuditSession(bind=owner, expire_on_commit=False) as db:
        baseline = document_baseline(db)
        actor, module, fields, definition = publish_trigger(
            db, record_trigger=_record_created_trigger()
        )
        db.commit()
    organization = _Organization(
        org_id=module.org_id,
        actor_id=actor.id,
        module_id=module.id,
        definition_id=definition.id,
        baseline=baseline,
        fields=fields,
        data={
            str(fields["request-number"].id): "REQ-LANE",
            str(fields["priority"].id): option_id(fields["priority"], "Low"),
            str(fields["status"].id): option_id(fields["status"], "Open"),
        },
    )
    created.append(organization)
    return organization


def _queue(owner: Engine, organization: _Organization, count: int, *, edits: int = 0) -> list[UUID]:
    """Create ``count`` records in one transaction, as an import does, and their events.

    ``edits`` more field changes of the first record follow its creation event.
    """

    with AuditSession(bind=owner, expire_on_commit=False) as db:
        scope_session(db, organization.org_id)
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=organization.actor_id,
            request_id=uuid7(),
            request_method="POST",
            request_path="/api/records/import",
        )
        records = [
            Record(
                org_id=organization.org_id,
                module_id=organization.module_id,
                data=dict(organization.data),
            )
            for _record in range(count)
        ]
        db.add_all(records)
        db.flush()
        for record in records:
            enqueue_record_event(db, record, previous=None)
        title = str(organization.fields["title"].id)
        for edit in range(edits):
            previous = dict(records[0].data)
            records[0].data = {**records[0].data, title: f"Edit {edit}"}
            db.flush()
            enqueue_record_event(db, records[0], previous=previous)
        db.commit()
        return [record.id for record in records]


@contextmanager
def _lanes(
    runtime: Engine, org_ids: list[UUID], monkeypatch: pytest.MonkeyPatch, lanes: int = LANES
) -> Iterator[worker_module.TriggerWorker]:
    monkeypatch.setattr(worker_module, "get_engine", lambda: runtime)
    monkeypatch.setattr(worker_module, "active_organization_ids", lambda _engine: list(org_ids))
    settings = Settings(
        **settings_values(e2e_background_workers=True, trigger_workers=lanes), _env_file=None
    )
    worker = worker_module.TriggerWorker(settings)
    try:
        yield worker
    finally:
        assert worker.stop(), "a trigger lane did not stop"


def _unfinished(owner: Engine, org_ids: list[UUID]) -> int:
    with owner.connect() as connection:
        return (
            connection.scalar(
                select(func.count())
                .select_from(RecordTriggerEvent)
                .where(
                    RecordTriggerEvent.org_id.in_(org_ids),
                    RecordTriggerEvent.state.in_(_UNFINISHED),
                )
            )
            or 0
        )


def _wait_until_drained(owner: Engine, org_ids: list[UUID], *, guard: float = 120.0) -> None:
    deadline = time.monotonic() + guard
    while _unfinished(owner, org_ids):
        assert time.monotonic() < deadline, "the trigger lanes never drained the queue"
        threading.Event().wait(0.05)


def _longest_delay(owner: Engine, record_ids: list[UUID]) -> float:
    """The longest time any event of these records waited from its change to its finished run."""

    with owner.connect() as connection:
        rows = connection.execute(
            select(
                RecordTriggerEvent.created_at,
                RecordTriggerEvent.updated_at,
                RecordTriggerEvent.state,
            ).where(RecordTriggerEvent.record_id.in_(record_ids))
        ).all()
    assert rows and {row.state for row in rows} == {TriggerEventState.SUCCEEDED}
    return max((row.updated_at - row.created_at).total_seconds() for row in rows)


def _timed_runs(
    worker: worker_module.TriggerWorker, monkeypatch: pytest.MonkeyPatch
) -> list[tuple[float, float, UUID]]:
    """Record when each claimed event started and finished running, commit included."""

    runs: list[tuple[float, float, UUID]] = []
    guard = threading.Lock()
    run_claim = worker._run_claim

    def timed(claim: ClaimedTriggerEvent) -> None:
        started = time.perf_counter()
        run_claim(claim)
        with guard:
            runs.append((started, time.perf_counter(), claim.id))

    monkeypatch.setattr(worker, "_run_claim", timed)
    return runs


def _most_at_once(runs: list[tuple[float, float, UUID]]) -> int:
    edges = sorted([(start, 1) for start, _end, _id in runs] + [(end, -1) for _s, end, _id in runs])
    running = most = 0
    for _instant, step in edges:
        running += step
        most = max(most, running)
    return most


@pytest.mark.parametrize(
    ("organization_count", "records_each"),
    [
        pytest.param(4, 40, id="several-organizations"),
        pytest.param(1, 160, id="one-organization-one-module"),
    ],
)
def test_lanes_share_a_burst_of_record_changes(
    engines: tuple[Engine, Engine],
    organizations: list[_Organization],
    monkeypatch: pytest.MonkeyPatch,
    organization_count: int,
    records_each: int,
) -> None:
    # Seven-pack probe: one thread ran every event of every organization, 35 ms each;
    # School's record-created automations waited up to 36 s against a 2 s target. Four
    # lanes run a burst's events at the same time, across organizations and inside one
    # module. The wait itself depends on the machine's load, so it is reported, not owned.
    owner, runtime = engines
    for _organization in range(organization_count):
        _publish(owner, organizations)
    org_ids = [organization.org_id for organization in organizations]
    burst = [
        record_id
        for organization in organizations
        for record_id in _queue(owner, organization, records_each)
    ]

    with _lanes(runtime, org_ids, monkeypatch) as worker:
        runs = _timed_runs(worker, monkeypatch)
        worker.start()
        _wait_until_drained(owner, org_ids)

    delay = _longest_delay(owner, burst)
    at_once = _most_at_once(runs)
    assert at_once >= 2, f"at most {at_once} event ran at once; longest wait {delay:.2f} s"
    for organization in organizations:
        with owner.connect() as connection:
            statuses = connection.scalars(
                select(Record.data[str(organization.fields["status"].id)].astext).where(
                    Record.module_id == organization.module_id
                )
            ).all()
        assert set(statuses) == {option_id(organization.fields["status"], "In progress")}


def test_a_second_claimer_skips_a_record_whose_earlier_event_is_being_claimed(
    engines: tuple[Engine, Engine], organizations: list[_Organization]
) -> None:
    owner, runtime = engines
    organization = _publish(owner, organizations)
    _queue(owner, organization, 1, edits=1)
    holder_engine = create_engine(os.environ["TEST_DATABASE_URL"], pool_size=1, max_overflow=0)
    pause = StatementPause(holder_engine, "UPDATE RECORD_TRIGGER_EVENTS SET STATE")
    held: list[Any] = []

    def claim_first() -> None:
        with AuditSession(bind=holder_engine) as db:
            scope_session(db, organization.org_id)
            claims = claim_due_events(db, limit=1)
            db.commit()
            held.extend(claims)

    def claim(db_engine: Engine) -> list[ClaimedTriggerEvent]:
        with AuditSession(bind=db_engine) as db:
            scope_session(db, organization.org_id)
            claims = claim_due_events(db)
            db.commit()
            return claims

    holder = threading.Thread(target=claim_first)
    try:
        holder.start()
        assert pause.paused.wait(WAIT), "the first claim never reached its update"
        # The first claimer holds the creation event FOR UPDATE and has not committed.
        assert claim(runtime) == []
        pause.release.set()
        holder.join(WAIT)
        assert len(held) == 1
        # The creation event is running, so the edit still waits.
        assert claim(runtime) == []
        with AuditSession(bind=runtime) as db:
            scope_session(db, organization.org_id)
            assert execute_claim(db, held[0])
            db.commit()
        later = claim(runtime)
    finally:
        pause.remove()
        holder.join(WAIT)
        holder_engine.dispose()

    with owner.connect() as connection:
        events = connection.execute(
            select(RecordTriggerEvent.id, RecordTriggerEvent.event_kind, RecordTriggerEvent.depth)
            .where(RecordTriggerEvent.org_id == organization.org_id)
            .order_by(RecordTriggerEvent.id)
        ).all()
    # Creation, the edit, then the change the creation's trigger made.
    assert [(event.event_kind, event.depth) for event in events] == [
        ("record-created", 0),
        ("field-changed", 0),
        ("field-changed", 1),
    ]
    assert held[0].id == events[0].id
    assert [claimed.id for claimed in later] == [events[1].id]


def test_four_lanes_run_one_records_events_in_creation_order_without_overlap(
    engines: tuple[Engine, Engine],
    organizations: list[_Organization],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner, runtime = engines
    organization = _publish(owner, organizations)
    hot, *_others = _queue(owner, organization, 40, edits=8)

    with _lanes(runtime, [organization.org_id], monkeypatch) as worker:
        runs = _timed_runs(worker, monkeypatch)
        worker.start()
        _wait_until_drained(owner, [organization.org_id])

    with owner.connect() as connection:
        hot_events = list(
            connection.scalars(
                select(RecordTriggerEvent.id)
                .where(RecordTriggerEvent.record_id == hot)
                .order_by(RecordTriggerEvent.id)
            )
        )
    hot_runs = sorted(run for run in runs if run[2] in set(hot_events))
    # Creation, eight edits, and the status change the creation's trigger made.
    assert len(hot_events) == 10
    assert [run[2] for run in hot_runs] == hot_events
    for earlier, later in zip(hot_runs, hot_runs[1:], strict=False):
        assert later[0] >= earlier[1], "two events of one record ran at the same time"
    assert len({run[2] for run in runs}) == len(runs)


def test_stop_joins_every_lane_and_returns_claims_it_did_not_run(
    engines: tuple[Engine, Engine],
    organizations: list[_Organization],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner, runtime = engines
    organization = _publish(owner, organizations)
    _queue(owner, organization, 40)
    busy = threading.Barrier(LANES + 1, timeout=WAIT)
    in_flight: list[UUID] = []
    record = threading.Lock()

    with _lanes(runtime, [organization.org_id], monkeypatch) as worker:

        def hold(claim: ClaimedTriggerEvent) -> None:
            # Every lane holds its first event until shutdown, as a long run would.
            with record:
                in_flight.append(claim.id)
            busy.wait()
            worker._stop.wait(WAIT)

        monkeypatch.setattr(worker, "_run_claim", hold)
        worker.start()
        busy.wait()
        assert sum(t.name.startswith("openslate-triggers-") for t in threading.enumerate()) == 4
        assert worker.stop()
        assert worker.running is False
        assert not any(t.name.startswith("openslate-triggers-") for t in threading.enumerate())

    with owner.connect() as connection:
        rows = connection.execute(
            select(
                RecordTriggerEvent.id,
                RecordTriggerEvent.state,
                RecordTriggerEvent.attempt_count,
                RecordTriggerEvent.lease_token,
            ).where(RecordTriggerEvent.org_id == organization.org_id)
        ).all()
    running = {row.id for row in rows if row.state == TriggerEventState.RUNNING}
    returned = [row for row in rows if row.state == TriggerEventState.PENDING]
    assert len(rows) == 40
    assert running == set(in_flight) and len(running) == LANES
    assert len(returned) == 36
    assert all(row.attempt_count == 0 and row.lease_token is None for row in returned)


def test_two_runs_in_one_module_overlap_and_a_publication_still_waits_for_them(
    engines: tuple[Engine, Engine], organizations: list[_Organization]
) -> None:
    # A run reads its module's fields and triggers FOR SHARE: another record's run goes
    # ahead, and a publication's FOR UPDATE on those rows still waits for the run.
    owner, runtime = engines
    organization = _publish(owner, organizations)
    _queue(owner, organization, 2)
    with AuditSession(bind=runtime) as db:
        scope_session(db, organization.org_id)
        first, second = claim_due_events(db)
        db.commit()
    holder_engine = create_engine(os.environ["TEST_DATABASE_URL"], pool_size=1, max_overflow=0)
    pause = StatementPause(holder_engine, "UPDATE RECORD_TRIGGER_EVENTS SET STATE")
    held: list[Any] = []

    def run_first() -> None:
        with AuditSession(bind=holder_engine) as db:
            scope_session(db, organization.org_id)
            held.append(execute_claim(db, first))
            db.commit()

    holder = threading.Thread(target=run_first)
    try:
        holder.start()
        assert pause.paused.wait(WAIT), "the first run never reached its last update"
        with AuditSession(bind=runtime) as db:
            scope_session(db, organization.org_id)
            # A hang guard: the base FOR UPDATE made this run wait for the first one.
            db.connection().exec_driver_sql("SET LOCAL lock_timeout = '3s'")
            assert execute_claim(db, second)
            db.commit()
        for model, column in ((Field, Field.module_id), (RecordTrigger, RecordTrigger.module_id)):
            with AuditSession(bind=runtime) as db:
                scope_session(db, organization.org_id)
                with pytest.raises(OperationalError):
                    db.scalars(
                        select(model.id)
                        .where(column == organization.module_id)
                        .with_for_update(nowait=True)
                    ).all()
        pause.release.set()
        holder.join(WAIT)
    finally:
        pause.remove()
        holder.join(WAIT)
        holder_engine.dispose()

    assert held == [True]
    with owner.connect() as connection:
        states = connection.scalars(
            select(RecordTriggerEvent.state).where(RecordTriggerEvent.id.in_([first.id, second.id]))
        ).all()
    assert states == [TriggerEventState.SUCCEEDED] * 2


def _remove(owner: Engine, organization: _Organization) -> None:
    """Remove this test's committed rows: lane results first, then the published trigger."""

    with owner.begin() as connection:
        connection.execute(
            delete(RecordTriggerRun).where(RecordTriggerRun.org_id == organization.org_id)
        )
        connection.execute(
            delete(RecordTriggerEvent).where(RecordTriggerEvent.org_id == organization.org_id)
        )
        connection.execute(delete(Record).where(Record.org_id == organization.org_id))
        connection.execute(delete(AuditLog).where(AuditLog.org_id == organization.org_id))
        # Later writes in the organization restamp its department; the shared cleanup
        # finds the department and its Board by the publishing actor.
        connection.execute(
            update(Department)
            .where(Department.org_id == organization.org_id)
            .values(performed_by=organization.actor_id)
        )
    cleanup_committed_trigger(
        owner,
        actor_id=organization.actor_id,
        baseline=organization.baseline,
        module_id=organization.module_id,
        definition_id=organization.definition_id,
    )
    with owner.begin() as connection:
        assert (
            connection.scalar(
                select(func.count()).select_from(Board).where(Board.org_id == organization.org_id)
            )
            == 0
        )
        assert (
            connection.scalar(
                select(func.count())
                .select_from(RecordTrigger)
                .where(RecordTrigger.org_id == organization.org_id)
            )
            == 0
        )
        assert (
            connection.scalar(
                select(func.count()).select_from(Module).where(Module.org_id == organization.org_id)
            )
            == 0
        )
