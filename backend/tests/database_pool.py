"""One pooled engine per runner database URL for each pytest process.

A new PostgreSQL connection to the disposable stack costs tens of milliseconds, and every
integration test used to open three: two identity checks and its rolled-back session. The
shared engines keep connections open between tests instead. Each connection is reset with
``DISCARD ALL`` when it returns to the pool, so the next test starts from the same session
state as a new connection (no settings, temporary tables, prepared statements, advisory
locks or LISTEN channels carry over). A test that must be the database's only consumer
calls ``dispose_process_engines`` first.
"""

from __future__ import annotations

import gc
from threading import Lock

from sqlalchemy import Engine, create_engine, event

_ENGINES: dict[str, Engine] = {}
# Race tests create guarded engines from several threads at once.
_ENGINES_LOCK = Lock()


def _discard_session_state(dbapi_connection, connection_record) -> None:
    if dbapi_connection is None:
        return
    try:
        autocommit = dbapi_connection.autocommit
        dbapi_connection.autocommit = True
        try:
            dbapi_connection.execute("DISCARD ALL")
        finally:
            dbapi_connection.autocommit = autocommit
    except Exception:
        # A connection that cannot be reset is never reused.
        connection_record.invalidate()


def pooled_engine(database_url: str) -> Engine:
    """Return this process's pooled engine for *database_url*; callers guard it first."""
    with _ENGINES_LOCK:
        engine = _ENGINES.get(database_url)
        if engine is None:
            engine = create_engine(database_url, pool_pre_ping=True)
            event.listen(engine, "checkin", _discard_session_state)
            _ENGINES[database_url] = engine
        return engine


def dispose_pooled_engines() -> None:
    """Close every idle pooled connection, for tests that need to be the sole consumer."""
    with _ENGINES_LOCK:
        engines = list(_ENGINES.values())
    for engine in engines:
        engine.dispose()


def dispose_process_engines() -> None:
    """Close every idle connection this process owns before a sole-consumer check.

    That covers the shared test pools, the application's cached pool that earlier
    ``TestClient`` tests and workers filled, and pools of engines nothing references any
    more. ``Engine.dispose`` closes only checked-in connections, so a connection that an
    active test, thread or another process holds stays open and still fails the check.
    """
    from app.core.database.session import dispose_database_resources

    # Unreachable engines (a cleared ``get_engine`` cache, an undisposed test engine) close
    # their idle connections only when collected.
    gc.collect()
    dispose_pooled_engines()
    dispose_database_resources()
