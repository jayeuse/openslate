"""One pooled engine per runner database URL for each pytest process.

A new PostgreSQL connection to the disposable stack costs tens of milliseconds, and every
integration test used to open three: two identity checks and its rolled-back session. The
shared engines keep connections open between tests instead. Each connection is reset with
``DISCARD ALL`` when it returns to the pool, so the next test starts from the same session
state as a new connection (no settings, temporary tables, prepared statements, advisory
locks or LISTEN channels carry over). A test that must be the database's only consumer
calls ``dispose_pooled_engines`` first.
"""

from __future__ import annotations

from sqlalchemy import Engine, create_engine, event

_ENGINES: dict[str, Engine] = {}


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
    engine = _ENGINES.get(database_url)
    if engine is None:
        engine = create_engine(database_url, pool_pre_ping=True)
        event.listen(engine, "checkin", _discard_session_state)
        _ENGINES[database_url] = engine
    return engine


def dispose_pooled_engines() -> None:
    """Close every idle pooled connection, for tests that need to be the sole consumer."""
    for engine in _ENGINES.values():
        engine.dispose()
