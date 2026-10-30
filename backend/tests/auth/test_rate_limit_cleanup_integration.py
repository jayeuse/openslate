"""Expired rate-limit cleanup must never deadlock with a request that holds its buckets."""

from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.models import IdentityRateLimitBucket
from app.systems.access.identity.rate_limits import (
    STALE_BUCKET_RETENTION,
    cleanup_expired_buckets,
    lock_bucket,
)
from tests.race_support import WAIT, backend_pid

pytestmark = pytest.mark.integration


def _blocked_by(holder_pid: int) -> bool:
    with get_engine().connect() as connection:
        return bool(
            connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted "
                    "AND :holder = ANY(pg_blocking_pids(pid)))"
                ),
                {"holder": holder_pid},
            )
        )


def test_bucket_cleanup_never_deadlocks_with_a_request_holding_two_buckets() -> None:
    # Live seven-pack run: a Comms restore confirmation failed with 503 after about 1 s.
    # Its password check runs the expired-bucket cleanup, which locked expired buckets in
    # window order, while sign-ins lock their account and source buckets in key order.
    # Opposite orders deadlock, and PostgreSQL ends one side after deadlock_timeout.
    now = datetime.now(UTC)
    first, second = sorted(f"{uuid4().hex}{uuid4().hex}" for _ in range(2))
    expired = now - STALE_BUCKET_RETENTION - timedelta(minutes=5)
    with AuditSession(get_engine()) as db:
        # The key-order second bucket is older, so window-order cleanup reaches it first.
        db.add(
            IdentityRateLimitBucket(
                fingerprint=first, attempt_count=1, window_started_at=expired + timedelta(minutes=1)
            )
        )
        db.add(
            IdentityRateLimitBucket(fingerprint=second, attempt_count=1, window_started_at=expired)
        )
        db.commit()
    holding, release = Event(), Event()
    holder: list[int] = []
    outcomes: dict[str, str | None] = {}

    def request() -> None:
        try:
            with AuditSession(get_engine()) as db:
                lock_bucket(db, first)
                holder.append(backend_pid(db))
                holding.set()
                assert release.wait(WAIT)
                lock_bucket(db, second)
                db.commit()
            outcomes["request"] = "done"
        except OperationalError as error:
            outcomes["request"] = getattr(error.orig, "sqlstate", None)

    def cleanup() -> None:
        try:
            cleanup_expired_buckets(now_value=now)
            outcomes["cleanup"] = "done"
        except OperationalError as error:
            outcomes["cleanup"] = getattr(error.orig, "sqlstate", None)

    requester = Thread(target=request)
    requester.start()
    assert holding.wait(WAIT)
    cleaner = Thread(target=cleanup)
    cleaner.start()
    # The cleanup either finishes or waits on the request's bucket; then the request
    # continues to its second bucket.
    for _ in range(int(WAIT * 100)):
        if not cleaner.is_alive() or _blocked_by(holder[0]):
            break
        Event().wait(0.01)
    release.set()
    requester.join(WAIT)
    cleaner.join(WAIT)
    assert outcomes == {"request": "done", "cleanup": "done"}
    with AuditSession(get_engine()) as db:
        for fingerprint in (first, second):
            bucket = db.get(IdentityRateLimitBucket, fingerprint)
            if bucket is not None:
                db.delete(bucket)
        db.commit()
