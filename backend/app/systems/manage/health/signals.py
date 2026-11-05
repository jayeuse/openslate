"""Worker heartbeats and email send outcomes (S5-C5, S5-C6).

Each signal is one installation-wide row that only moves forward in time. Writing one never
raises and never touches the caller's transaction, so a failed write cannot change a request
or stop a worker. Nothing here is audited or a security event (S5-C8).
"""

from datetime import datetime
from threading import Lock
from time import monotonic

from sqlalchemy import select

from app.core.base_model import utc_now
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.systems.manage.health.models import SystemHealthSignal

BEAT_SECONDS = 60.0

_beats_lock = Lock()
_last_beats: dict[str, float] = {}


def _write_signal(key: str, now: datetime) -> None:
    with AuditSession(bind=get_engine()) as db:
        row = db.scalar(
            select(SystemHealthSignal).where(SystemHealthSignal.key == key).with_for_update()
        )
        if row is None:
            raise LookupError(key)
        if row.last_seen_at is None or row.last_seen_at < now:
            row.last_seen_at = now
        db.commit()


def record_signal(key: str, *, now: datetime | None = None) -> None:
    """Move ``key`` to now in its own transaction; log a failure, never raise it."""

    try:
        _write_signal(key, now or utc_now())
    except Exception:
        log_event(
            "operational_attention", reason_code="health_signal_write_failed", upstream="database"
        )


def beat(key: str) -> None:
    """A worker ran: record it at most once a minute per process and key."""

    current = monotonic()
    with _beats_lock:
        last = _last_beats.get(key)
        if last is not None and current - last < BEAT_SECONDS:
            return
        _last_beats[key] = current
    record_signal(key)
