"""The retention sweep on PostgreSQL, as the runtime role under row-level security (D3)."""

from __future__ import annotations

import os
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, create_engine, delete, event, func, select, text, update
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.events.publisher import MAX_INVALIDATIONS_PER_COMMIT
from app.systems.platform.scheduling import retention
from app.systems.platform.scheduling import worker as worker_module
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.platform.scheduling.worker import ReportSchedulingWorker
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.record_triggers.execution import claim_due_events
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    RecordTriggerRun,
    TriggerEventState,
)
from app.systems.sandbox.record_triggers.runner import execute_claim
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.test_runs.models import SandboxTestRun
from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.platform_scheduling.retention_support import NOW, sweep, uuid7_at
from tests.postgres_runtime import assert_runner_database_url
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import create_document
from tests.sandbox_record_triggers.support import (
    cleanup_committed_trigger,
    document_baseline,
    publish_trigger,
)

pytestmark = pytest.mark.integration

DAY = timedelta(days=1)
SECOND = timedelta(seconds=1)
YOUNG_NOTIFICATIONS = 5_000
# The bound statements read 2 pages; without the bound they read about 93, all of these rows.
NOTIFICATION_PAGE_CEILING = 10


@dataclass(frozen=True)
class _World:
    db: Session
    actor: User
    module: Module
    fields: dict[str, Field]
    definition: RecordTrigger
    record: Record


@pytest.fixture
def world(integration_db: Session) -> _World:
    actor, module, fields, definition = publish_trigger(integration_db)
    record = Record(org_id=module.org_id, module_id=module.id, data={})
    integration_db.add(record)
    integration_db.flush()
    return _World(integration_db, actor, module, fields, definition, record)


def _event(
    world: _World,
    state: TriggerEventState,
    age: timedelta,
    *,
    root: RecordTriggerEvent | None = None,
) -> RecordTriggerEvent:
    running = state == TriggerEventState.RUNNING
    event = RecordTriggerEvent(
        org_id=world.module.org_id,
        record_id=world.record.id,
        module_id=world.module.id,
        event_kind="field-changed",
        root_event_id=root.id if root is not None else None,
        depth=1 if root is not None else 0,
        state=state,
        next_attempt_at=NOW - age,
        lease_token=uuid7() if running else None,
        lease_expires_at=NOW + DAY if running else None,
    )
    world.db.add(event)
    world.db.flush()
    return event


def _run(world: _World, event: RecordTriggerEvent) -> RecordTriggerRun:
    run = RecordTriggerRun(
        org_id=event.org_id,
        event_id=event.id,
        trigger_id=world.definition.id,
        state="skipped",
        details={},
    )
    world.db.add(run)
    world.db.flush()
    return run


def _ids(db: Session, model: Any, ids: list[UUID]) -> set[UUID]:
    return set(db.scalars(select(model.id).where(model.id.in_(ids))))


def _swept_audit(db: Session) -> list[AuditLog]:
    return list(db.scalars(select(AuditLog).where(AuditLog.request_method == "RETENTION")))


