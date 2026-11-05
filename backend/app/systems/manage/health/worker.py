"""The installation's minute sampler and hourly retention (S5-C1, S5-C2).

Every API process runs one sampler thread, but the installation keeps one sample a minute:
a process probes outside any transaction, then writes only while it holds a transaction
advisory lock, re-checking that the minute is still missing. The primary key on the minute
is the second guard. While the database is down, a process keeps its samples (data not
working) in memory and writes them at its next lock win, skipping minutes already stored.
"""

from __future__ import annotations

import random
import threading
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from time import monotonic

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.base_model import utc_now
from app.core.config import Settings
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.core.readiness import ReadinessSnapshot, get_timed_readiness_snapshot
from app.systems.manage.health.history import email_signals, email_word
from app.systems.manage.health.models import SystemHealthSample
from app.systems.manage.health.service import sample_statuses

SAMPLER_LOCK = "slateops:system-health-sampler"
BUFFER_MINUTES = 1440
RETENTION_SECONDS = 3600.0
WAKE_JITTER_SECONDS = 10.0
_STOP_SECONDS = 5.0

Probe = Callable[[], tuple[ReadinessSnapshot, dict[str, int]]]


@dataclass(frozen=True, slots=True)
class _Pending:
    """One probed minute before it is written; Email is decided by the writer."""

    sampled_at: datetime
    data_status: str
    data_ms: int | None
    signing_in_status: str
    signing_in_ms: int | None
    files_status: str
    files_ms: int | None
    smtp: str | None
    # A minute kept while the database was down keeps the Email word it could decide then.
    email_status: str | None = None


def _minute(moment: datetime) -> datetime:
    return moment.replace(second=0, microsecond=0)


def _pending(minute: datetime, snapshot: ReadinessSnapshot, times: dict[str, int]) -> _Pending:
    statuses = sample_statuses(snapshot)
    smtp = snapshot["components"].get("smtp")
    return _Pending(
        sampled_at=minute,
        data_status=statuses["data"],
        data_ms=times.get("database"),
        signing_in_status=statuses["signing_in"],
        signing_in_ms=times.get("auth"),
        files_status=statuses["files"],
        files_ms=times.get("storage"),
        smtp=smtp["status"] if smtp is not None else None,
    )


class SystemHealthWorker:
    def __init__(
        self,
        settings: Settings,
        *,
        clock: Callable[[], datetime] = utc_now,
        probe: Probe | None = None,
    ) -> None:
        self._enabled = settings.environment != "test" or settings.e2e_background_workers
        self._clock = clock
        self._probe = probe
        self._buffer: deque[_Pending] = deque(maxlen=BUFFER_MINUTES)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def buffered(self) -> int:
        return len(self._buffer)

    def start(self) -> None:
        if not self._enabled or self._thread is not None:
            return
        self._stop.clear()
        thread = threading.Thread(target=self._run, name="slateops-health-sampler", daemon=True)
        thread.start()
        self._thread = thread

    def stop(self) -> bool:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=_STOP_SECONDS)
            if thread.is_alive():
                log_event(
                    "operational_attention",
                    reason_code="health_sampler_shutdown_timeout",
                    upstream="database",
                )
                return False
        self._thread = None
        return True

    def sample_once(self, *, now: datetime | None = None, probe: Probe | None = None) -> bool:
        """Probe and store this minute; ``True`` when this process wrote it."""

        minute = _minute(now or self._clock())
        try:
            if self._stored(minute):
                return False
        except SQLAlchemyError:
            pass  # The write below finds out whether the database is back.
        snapshot, times = (probe or self._probe or get_timed_readiness_snapshot)()
        pending = _pending(minute, snapshot, times)
        try:
            return self._write(pending)
        except SQLAlchemyError:
            # The database refused the sample, so to everyone it did not work this minute.
            self._buffer.append(
                replace(
                    pending,
                    data_status="not_working",
                    email_status=email_word(pending.smtp, None, None, minute),
                )
            )
            return False

    def retain_once(self) -> int:
        """Delete samples and server errors past their retention; the function try-locks."""

        with AuditSession(bind=get_engine()) as db:
            deleted = int(db.scalar(select(func.public.retain_system_health())) or 0)
            db.commit()
            return deleted

    @staticmethod
    def _stored(minute: datetime) -> bool:
        with AuditSession(bind=get_engine()) as db:
            found = db.scalar(
                select(SystemHealthSample.sampled_at).where(SystemHealthSample.sampled_at == minute)
            )
            db.rollback()
            return found is not None

    def _write(self, pending: _Pending) -> bool:
        with AuditSession(bind=get_engine()) as db:
            locked = db.scalar(
                select(func.pg_try_advisory_xact_lock(func.hashtextextended(SAMPLER_LOCK, 0)))
            )
            if not locked:
                db.rollback()
                return False
            rows = [*self._buffer, pending]
            stored = set(
                db.scalars(
                    select(SystemHealthSample.sampled_at).where(
                        SystemHealthSample.sampled_at.in_([row.sampled_at for row in rows])
                    )
                )
            )
            if pending.sampled_at in stored and not self._buffer:
                db.rollback()
                return False
            accepted_at, failed_at = email_signals(db)
            database_bytes = int(
                db.scalar(select(func.pg_database_size(func.current_database()))) or 0
            )
            written: set[datetime] = set()
            for row in rows:
                if row.sampled_at in stored or row.sampled_at in written:
                    continue
                current = row is pending
                db.add(
                    SystemHealthSample(
                        sampled_at=row.sampled_at,
                        data_status=row.data_status,
                        data_ms=row.data_ms,
                        signing_in_status=row.signing_in_status,
                        signing_in_ms=row.signing_in_ms,
                        files_status=row.files_status,
                        files_ms=row.files_ms,
                        email_status=row.email_status
                        or email_word(row.smtp, accepted_at, failed_at, row.sampled_at),
                        database_bytes=database_bytes if current else None,
                    )
                )
                written.add(row.sampled_at)
            db.commit()
        self._buffer.clear()
        return pending.sampled_at in written

    def _run(self) -> None:
        retention_due = monotonic()
        while not self._stop.is_set():
            current = self._clock()
            following = _minute(current) + timedelta(minutes=1)
            wait = (following - current).total_seconds() + random.uniform(
                0, WAKE_JITTER_SECONDS
            )
            if self._stop.wait(wait):
                break
            try:
                self.sample_once()
            except Exception:
                log_event(
                    "operational_attention", reason_code="health_sample_failed", upstream="database"
                )
            if monotonic() >= retention_due:
                retention_due = monotonic() + RETENTION_SECONDS
                try:
                    self.retain_once()
                except Exception:
                    log_event(
                        "operational_attention",
                        reason_code="health_retention_failed",
                        upstream="database",
                    )
