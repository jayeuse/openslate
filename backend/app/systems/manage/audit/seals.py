"""Hourly hash chains over the audit rows (plan step 2.5, decision D8).

Each organization has one chain, and the installation (`org_id` NULL) has one. A seal holds
one UTC hour of one chain: the row count, a hash of the rows, and a chain hash that also
covers the previous seal. Changing, removing or adding a row of a sealed hour changes its
row hash, and changing a seal breaks the chain after it.

The row form is SQL in this source, never a database function, so an owner who can change a
function cannot change the form. The worker and `operations/verify_audit_seals.py` use the
same constants. The runtime reads and writes seals bound to one organization at a time.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Connection, Engine, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database.organization_scope import apply_connection_scope, worker_organization
from app.core.database.session import AuditSession
from app.core.observability import failure_cause, log_event
from app.systems.manage.audit.models import AuditSeal

SEAL_FORM = 1
# Rows get `created_at` from the API clock at flush, and a transaction commits later. The
# worker seals an hour only this long after it ends, on its own clock (K30). The populate
# run's longest transaction sets the final value (contract question 5).
SEAL_DELAY = timedelta(hours=2)
SPAN_HOURS = 24
WAKE_HOURS = 168
HOUR = timedelta(hours=1)
EMPTY_HASH = hashlib.sha256(b"").digest()
FIRST_PREVIOUS = bytes(32)
_DOMAIN = b"slateops-audit-seal-v1"
# The two-key advisory lock space is separate from the one-key locks of other jobs.
_LOCK_CLASS = 20_251_107
_UNIQUE_VIOLATION = "23505"

# Version 1 of the row form. A one-element array keeps a JSON `null` apart from SQL NULL;
# the timestamp is UTC text, so the session time zone cannot change it. Every function and
# type names `pg_catalog`, so an object in `public` cannot take its place on any search path;
# the transactions also read with `_CATALOG_PATH` for the operators.
CANONICAL_ROW = (
    "pg_catalog.jsonb_build_array(id, org_id, "
    "pg_catalog.to_char(pg_catalog.timezone('UTC'::pg_catalog.text, created_at), "
    "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'::pg_catalog.text), "
    "performed_by, action, entity_type, entity_id, department_id, "
    "CASE WHEN before IS NULL THEN NULL ELSE pg_catalog.jsonb_build_array(before) END, "
    "CASE WHEN after IS NULL THEN NULL ELSE pg_catalog.jsonb_build_array(after) END, "
    "request_id, request_method, request_path, actor_label, note)::pg_catalog.text"
)
_HOURS = (
    "SELECT pg_catalog.timezone('UTC'::pg_catalog.text, pg_catalog.date_trunc("
    "'hour'::pg_catalog.text, pg_catalog.timezone('UTC'::pg_catalog.text, created_at))) "
    "AS hour, pg_catalog.count(*) AS row_count, "
    "pg_catalog.count(*) - pg_catalog.count(DISTINCT id) AS duplicates, "
    "pg_catalog.sha256(pg_catalog.string_agg(pg_catalog.sha256(pg_catalog.convert_to("
    f"{CANONICAL_ROW}, 'UTF8'::pg_catalog.name)), ''::pg_catalog.bytea "
    "ORDER BY created_at, id)) AS rows_hash "
    "FROM public.audit_logs WHERE {chain} AND created_at >= :start AND created_at < :end "
    "GROUP BY 1"
)
CATALOG_PATH = text("SET LOCAL search_path = pg_catalog, pg_temp")


class SealChainError(RuntimeError):
    """The latest seal of a chain is not on a whole hour, or not yet past the horizon."""


def _chain(org_id: UUID | None) -> str:
    # Two statements, so each uses the `(org_id, created_at, id)` index.
    return "org_id = CAST(:org AS pg_catalog.uuid)" if org_id else "org_id IS NULL"


@dataclass(frozen=True, slots=True)
class HourHash:
    row_count: int
    rows_hash: bytes
    duplicates: int = 0


def hour_floor(moment: datetime) -> datetime:
    return moment.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def whole_hour(moment: datetime) -> bool:
    return moment == hour_floor(moment)


def horizon(now: datetime) -> datetime:
    """The first hour that is not sealable yet: hour H is sealed once now >= H + 1 h + delay."""

    return hour_floor(now - SEAL_DELAY)


def hours(start: datetime, end: datetime) -> Iterator[datetime]:
    while start < end:
        yield start
        start += HOUR


def read_hours(
    connection: Connection, org_id: UUID | None, start: datetime, end: datetime
) -> dict[datetime, HourHash]:
    """The row count and hash of each hour in [start, end) that holds rows of the chain."""

    statement = text(_HOURS.format(chain=_chain(org_id)))
    rows = connection.execute(statement, {"org": org_id, "start": start, "end": end})
    return {
        row.hour.astimezone(UTC): HourHash(row.row_count, bytes(row.rows_hash), row.duplicates)
        for row in rows
    }


def chain_hash(
    previous: bytes, org_id: UUID | None, hour_start: datetime, row_count: int, rows_hash: bytes
) -> bytes:
    """Fixed-width fields, so that no field can run into the next.

    The hour field holds whole seconds, so an hour that is not whole would share its hash.
    """

    if not whole_hour(hour_start):
        raise ValueError("A seal hour must be a whole UTC hour")
    return hashlib.sha256(
        _DOMAIN
        + previous
        + (org_id.bytes if org_id else bytes(16))
        + int(hour_start.timestamp()).to_bytes(8, "big", signed=True)
        + row_count.to_bytes(8, "big")
        + rows_hash
    ).digest()


def chain_start(connection: Connection, org_id: UUID | None) -> datetime | None:
    """The first hour of a chain; it depends only on stored rows, so a re-seal is the same."""

    first_row = connection.scalar(
        text(f"SELECT pg_catalog.min(created_at) FROM public.audit_logs WHERE {_chain(org_id)}"),
        {"org": org_id},
    )
    if org_id is not None:
        created = connection.scalar(
            text("SELECT created_at FROM public.organizations WHERE id = :org"), {"org": org_id}
        )
        first = min(value for value in (first_row, created) if value is not None)
    else:
        first = first_row or connection.scalar(
            text("SELECT pg_catalog.min(created_at) FROM public.organizations")
        )
    return hour_floor(first) if first is not None else None


def latest_seal(db: Session, org_id: UUID | None) -> AuditSeal | None:
    chain = AuditSeal.org_id == org_id if org_id else AuditSeal.org_id.is_(None)
    return db.scalar(
        select(AuditSeal).where(chain).order_by(AuditSeal.hour_start.desc()).limit(1)
    )


@dataclass(frozen=True, slots=True)
class SpanResult:
    sealed: int
    more: bool
    skipped: bool = False


def seal_span(db: AuditSession, org_id: UUID | None, now: datetime) -> SpanResult:
    """Seal up to `SPAN_HOURS` hours of one chain in the caller's bound transaction.

    The caller commits. Another process that holds the chain's lock is sealing it already.
    The transaction resolves names in `pg_catalog` only, and ORM tables in `public`.
    """

    connection = db.connection(execution_options={"schema_translate_map": {None: "public"}})
    connection.execute(CATALOG_PATH)
    locked = db.scalar(
        select(func.pg_try_advisory_xact_lock(_LOCK_CLASS, func.hashtext(str(org_id or ""))))
    )
    if not locked:
        return SpanResult(0, False, skipped=True)
    last = latest_seal(db, org_id)
    end = horizon(now)
    if last is not None:
        last_hour = last.hour_start.astimezone(UTC)
        # Never continue from a seal that no worker could have written (F1).
        if not whole_hour(last_hour) or last_hour + HOUR > end:
            raise SealChainError("The latest seal is off the hour or past the horizon")
    start = last_hour + HOUR if last is not None else chain_start(connection, org_id)
    if start is None or start >= end:
        return SpanResult(0, False)
    span_end = min(end, start + SPAN_HOURS * HOUR)
    found = read_hours(connection, org_id, start, span_end)
    previous = last.chain_hash if last else FIRST_PREVIOUS
    for hour in hours(start, span_end):
        sealed = found.get(hour, HourHash(0, EMPTY_HASH))
        if sealed.duplicates:
            log_event(
                "operational_attention", reason_code="audit_duplicate_id", upstream="audit-seals",
                org_id=org_id, count=sealed.duplicates,
            )
        previous = chain_hash(previous, org_id, hour, sealed.row_count, sealed.rows_hash)
        db.add(
            AuditSeal(
                org_id=org_id, hour_start=hour, row_count=sealed.row_count,
                rows_hash=sealed.rows_hash, chain_hash=previous, form=SEAL_FORM,
            )
        )
    db.flush()
    return SpanResult((span_end - start) // HOUR, span_end < end)


def chains(engine: Engine) -> list[UUID | None]:
    """Every organization, soft-deleted ones too (K26), then the installation."""

    with engine.connect() as connection:
        organizations = list(
            connection.scalars(text("SELECT id FROM public.organizations ORDER BY id"))
        )
    return [*organizations, None]


def seal_chain(engine: Engine, org_id: UUID | None, now: datetime) -> bool:
    """Seal up to `WAKE_HOURS` hours, one transaction a span. True when hours remain."""

    for _span in range(WAKE_HOURS // SPAN_HOURS):
        try:
            if org_id is None:
                result = _commit_span(engine, None, now)
            else:
                with worker_organization(org_id):
                    result = _commit_span(engine, org_id, now)
        except IntegrityError as error:
            if getattr(error.orig, "sqlstate", None) != _UNIQUE_VIOLATION:
                raise
            continue  # Another process sealed the same hour first; read its seals again.
        if not result.more:
            return False
    return True


def _commit_span(engine: Engine, org_id: UUID | None, now: datetime) -> SpanResult:
    with AuditSession(bind=engine) as db:
        try:
            result = seal_span(db, org_id, now)
            db.commit()
            return result
        except BaseException:
            db.rollback()
            raise


@dataclass(frozen=True, slots=True)
class SealPass:
    backlog: bool
    failed: UUID | None = None
    cause: str | None = None
    failures: int = 0


def seal_audit(engine: Engine, *, now: datetime) -> SealPass:
    """Seal every chain up to the horizon; one chain's failure does not stop the others."""

    backlog = False
    failures: list[tuple[UUID | None, str]] = []
    for org_id in chains(engine):
        try:
            backlog = seal_chain(engine, org_id, now) or backlog
        except Exception as error:
            failures.append((org_id, failure_cause(error)))
    if not failures:
        return SealPass(backlog)
    return SealPass(backlog, failures[0][0], failures[0][1], len(failures))


def read_seal_heads(connection: Connection) -> list[dict[str, Any]]:
    """The latest seal of each chain, read as the runtime with each organization bound."""

    organizations = list(
        connection.scalars(text("SELECT id FROM public.organizations ORDER BY id"))
    )
    heads = []
    for org_id in (*organizations, None):
        apply_connection_scope(connection, org_id)
        head = connection.execute(
            text(
                "SELECT hour_start, chain_hash, row_count FROM public.audit_seals "
                f"WHERE {_chain(org_id)} ORDER BY hour_start DESC LIMIT 1"
            ),
            {"org": org_id},
        ).one_or_none()
        if head is not None:
            heads.append(
                {
                    "org_id": str(org_id) if org_id else None,
                    "hour_start": head.hour_start.astimezone(UTC).isoformat(),
                    "chain_hash": bytes(head.chain_hash).hex(),
                    "row_count": head.row_count,
                }
            )
    apply_connection_scope(connection, None)
    return heads
