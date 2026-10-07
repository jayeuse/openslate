"""Independent committed runtime connections prove representative locking/visibility."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from time import monotonic
from uuid import uuid4

import pytest
from sqlalchemy import event, func, select

from app.core.database.session import AuditSession, get_engine
from app.systems.manage.audit.models import SecurityEvent

pytestmark = pytest.mark.integration


def test_runtime_is_read_committed():
    with AuditSession(bind=get_engine()) as db:
        assert db.connection().get_isolation_level() == "READ COMMITTED"


def test_two_runtime_writers_wait_through_commit_then_observe_one_representative(monkeypatch):
    from app.systems.manage.audit import security_failures

    engine = get_engine()
    address = f"2001:db8:{int(uuid4().hex[:4], 16):x}:{int(uuid4().hex[:4], 16):x}::1"
    timestamp = datetime(2033, 4, 5, 6, 15, tzinfo=UTC)
    inserted, second_lock, release = Event(), Event(), Event()
    pids = {}
    original = security_failures.append_security_event

    def hold_first(db, payload):
        row = original(db, payload)
        db.flush()
        inserted.set()
        assert release.wait(10)
        return row

    monkeypatch.setattr(security_failures, "append_security_event", hold_first)

    def query_attempt(connection, cursor, statement, parameters, context, executemany):
        if inserted.is_set() and "pg_advisory_xact_lock" in statement:
            second_lock.set()

    event.listen(engine, "before_cursor_execute", query_attempt)

    def write(name):
        with AuditSession(bind=engine) as db:
            assert db.connection().get_isolation_level() == "READ COMMITTED"
            pids[name] = db.scalar(select(func.pg_backend_pid()))
            security_failures.append_representative_failure(
                db, "identity.sign_in_failure", address, now=timestamp
            )
            db.commit()

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(write, "first")
            assert inserted.wait(10)
            second = pool.submit(write, "second")
            assert second_lock.wait(10)
            deadline = monotonic() + 10
            with engine.connect() as observation:
                while (
                    observation.exec_driver_sql(
                        "SELECT count(*) FROM pg_locks "
                        "WHERE pid=%s AND locktype='advisory' AND NOT granted",
                        (pids["second"],),
                    ).scalar_one()
                    == 0
                ):
                    assert not second.done() and monotonic() < deadline
            assert not second.done()
            release.set()
            first.result(10)
            second.result(10)
        with AuditSession(bind=engine) as db:
            rows = list(
                db.scalars(
                    select(SecurityEvent).where(
                        SecurityEvent.event_type == "identity.sign_in_failure",
                        SecurityEvent.occurred_at == timestamp,
                    )
                )
            )
            rows = [r for r in rows if r.event_metadata.get("ip_address") == address]
            assert len(rows) == 1
    finally:
        release.set()
        event.remove(engine, "before_cursor_execute", query_attempt)


def test_rollback_does_not_suppress_later_commit_and_bucket_facts_are_immutable():
    from app.systems.manage.audit.security_failures import append_representative_failure

    timestamp = datetime(2034, 5, 6, 7, 10, tzinfo=UTC)
    # Append-only rows persist within this owned runner; reserve an unused hour.
    with AuditSession(bind=get_engine()) as db:
        while (
            db.scalar(
                select(SecurityEvent.id)
                .where(
                    SecurityEvent.occurred_at >= timestamp.replace(minute=0),
                    SecurityEvent.occurred_at < timestamp.replace(minute=0) + timedelta(hours=2),
                )
                .limit(1)
            )
            is not None
        ):
            timestamp += timedelta(hours=2)
    address = f"2001:db8:{int(uuid4().hex[:4], 16):x}:{int(uuid4().hex[:4], 16):x}::1"
    with AuditSession(bind=get_engine()) as db:
        append_representative_failure(db, "identity.sign_in_failure", address, now=timestamp)
        db.flush()
        db.rollback()
    with AuditSession(bind=get_engine()) as db:
        append_representative_failure(db, "identity.sign_in_failure", address, now=timestamp)
        db.commit()
    with AuditSession(bind=get_engine()) as db:
        first = db.scalar(
            select(SecurityEvent).where(
                SecurityEvent.occurred_at == timestamp,
                SecurityEvent.event_metadata["ip_address"].astext == address,
            )
        )
        first_id, first_facts = first.id, dict(first.event_metadata)
        append_representative_failure(
            db, "identity.sign_in_failure", address, now=timestamp + timedelta(minutes=20)
        )
        append_representative_failure(
            db, "identity.sign_in_failure", address, now=timestamp + timedelta(hours=1)
        )
        append_representative_failure(db, "identity.ip_blocked", address, now=timestamp)
        append_representative_failure(db, "identity.sign_in_failure", None, now=timestamp)
        db.commit()
    with AuditSession(bind=get_engine()) as db:
        first = db.get(SecurityEvent, first_id)
        assert first.event_metadata == first_facts and first.occurred_at == timestamp
        rows = list(
            db.scalars(
                select(SecurityEvent).where(
                    SecurityEvent.occurred_at >= timestamp,
                    SecurityEvent.occurred_at < timestamp + timedelta(hours=2),
                )
            )
        )
        matching = [r for r in rows if r.event_metadata.get("ip_address") in [address, None]]
        assert len(matching) == 4
        assert (
            next(r for r in matching if r.event_metadata.get("ip_address") is None).actor_id is None
        )