def test_finished_events_and_their_runs_go_at_their_period_and_others_stay_dbi4(
    world: _World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # DBI-4 (D3): 30 days for succeeded, 90 for failed; a period that has not fully passed stays.
    db = world.db
    gone = [
        _event(world, TriggerEventState.SUCCEEDED, 30 * DAY + SECOND),
        _event(world, TriggerEventState.FAILED, 90 * DAY + SECOND),
    ]
    kept = [
        _event(world, TriggerEventState.SUCCEEDED, 30 * DAY),
        _event(world, TriggerEventState.FAILED, 90 * DAY),
        # A failed event still inside the failed period, older than the succeeded one.
        _event(world, TriggerEventState.FAILED, 31 * DAY),
        _event(world, TriggerEventState.RUNNING, 400 * DAY),
        # Retrying: it is old, and its next attempt is still ahead.
        _event(world, TriggerEventState.PENDING, -DAY),
    ]
    gone_runs = [_run(world, event).id for event in gone]
    kept_runs = [_run(world, event).id for event in kept]
    gone_ids = [event.id for event in gone]
    kept_ids = [event.id for event in kept]

    sweep(db, monkeypatch)

    assert _ids(db, RecordTriggerEvent, gone_ids + kept_ids) == set(kept_ids)
    assert _ids(db, RecordTriggerRun, gone_runs + kept_runs) == set(kept_runs)
    audit = _swept_audit(db)
    assert {(row.entity_type, row.entity_id, row.action) for row in audit} == {
        ("record_trigger_runs", run_id, AuditAction.DELETE) for run_id in gone_runs
    }
    assert {row.actor_label for row in audit} == {"Scheduled retention"}


@pytest.mark.parametrize(
    ("child_state", "child_age", "chain_goes"),
    [
        pytest.param(TriggerEventState.PENDING, -DAY, False, id="unfinished-child"),
        # K7: DBI-4 keeps the old root for as long as its younger child stays.
        pytest.param(TriggerEventState.FAILED, 31 * DAY, False, id="younger-failed-child"),
        pytest.param(TriggerEventState.SUCCEEDED, 31 * DAY, True, id="finished-old-child"),
    ],
)
def test_an_old_root_stays_while_a_child_references_it_dbi4(
    world: _World,
    monkeypatch: pytest.MonkeyPatch,
    child_state: TriggerEventState,
    child_age: timedelta,
    chain_goes: bool,
) -> None:
    db = world.db
    root = _event(world, TriggerEventState.SUCCEEDED, 60 * DAY)
    child = _event(world, child_state, child_age, root=root)
    ids = [root.id, child.id]

    sweep(db, monkeypatch)

    assert _ids(db, RecordTriggerEvent, ids) == (set() if chain_goes else set(ids))


def _notification(
    world: _World,
    age: timedelta,
    *,
    read_age: timedelta | None = None,
    deleted: bool = False,
    id_age: timedelta | None = None,
) -> UUID:
    created = NOW - age
    notification = InAppNotification(
        id=uuid7_at(NOW - id_age if id_age is not None else created),
        created_at=created,
        org_id=world.module.org_id,
        kind="record-assigned",
        subject_type="record",
        subject_id=world.record.id,
        recipient_id=world.actor.id,
        read_at=NOW - read_age if read_age is not None else None,
        is_deleted=deleted,
        deleted_at=created if deleted else None,
    )
    world.db.add(notification)
    world.db.flush()
    return notification.id


def test_notifications_age_from_creation_by_read_state_and_each_delete_is_audited_dbi4(
    world: _World, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = world.db
    gone = [
        _notification(world, 30 * DAY + SECOND, read_age=DAY),  # read yesterday; age is creation
        _notification(world, 90 * DAY + SECOND),
        _notification(world, 90 * DAY + SECOND, deleted=True),
    ]
    kept = [
        _notification(world, 29 * DAY, read_age=DAY),
        _notification(world, 89 * DAY),
        # The id bound only prunes: an old id does not make a young row old.
        _notification(world, 29 * DAY, read_age=DAY, id_age=400 * DAY),
        _notification(world, 89 * DAY, id_age=400 * DAY),
    ]
    backup_created = NOW - 91 * DAY
    backup = InAppNotification(
        id=uuid7_at(backup_created),
        created_at=backup_created,
        org_id=None,
        kind="backup-failed",
        subject_type="backup_run",
        subject_id=uuid7(),
        recipient_id=world.actor.id,
    )
    db.add(backup)
    db.flush()
    backup_id = backup.id

    sweep(db, monkeypatch)

    assert _ids(db, InAppNotification, [*gone, *kept, backup_id]) == set(kept)
    deleted = [
        row.entity_id for row in _swept_audit(db) if row.entity_type == "in_app_notifications"
    ]
    assert sorted(deleted) == sorted([*gone, backup_id])


def _test_run(
    db: Session, document_id: UUID, org_id: UUID, age: timedelta, *, cleared: bool = False
) -> UUID:
    created = NOW - age
    run = SandboxTestRun(
        org_id=org_id,
        document_id=document_id,
        document_revision=1,
        document_hash="0" * 64,
        module_id="requests",
        input_values={},
        event={},
        result={},
        result_byte_count=0,
        created_at=created,
        is_deleted=cleared,
        deleted_at=created if cleared else None,
    )
    db.add(run)
    db.flush()
    return run.id


def test_a_document_keeps_its_latest_20_live_test_runs_and_loses_cleared_ones(
    integration_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_db
    org = organization(db)
    document = create_document(db, org)
    live = [_test_run(db, document.id, org.id, (index + 1) * DAY) for index in range(22)]
    # Newest of all: a cleared run neither stays nor takes one of the 20 places.
    cleared = [_test_run(db, document.id, org.id, SECOND, cleared=True)]

    sweep(db, monkeypatch)

    assert _ids(db, SandboxTestRun, [*live, *cleared]) == set(live[:20])
    deleted = [row.entity_id for row in _swept_audit(db) if row.entity_type == "sandbox_test_runs"]
    assert sorted(deleted) == sorted([*live[20:], *cleared])


def test_a_commit_holds_at_most_50_audited_rows(
    world: _World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # K2: 65 public invalidations in one commit become a resync for every open browser.
    assert retention.AUDITED_BATCH < MAX_INVALIDATIONS_PER_COMMIT
    db = world.db
    for _index in range(60):
        _run(world, _event(world, TriggerEventState.SUCCEEDED, 31 * DAY))
        _notification(world, 91 * DAY)

    sweep(db, monkeypatch)

    per_commit = Counter(row.request_id for row in _swept_audit(db))
    assert sorted(per_commit.values()) == [10, 10, 50, 50]
    assert db.scalar(select(func.count()).select_from(RecordTriggerEvent)) == 0


def test_a_wake_stops_at_its_batch_limit_and_when_the_worker_stops(
    world: _World, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = world.db
    old = [_notification(world, 91 * DAY) for _index in range(4)]
    monkeypatch.setattr(retention, "AUDITED_BATCH", 1)
    monkeypatch.setattr(retention, "BATCHES_PER_WAKE", 2)

    sweep(db, monkeypatch)
    assert len(_ids(db, InAppNotification, old)) == 2

    sweep(db, monkeypatch, stopping=lambda: len(_ids(db, InAppNotification, old)) == 1)
    assert len(_ids(db, InAppNotification, old)) == 1


@pytest.mark.parametrize(
    ("waited", "swept"),
    [
        pytest.param(10 * SECOND, False, id="backlog"),
        pytest.param(SECOND / 2, True, id="just-queued"),
    ],
)
def test_a_due_event_that_has_waited_stops_the_sweep(
    world: _World, monkeypatch: pytest.MonkeyPatch, waited: timedelta, swept: bool
) -> None:
    # K3: the burst delay depends on machine load, so the test owns the rule that causes it.
    db = world.db
    old = _event(world, TriggerEventState.SUCCEEDED, 31 * DAY)
    run = _run(world, old)
    notification = _notification(world, 91 * DAY)
    old_id, run_id = old.id, run.id
    _event(world, TriggerEventState.PENDING, waited)

    sweep(db, monkeypatch)

    remaining = 0 if swept else 1
    assert len(_ids(db, RecordTriggerEvent, [old_id])) == remaining
    assert len(_ids(db, RecordTriggerRun, [run_id])) == remaining
    assert len(_ids(db, InAppNotification, [notification])) == remaining


def test_a_held_retention_lock_stops_the_sweep(
    world: _World, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = world.db
    old = _event(world, TriggerEventState.SUCCEEDED, 31 * DAY)
    old_id = old.id
    name = f"{retention._LOCK_NAME}:{world.module.org_id}"
    other_process = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    try:
        with other_process.connect() as connection:
            connection.scalar(select(func.pg_advisory_lock(func.hashtextextended(name, 0))))
            sweep(db, monkeypatch)
            assert _ids(db, RecordTriggerEvent, [old_id]) == {old_id}
            connection.scalar(select(func.pg_advisory_unlock(func.hashtextextended(name, 0))))
        sweep(db, monkeypatch)
        assert _ids(db, RecordTriggerEvent, [old_id]) == set()
    finally:
        other_process.dispose()


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine]]:
    """The owner builds and removes committed rows; the sweep and the lane use runtime."""

    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    runtime_url = os.environ["TEST_DATABASE_URL"]
    assert_runner_database_url(owner_url, allowed_roles=frozenset({"slateops_owner"}))
    assert_runner_database_url(runtime_url, allowed_roles=frozenset({"slateops_runtime"}))
    owner = create_engine(owner_url, pool_size=2, max_overflow=0)
    runtime = create_engine(runtime_url, pool_size=3, max_overflow=0)
    try:
        yield owner, runtime
    finally:
        runtime.dispose()
        owner.dispose()


def _committed_event(
    db: Session, module: Module, record: Record, state: TriggerEventState, at: datetime
) -> UUID:
    event = RecordTriggerEvent(
        org_id=module.org_id,
        record_id=record.id,
        module_id=module.id,
        event_kind="field-changed",
        state=state,
        next_attempt_at=at,
    )
    db.add(event)
    db.flush()
    return event.id


def _lane_session(runtime: Engine, org_id: UUID) -> AuditSession:
    db = AuditSession(bind=runtime)
    scope_session(db, org_id)
    # A hang guard, not a time limit: a blocked lane fails here instead of hanging the test.
    db.connection().exec_driver_sql("SET LOCAL lock_timeout = '10s'")
    return db


def _pages_read(plan: dict[str, Any]) -> int:
    # Buffers count each page visit, warm or cold, so the number does not depend on the cache.
    return int(plan["Shared Hit Blocks"]) + int(plan["Shared Read Blocks"])


def test_the_notification_stage_reads_almost_nothing_with_no_old_row(
    engines: tuple[Engine, Engine],
) -> None:
    # On Harbor Large the age filter alone read all 1,693 pages of the organization's rows on
    # each wake; the id bound reads 2. Row-level security applies only to the runtime role, so
    # the statements are replayed there.
    owner, runtime = engines
    with Session(owner) as setup:
        org = create_organization(setup)
        recipient, _membership = create_member(
            setup, org, email=f"retention-{uuid7()}@example.test", username=f"retention-{uuid7()}"
        )
        setup.commit()
        org_id, recipient_id = org.id, recipient.id
    with owner.begin() as connection:
        connection.execute(
            InAppNotification.__table__.insert(),
            [
                {
                    "id": uuid7(),
                    "org_id": org_id,
                    "kind": "record-assigned",
                    "subject_type": "record",
                    "subject_id": uuid7(),
                    "recipient_id": recipient_id,
                }
                for _row in range(YOUNG_NOTIFICATIONS)
            ],
        )
        connection.execute(text("ANALYZE in_app_notifications"))
        table_pages = connection.scalar(
            text(
                "SELECT pg_relation_size('in_app_notifications') "
                "/ current_setting('block_size')::bigint"
            )
        )
    assert table_pages > 5 * NOTIFICATION_PAGE_CEILING

    captured: list[tuple[str, Any]] = []

    def capture(_connection, _cursor, statement, parameters, _context, _many) -> None:
        if "FROM in_app_notifications" in statement:
            captured.append((statement, parameters))

    try:
        with AuditSession(bind=runtime) as db:
            scope_session(db, org_id)
            event.listen(runtime, "before_cursor_execute", capture)
            try:
                assert retention.trim_notifications(db, utc_now()) == 0
            finally:
                event.remove(runtime, "before_cursor_execute", capture)
            assert len(captured) == 2, captured
            cursor = db.connection().connection.cursor()
            cursor.execute("SET LOCAL max_parallel_workers_per_gather = 0")
            pages = []
            for statement, parameters in captured:
                cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters)
                pages.append(_pages_read(cursor.fetchone()[0][0]["Plan"]))
            db.rollback()
        assert max(pages) <= NOTIFICATION_PAGE_CEILING, pages
    finally:
        with owner.begin() as connection:
            connection.execute(
                delete(InAppNotification).where(InAppNotification.org_id == org_id)
            )
            connection.execute(delete(Membership).where(Membership.user_id == recipient_id))
            connection.execute(delete(User).where(User.id == recipient_id))
            connection.execute(
                delete(WorkspaceProfile).where(WorkspaceProfile.id == org_id)
            )


def test_an_open_sweep_transaction_does_not_block_a_claim_and_its_run(
    engines: tuple[Engine, Engine], monkeypatch: pytest.MonkeyPatch
) -> None:
    # K3: the sweep's rows are finished, so a lane claims and runs the same record's next event
    # while the sweep holds them. A later wake goes through the worker on real organizations.
    owner, runtime = engines
    with AuditSession(bind=owner, expire_on_commit=False) as db:
        baseline = document_baseline(db)
        actor, module, _fields, definition = publish_trigger(db)
        record = Record(org_id=module.org_id, module_id=module.id, data={})
        db.add(record)
        db.flush()
        long_ago = utc_now() - 40 * DAY
        finished = _committed_event(db, module, record, TriggerEventState.SUCCEEDED, long_ago)
        run = RecordTriggerRun(
            org_id=module.org_id,
            event_id=finished,
            trigger_id=definition.id,
            state="skipped",
            details={},
        )
        db.add(run)
        due = _committed_event(db, module, record, TriggerEventState.PENDING, utc_now())
        db.commit()
        org_id, run_id = module.org_id, run.id

    try:
        with AuditSession(bind=runtime) as sweeping:
            scope_session(sweeping, org_id)
            sweeping.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid7(), request_method="RETENTION", request_path="/internal/test"
            )
            assert retention.trim_trigger_runs(sweeping, utc_now()) == 1
            assert retention.trim_trigger_events(sweeping, utc_now()) == 1

            with _lane_session(runtime, org_id) as lane:
                claims = claim_due_events(lane)
                lane.commit()
            assert [claim.id for claim in claims] == [due]
            with _lane_session(runtime, org_id) as lane:
                assert execute_claim(lane, claims[0])
                lane.commit()
            sweeping.commit()

        with AuditSession(bind=owner) as db:
            assert db.get(RecordTriggerRun, run_id) is None
            old_again = _committed_event(db, module, record, TriggerEventState.SUCCEEDED, long_ago)
            db.commit()
            monkeypatch.setattr(worker_module, "get_engine", lambda: runtime)
            ReportSchedulingWorker(
                SimpleNamespace(environment="test", e2e_background_workers=False)
            ).run_retention_once()
            events = dict(
                db.execute(
                    select(RecordTriggerEvent.id, RecordTriggerEvent.state).where(
                        RecordTriggerEvent.id.in_([finished, old_again, due])
                    )
                ).all()
            )
        assert events == {due: TriggerEventState.SUCCEEDED}
    finally:
        with owner.begin() as connection:
            connection.execute(delete(RecordTriggerRun).where(RecordTriggerRun.org_id == org_id))
            connection.execute(
                delete(RecordTriggerEvent).where(RecordTriggerEvent.org_id == org_id)
            )
            connection.execute(delete(Record).where(Record.org_id == org_id))
            connection.execute(delete(AuditLog).where(AuditLog.org_id == org_id))
            connection.execute(
                update(Department).where(Department.org_id == org_id).values(performed_by=actor.id)
            )
        cleanup_committed_trigger(
            owner,
            actor_id=actor.id,
            baseline=baseline,
            module_id=module.id,
            definition_id=definition.id,
        )
