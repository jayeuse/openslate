"""Disposable PostgreSQL proof for audited invalidation delivery."""

import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.config import get_settings
from app.core.database.organization_scope import worker_organization
from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.events.hub import (
    CHANNEL,
    EventHub,
    EventViewer,
    PostgresInvalidationListener,
    _psycopg_url,
)
from app.systems.platform.events.publisher import InvalidationPublisher
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import create_organization, guarded_create_engine

READABLE_MODULE = uuid7()


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)


@pytest.mark.integration
def test_audited_commit_publishes_to_listener_and_rollback_is_silent() -> None:
    asyncio.run(_exercise_postgres_invalidation())


async def _exercise_postgres_invalidation() -> None:
    runtime_url = os.environ["TEST_DATABASE_URL"]
    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    _assert_runtime_settings_target(get_settings().database_url, runtime_url)
    organization_id = uuid7()
    hub = EventHub()
    subscriber = await hub.subscribe(
        EventViewer(
            user_id="event-integration-user", role="member",
            module_ids=frozenset({READABLE_MODULE}), org_id=organization_id,
        )
    )
    listener = PostgresInvalidationListener(hub)
    runtime_engine = guarded_create_engine(runtime_url)
    cleanup_engine = guarded_create_engine(owner_url)
    try:
        with Session(cleanup_engine) as setup:
            create_organization(setup, id=organization_id)
            setup.commit()
        listener.start()
        assert await asyncio.wait_for(subscriber.queue.get(), timeout=5) is None

        committed = Department(org_id=organization_id, department_name="event-commit")
        with AuditSession(runtime_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_method="POST",
                request_path="/api/test",
            )
            db.add(committed)
            db.flush()
            db.commit()

        event = await asyncio.wait_for(subscriber.queue.get(), timeout=5)
        assert event is not None
        assert event.entity == "departments"
        assert event.entity_id is None
        assert event.all_authenticated
        assert event.to_payload() == {"entity": "departments"}

        with AuditSession(runtime_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_method="POST",
                request_path="/api/test",
            )
            db.add(Department(org_id=organization_id, department_name="event-rollback"))
            db.flush()
            db.rollback()

        with pytest.raises(TimeoutError):
            await asyncio.wait_for(subscriber.queue.get(), timeout=0.3)
    finally:
        listener.stop()
        await hub.unsubscribe(subscriber)
        runtime_engine.dispose()
        try:
            with cleanup_engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM public.audit_logs WHERE org_id = :org_id"),
                    {"org_id": organization_id},
                )
                connection.execute(
                    text("DELETE FROM public.departments WHERE org_id = :org_id"),
                    {"org_id": organization_id},
                )
                connection.execute(
                    text("DELETE FROM public.organizations WHERE id = :org_id"),
                    {"org_id": organization_id},
                )
        finally:
            cleanup_engine.dispose()


@pytest.mark.integration
def test_a_listener_receives_every_invalidation_of_200_concurrent_commits_or_a_resync() -> None:
    runtime_url = os.environ["TEST_DATABASE_URL"]
    _assert_runtime_settings_target(get_settings().database_url, runtime_url)
    organization_id = uuid7()
    runtime_engine = guarded_create_engine(runtime_url)
    cleanup_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    publisher = InvalidationPublisher()
    listener = psycopg.connect(_psycopg_url(runtime_url), autocommit=True)
    try:
        with Session(cleanup_engine) as setup:
            create_organization(setup, id=organization_id)
            department = Department(org_id=organization_id, department_name="event-load")
            setup.add(department)
            setup.commit()
            department_id = department.id
        listener.execute(f"LISTEN {CHANNEL}")
        publisher.start()

        def commit(index: int) -> UUID:
            with worker_organization(organization_id), AuditSession(runtime_engine) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_method="POST", request_path="/api/test",
                )
                module = Module(
                    org_id=organization_id, department_id=department_id,
                    module_name=f"event-load-{index}",
                )
                db.add(module)
                db.flush()
                db.commit()
                return module.id

        with ThreadPoolExecutor(max_workers=8) as pool:
            committed = set(pool.map(commit, range(200)))
        assert publisher.drain(30)

        received: set[UUID] = set()
        resynced = False
        # Hang guard only: every NOTIFY was sent before drain returned.
        for notification in listener.notifies(timeout=10):
            payload = json.loads(notification.payload)
            if payload["entity"] == "resync":
                resynced = True
            elif payload.get("org_id") == str(organization_id):
                assert payload["entity"] == "modules"
                received.add(UUID(payload["entity_id"]))
            if resynced or received == committed:
                break
        assert len(committed) == 200
        assert resynced or received == committed
    finally:
        publisher.stop()
        listener.close()
        runtime_engine.dispose()
        try:
            with cleanup_engine.begin() as connection:
                for table in ("audit_logs", "modules", "departments"):
                    connection.execute(
                        text(f"DELETE FROM public.{table} WHERE org_id = :org_id"),
                        {"org_id": organization_id},
                    )
                connection.execute(
                    text("DELETE FROM public.organizations WHERE id = :org_id"),
                    {"org_id": organization_id},
                )
        finally:
            cleanup_engine.dispose()


def _assert_runtime_settings_target(configured_url: str, runtime_url: str) -> None:
    """Fail closed unless the app configuration is the runner-owned runtime target."""

    configured = make_url(configured_url)
    expected = make_url(runtime_url)
    if configured != expected or configured.username != "openslate_runtime":
        raise RuntimeError("Event integration requires the runner-owned runtime database")
