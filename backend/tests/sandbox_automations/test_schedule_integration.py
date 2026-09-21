"""Database-backed bounded schedule processing guarantees."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.automations.execution import claim_due_events
from app.systems.sandbox.automations.models import (
    AutomationEventState,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.automations.outbox import enqueue_due_schedules
from app.systems.sandbox.automations.runner import execute_claim
from app.systems.sandbox.records.models import Record
from tests.postgres_runtime import assert_runner_database_url
from tests.sandbox_automations.support import (
    DocumentBaseline,
    cleanup_committed_automation,
    document_baseline,
    publish_automation,
    schedule_automation,
)

pytestmark = pytest.mark.integration


def test_schedule_freezes_upper_bound_and_completes_more_than_one_chunk(
    integration_owner_db: Session,
) -> None:
    profile = integration_owner_db.scalar(
        select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
    )
    assert profile is not None
    profile.timezone = "Asia/Manila"
    _actor, module, fields, definition = publish_automation(
        integration_owner_db, automation=schedule_automation()
    )
    records = [
        Record(
            module_id=module.id,
            data={
                str(fields["request-number"].id): f"REQ-{index:03d}",
                str(fields["status"].id): "Complete",
            },
        )
        for index in range(101)
    ]
    integration_owner_db.add_all(records)
    integration_owner_db.commit()
    instant = datetime(2026, 9, 21, 0, 30, tzinfo=UTC)

    assert enqueue_due_schedules(integration_owner_db, now=instant) == 1
    assert enqueue_due_schedules(integration_owner_db, now=instant) == 0
    integration_owner_db.commit()
    event = integration_owner_db.scalar(select(PublishedAutomationEvent))
    assert event is not None and event.schedule_upper_record_id is not None
    upper_bound = event.schedule_upper_record_id

    claims = claim_due_events(integration_owner_db)
    assert len(claims) == 1
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claims[0])
    integration_owner_db.commit()
    integration_owner_db.refresh(event)
    assert event.state == AutomationEventState.PENDING
    assert event.attempt_count == 0
    assert event.schedule_cursor_record_id is not None
    assert event.schedule_matched_count == 100

    late_record = Record(
        module_id=module.id,
        data={
            str(fields["request-number"].id): "REQ-LATE",
            str(fields["status"].id): "Open",
        },
    )
    integration_owner_db.add(late_record)
    integration_owner_db.commit()
    assert late_record.id > upper_bound

    claims = claim_due_events(integration_owner_db)
    assert len(claims) == 1
    integration_owner_db.commit()
    assert execute_claim(integration_owner_db, claims[0])
    integration_owner_db.commit()

    integration_owner_db.refresh(event)
    run = integration_owner_db.scalar(
        select(PublishedAutomationRun).where(
            PublishedAutomationRun.event_id == event.id,
            PublishedAutomationRun.automation_id == definition.id,
        )
    )
    integration_owner_db.refresh(late_record)
    assert event.state == AutomationEventState.SUCCEEDED
    assert event.schedule_matched_count == 101
    assert event.schedule_action_count == 0
    assert run is not None
    assert run.details == {"recordsMatched": 101, "actionsApplied": 0}
    assert late_record.data[str(fields["status"].id)] == "Open"


def test_two_sessions_dedupe_schedule_and_claim_one_event() -> None:
    database_url = os.getenv("MIGRATION_DATABASE_URL")
    if database_url is None:
        pytest.skip("requires the disposable PostgreSQL integration database")
    assert_runner_database_url(database_url, allowed_roles=frozenset({"openslate_owner"}))
    engine = create_engine(database_url, pool_size=4, max_overflow=0)
    instant = datetime(2026, 9, 21, 8, 30, tzinfo=UTC)
    cleanup_state: tuple[UUID, UUID, UUID, DocumentBaseline] | None = None
    try:
        with AuditSession(bind=engine) as db:
            baseline = document_baseline(db)
            actor, module, _fields, definition = publish_automation(
                db, automation=schedule_automation()
            )
            db.commit()
            cleanup_state = (actor.id, module.id, definition.id, baseline)

        barrier = Barrier(2)

        def enqueue() -> int:
            with AuditSession(bind=engine) as db:
                barrier.wait(timeout=10)
                count = enqueue_due_schedules(db, now=instant)
                db.commit()
                return count

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(enqueue), pool.submit(enqueue)]
            queued = sorted(future.result() for future in futures)
        assert queued == [0, 1]

        with AuditSession(bind=engine) as db:
            assert db.scalar(select(func.count()).select_from(PublishedAutomationEvent)) == 1
            db.commit()

        claim_barrier = Barrier(2)

        def claim() -> int:
            with AuditSession(bind=engine) as db:
                claim_barrier.wait(timeout=10)
                count = len(claim_due_events(db))
                db.commit()
                return count

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(claim), pool.submit(claim)]
            claimed = sorted(future.result() for future in futures)
        assert claimed == [0, 1]
    finally:
        if cleanup_state is not None:
            actor_id, module_id, definition_id, baseline = cleanup_state
            cleanup_committed_automation(
                engine,
                actor_id=actor_id,
                module_id=module_id,
                definition_id=definition_id,
                baseline=baseline,
            )
        engine.dispose()
