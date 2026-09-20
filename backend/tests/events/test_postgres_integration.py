"""Disposable PostgreSQL proof for audited invalidation delivery."""

import asyncio
import os
from types import SimpleNamespace
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.core.database.session import AuditSession
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.events.hub import EventHub, PostgresInvalidationListener
from app.systems.sandbox.departments.models import Department
from tests.conftest import guarded_create_engine

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
    committed_id: UUID | None = None
    hub = EventHub()
    subscriber = await hub.subscribe(
        SimpleNamespace(
            id="event-integration-user",
            role=SimpleNamespace(role="member", permissions={"departments.read": True}),
        )
    )
    listener = PostgresInvalidationListener(hub)
    runtime_engine = guarded_create_engine(runtime_url)
    listener.start()
    try:
        assert await asyncio.wait_for(subscriber.queue.get(), timeout=5) is None

        committed = Department(department_name="event-commit")
        with AuditSession(runtime_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_method="POST",
                request_path="/api/test",
            )
            db.add(committed)
            db.flush()
            committed_id = committed.id
            db.commit()

        event = await asyncio.wait_for(subscriber.queue.get(), timeout=5)
        assert event is not None
        assert event.entity == "departments"
        assert event.entity_id == committed_id
        assert event.to_payload() == {
            "entity": "departments",
            "entity_id": str(committed_id),
            "capability": "departments.read",
        }

        with AuditSession(runtime_engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_method="POST",
                request_path="/api/test",
            )
            db.add(Department(department_name="event-rollback"))
            db.flush()
            db.rollback()

        with pytest.raises(TimeoutError):
            await asyncio.wait_for(subscriber.queue.get(), timeout=0.3)
    finally:
        listener.stop()
        await hub.unsubscribe(subscriber)
        runtime_engine.dispose()
        cleanup_engine = guarded_create_engine(owner_url)
        try:
            with cleanup_engine.begin() as connection:
                if committed_id is not None:
                    connection.execute(
                        text("DELETE FROM public.audit_logs WHERE entity_id = :entity_id"),
                        {"entity_id": committed_id},
                    )
                connection.execute(
                    text(
                        "DELETE FROM public.departments "
                        "WHERE department_name IN ('event-commit', 'event-rollback')"
                    )
                )
        finally:
            cleanup_engine.dispose()


def _assert_runtime_settings_target(configured_url: str, runtime_url: str) -> None:
    """Fail closed unless the app configuration is the runner-owned runtime target."""

    configured = make_url(configured_url)
    expected = make_url(runtime_url)
    if configured != expected or configured.username != "openslate_runtime":
        raise RuntimeError("Event integration requires the runner-owned runtime database")
