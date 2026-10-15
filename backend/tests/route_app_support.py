"""The complete application for route tests, without the process lifespan.

``route_app()`` returns ``create_app()`` unchanged (middleware, exception handlers,
routers, dependencies, real authentication and ``app.state``) except that entering a
``TestClient`` no longer runs ``application_lifespan``. ``with TestClient(...)`` still
keeps one event-loop portal for the block, as before.

The lifespan adds only process resources that route tests do not read:

- the instance-target check, which the per-test guard in ``tests/conftest.py``
  (``_guard_for_test``) already runs against the same database for every integration test;
- the PostgreSQL ``LISTEN`` thread that feeds ``app.state.events_hub``; ``create_app()``
  still builds the hub, and only the event-stream routes read it;
- the trigger and report workers, which never start under ``ENVIRONMENT=test``, and the
  provider sign-out thread;
- disposing the application pool at exit. Tests that must be the database's only consumer
  call ``tests.database_pool.dispose_process_engines`` first, as they already do for
  clients that never entered the lifespan.

The lifespan itself has its own owners: ``tests/auth/test_provider_signout_lifespan.py``,
``tests/sandbox_record_triggers/test_worker_lifecycle.py``,
``tests/platform_scheduling/test_worker_lifecycle.py`` and the runner instance-guard tests.
Tests of event streams or of the lifespan must keep using ``create_app()``.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.main import create_app


@asynccontextmanager
async def _no_process_resources(_app: FastAPI) -> AsyncIterator[None]:
    yield


def route_app() -> FastAPI:
    """Return a new ``create_app()`` whose test clients skip ``application_lifespan``."""

    application = create_app()
    application.router.lifespan_context = _no_process_resources
    return application
