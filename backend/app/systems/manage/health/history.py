"""Periods, Slow and the Email word from the stored samples and signals (S5-C3 to S5-C5).

The history holds installation-wide values only, never organization data (R4), so one cached
copy per process answers every person. It is read at most once a minute per process.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock
from time import monotonic

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.manage.health.models import SystemHealthSample, SystemHealthSignal
from app.systems.manage.health.schemas import PartKey, PartStatus, PeriodKind

PARTS: tuple[PartKey, ...] = ("data", "signing_in", "files", "email")
TIMED: tuple[PartKey, ...] = ("data", "signing_in", "files")
WINDOW = timedelta(days=30)
SLOW_MS = 1000
SLOW_SAMPLES = 3
# A missing minute inside a run does not split it; a longer gap does.
RUN_GAP = timedelta(minutes=2)
# A run that reaches a newest sample this fresh is still going.
ONGOING_WITHIN = timedelta(minutes=3)
SLOW_WITHIN = timedelta(minutes=4)
EMAIL_RECENT = timedelta(hours=24)
CACHE_SECONDS = 60.0
_KINDS: tuple[PeriodKind, ...] = ("not_working", "slow")


@dataclass(frozen=True, slots=True)
class Sample:
    sampled_at: datetime
    statuses: dict[PartKey, str]
    times: dict[PartKey, int | None]


@dataclass(frozen=True, slots=True)
class Period:
    part: PartKey
    kind: PeriodKind
    started_at: datetime
    ended_at: datetime | None


@dataclass(frozen=True, slots=True)
class HealthHistory:
    """Installation-wide history; it holds nothing of any organization (R4)."""

    periods: tuple[Period, ...]
    slow: frozenset[PartKey]
    oldest_sample_at: datetime | None
    email_accepted_at: datetime | None
    email_failed_at: datetime | None


def _is_slow(sample: Sample, part: PartKey) -> bool:
    if part not in TIMED or sample.statuses[part] != "working":
        return False
    took = sample.times.get(part)
    return took is not None and took > SLOW_MS


def _is_bad(sample: Sample, part: PartKey, kind: PeriodKind) -> bool:
    if kind == "not_working":
        return sample.statuses[part] == "not_working"
    return _is_slow(sample, part)


def _runs(samples: Sequence[Sample], part: PartKey, kind: PeriodKind) -> list[list[Sample]]:
    runs: list[list[Sample]] = []
    current: list[Sample] = []
    for sample in samples:
        if not _is_bad(sample, part, kind):
            if current:
                runs.append(current)
            current = []
            continue
        if current and sample.sampled_at - current[-1].sampled_at > RUN_GAP:
            runs.append(current)
            current = []
        current.append(sample)
    if current:
        runs.append(current)
    if kind == "slow":
        runs = [run for run in runs if len(run) >= SLOW_SAMPLES]
    return runs


def health_periods(samples: Sequence[Sample], now: datetime) -> list[Period]:
    """Each run when a part did not work or was slow: still going first, then newest ended."""

    if not samples:
        return []
    newest = samples[-1].sampled_at
    fresh = now - newest <= ONGOING_WITHIN
    periods: list[Period] = []
    for part in PARTS:
        for kind in _KINDS:
            for run in _runs(samples, part, kind):
                last = run[-1].sampled_at
                going = fresh and last == newest
                periods.append(
                    Period(part, kind, run[0].sampled_at,
                           None if going else last + timedelta(minutes=1))
                )

    def order(period: Period) -> tuple[int, float, int, int]:
        moment = period.started_at if period.ended_at is None else period.ended_at
        return (
            0 if period.ended_at is None else 1,
            -moment.timestamp(),
            PARTS.index(period.part),
            _KINDS.index(period.kind),
        )

    return sorted(periods, key=order)


def slow_parts(samples: Sequence[Sample], now: datetime) -> frozenset[PartKey]:
    """Timed parts whose newest three samples, all of the last 4 minutes, took over 1 second."""

    newest = samples[-SLOW_SAMPLES:]
    if len(newest) < SLOW_SAMPLES or newest[0].sampled_at < now - SLOW_WITHIN:
        return frozenset()
    return frozenset(
        part for part in TIMED if all(_is_slow(sample, part) for sample in newest)
    )


def email_word(
    smtp: str | None,
    accepted_at: datetime | None,
    failed_at: datetime | None,
    now: datetime,
) -> PartStatus:
    """Email follows real send outcomes; Working means Auth accepted a send recently."""

    if smtp == "not_configured":
        return "not_set_up"
    if smtp != "ready":
        return "not_working"
    recent = now - EMAIL_RECENT
    if failed_at is not None and failed_at >= recent and (
        accepted_at is None or failed_at > accepted_at
    ):
        return "not_working"
    if accepted_at is not None and accepted_at >= recent:
        return "working"
    return "set_up"


def email_signals(db: Session) -> tuple[datetime | None, datetime | None]:
    """The last accepted and the last failed email send."""

    rows = dict(
        db.execute(
            select(SystemHealthSignal.key, SystemHealthSignal.last_seen_at).where(
                SystemHealthSignal.key.in_(("email_accepted", "email_failed"))
            )
        )
        .tuples()
        .all()
    )
    return rows.get("email_accepted"), rows.get("email_failed")


def read_samples(db: Session, since: datetime) -> list[Sample]:
    """Up to 43,200 rows, so it reads the values only, never mapped sample objects."""

    rows = db.execute(
        select(
            SystemHealthSample.sampled_at,
            SystemHealthSample.data_status,
            SystemHealthSample.data_ms,
            SystemHealthSample.signing_in_status,
            SystemHealthSample.signing_in_ms,
            SystemHealthSample.files_status,
            SystemHealthSample.files_ms,
            SystemHealthSample.email_status,
        )
        .where(SystemHealthSample.sampled_at >= since)
        .order_by(SystemHealthSample.sampled_at)
    ).tuples()
    return [
        Sample(
            sampled_at=sampled_at,
            statuses={
                "data": data_status,
                "signing_in": signing_in_status,
                "files": files_status,
                "email": email_status,
            },
            times={"data": data_ms, "signing_in": signing_in_ms, "files": files_ms},
        )
        for (
            sampled_at, data_status, data_ms, signing_in_status, signing_in_ms,
            files_status, files_ms, email_status,
        ) in rows
    ]


def read_history(db: Session, now: datetime) -> HealthHistory:
    return history_from(db, read_samples(db, now - WINDOW), now)


def history_from(db: Session, samples: Sequence[Sample], now: datetime) -> HealthHistory:
    """The history of samples already read, with the email outcomes read now."""

    accepted_at, failed_at = email_signals(db)
    return HealthHistory(
        periods=tuple(health_periods(samples, now)),
        slow=slow_parts(samples, now),
        oldest_sample_at=samples[0].sampled_at if samples else None,
        email_accepted_at=accepted_at,
        email_failed_at=failed_at,
    )


_cache_lock = Lock()
# (history, monotonic time it was read)
_cached: tuple[HealthHistory, float] | None = None


def cached_history(db: Session) -> HealthHistory:
    """The history read at most once a minute per process; there is no bypass."""

    global _cached
    with _cache_lock:
        cached = _cached
        if cached is not None and monotonic() - cached[1] < CACHE_SECONDS:
            return cached[0]
    history = read_history(db, utc_now())
    with _cache_lock:
        _cached = (history, monotonic())
    return history
