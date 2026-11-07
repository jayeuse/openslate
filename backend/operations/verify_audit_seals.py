"""Read-only check that the audit rows still match their hourly seals (DBI-10, step 2.5).

Run from backend/: uv run python operations/verify_audit_seals.py [--heads FILE]...
                    uv run python operations/verify_audit_seals.py --write-heads FILE
Exit 0: every sealed hour matches; 1: findings to review; 2: the check could not run.

It reads each chain (every organization, then the installation) in its own read-only
snapshot as the runtime, bound to that organization. A seal hashes a whole hour, so a
finding names the organization, the hour and the kind, never the row. Without a heads file
it proves that rows and seals agree inside the database; an owner can rewrite both. Each
`--heads` file (a backup's `audit/seal-heads.json`, or one this command wrote) also proves
that nothing changed before its heads. Changes after the latest exported head are not
detected. `--write-heads` writes the current heads instead of checking.
"""

import argparse
import json
import logging
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import Connection, Engine, text

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.base_model import utc_now
from app.core.database.organization_scope import apply_connection_scope
from app.core.database.session import get_engine
from app.core.observability import configure_observability_logging, log_event
from app.systems.manage.audit.seals import (
    CATALOG_PATH,
    FIRST_PREVIOUS,
    HOUR,
    SPAN_HOURS,
    chain_hash,
    chain_start,
    horizon,
    hour_floor,
    hours,
    read_hours,
    read_seal_heads,
    whole_hour,
)

_REPORTED = 100
_ORGANIZATIONS = text("SELECT id FROM public.organizations ORDER BY id")
_SEALS = text(
    "SELECT hour_start, row_count, rows_hash, chain_hash FROM public.audit_seals "
    "WHERE {chain} ORDER BY hour_start"
)
_BEFORE = text(
    "SELECT pg_catalog.count(*), pg_catalog.min(created_at) FROM public.audit_logs "
    "WHERE {chain} AND created_at < :first"
)
_DUPLICATES = text(
    "SELECT pg_catalog.count(*) FROM (SELECT id FROM public.audit_logs WHERE {chain} "
    "GROUP BY id HAVING pg_catalog.count(*) > 1) AS duplicate"
)
# A missing seal is a finding two hours past the worker's horizon: its hourly wake can come
# up to an hour after the horizon passes an hour.
_SLACK = 2 * HOUR


@dataclass
class Report:
    findings: list[dict[str, Any]] = field(default_factory=list)
    chains: int = 0
    sealed_hours: int = 0
    rows: int = 0
    capped: bool = False

    def add(
        self,
        org_id: UUID | None,
        hour: datetime | None,
        kind: str,
        sealed: int | None = None,
        current: int | None = None,
    ) -> None:
        self.findings.append(
            {
                "org_id": str(org_id) if org_id else None,
                "hour": hour.astimezone(UTC).isoformat() if hour else None,
                "kind": kind,
                "sealed_count": sealed,
                "current_count": current,
            }
        )

    def add_hours(self, org_id: UUID | None, start: datetime, end: datetime, kind: str) -> None:
        """One finding for each hour, at most `_REPORTED`, so a bad seal cannot loop for long."""

        for count, hour in enumerate(hours(start, end)):
            if count == _REPORTED:
                self.capped = True
                return
            self.add(org_id, hour, kind)


def _statement(template: Any, org_id: UUID | None) -> Any:
    chain = "org_id = CAST(:org AS pg_catalog.uuid)" if org_id else "org_id IS NULL"
    return text(template.text.format(chain=chain))


def _follows(seal: Any, previous: Any, org_id: UUID | None) -> bool:
    expected = chain_hash(
        bytes(previous.chain_hash) if previous is not None else FIRST_PREVIOUS,
        org_id, seal.hour, seal.row_count, bytes(seal.rows_hash),
    )
    return bytes(seal.chain_hash) == expected


@dataclass(frozen=True)
class _Seal:
    hour: datetime
    row_count: int
    rows_hash: bytes
    chain_hash: bytes


def _valid_seals(
    seals: Sequence[Any], org_id: UUID | None, now: datetime, report: Report
) -> list[_Seal]:
    """Check each seal on its own, then the chain; return the seals that rows can be held to."""

    valid: list[_Seal] = []
    previous: _Seal | None = None
    broken = False
    for row in seals:
        seal = _Seal(
            row.hour_start.astimezone(UTC), row.row_count, bytes(row.rows_hash),
            bytes(row.chain_hash),
        )
        if not whole_hour(seal.hour):
            report.add(org_id, seal.hour, "seal_misaligned", seal.row_count)
            broken = True
            continue
        if seal.hour + HOUR > now:
            report.add(org_id, seal.hour, "seal_in_future", seal.row_count)
            broken = True
            continue
        if previous is not None and seal.hour > previous.hour + HOUR:
            report.add_hours(org_id, previous.hour + HOUR, seal.hour, "seal_missing")
        elif not broken and not _follows(seal, previous, org_id):
            report.add(org_id, seal.hour, "seal_changed", seal.row_count)
        valid.append(seal)
        previous, broken = seal, False
    return valid


def check_chain(
    connection: Connection, org_id: UUID | None, now: datetime, report: Report
) -> dict[datetime, bytes]:
    """Check one chain in the caller's bound snapshot; return its chain hash for each hour."""

    params = {"org": org_id}
    rows = connection.execute(_statement(_SEALS, org_id), params).all()
    report.chains += 1
    report.sealed_hours += len(rows)
    valid = _valid_seals(rows, org_id, now, report)
    if valid:
        before, oldest = connection.execute(
            _statement(_BEFORE, org_id), {**params, "first": valid[0].hour}
        ).one()
        if before:
            report.add(org_id, hour_floor(oldest), "rows_before_chain", None, before)
        position = 0
        while position < len(valid):
            # One read for each day that holds seals; each seal is held to its own hour.
            end = valid[position].hour + SPAN_HOURS * HOUR
            current = read_hours(connection, org_id, valid[position].hour, end)
            while position < len(valid) and valid[position].hour < end:
                seal = valid[position]
                found = current.get(seal.hour)
                count = found.row_count if found else 0
                report.rows += count
                if count > seal.row_count:
                    report.add(org_id, seal.hour, "added", seal.row_count, count)
                elif count < seal.row_count:
                    report.add(org_id, seal.hour, "removed", seal.row_count, count)
                elif found is not None and found.rows_hash != seal.rows_hash:
                    report.add(org_id, seal.hour, "changed", seal.row_count, count)
                position += 1
        unsealed_from: datetime | None = valid[-1].hour + HOUR
    else:
        unsealed_from = chain_start(connection, org_id)
    if unsealed_from is not None:
        report.add_hours(org_id, unsealed_from, horizon(now) - _SLACK, "unsealed")
    duplicates = connection.scalar(_statement(_DUPLICATES, org_id), params)
    if duplicates:
        report.add(org_id, None, "duplicate_id", None, duplicates)
    return {seal.hour: seal.chain_hash for seal in valid}


def verify(engine: Engine, *, now: datetime, heads: Sequence[dict[str, Any]] = ()) -> Report:
    report = Report()
    with engine.connect() as connection:
        organizations: list[UUID | None] = list(connection.scalars(_ORGANIZATIONS))
        connection.rollback()
    chains: dict[UUID | None, dict[datetime, bytes]] = {}
    for org_id in (*organizations, None):
        # One snapshot for a chain's seals and rows; none stays open across chains.
        with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
            connection.execute(text("SET TRANSACTION READ ONLY"))
            connection.execute(text("SET LOCAL statement_timeout = '120s'"))
            connection.execute(CATALOG_PATH)
            apply_connection_scope(connection, org_id)
            chains[org_id] = check_chain(connection, org_id, now, report)
            connection.rollback()
    for head in heads:
        org_id = UUID(head["org_id"]) if head["org_id"] else None
        hour = datetime.fromisoformat(head["hour_start"])
        if org_id not in chains:
            report.add(org_id, hour, "chain_absent")
        elif chains[org_id].get(hour) != bytes.fromhex(head["chain_hash"]):
            report.add(org_id, hour, "head_mismatch")
    return report


def _read_heads(path: str) -> list[dict[str, Any]]:
    heads = json.loads(Path(path).read_text())["heads"]
    if not isinstance(heads, list):
        raise ValueError("heads must be a list")
    return heads


def _write_heads(engine: Engine, path: str) -> None:
    with engine.connect() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        heads = read_seal_heads(connection)
        connection.rollback()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump({"heads": heads}, output, separators=(",", ":"))


def main(arguments: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--heads", action="append", default=[], metavar="FILE")
    parser.add_argument("--write-heads", metavar="FILE")
    options = parser.parse_args(arguments)
    configure_observability_logging()
    try:
        if options.write_heads:
            _write_heads(get_engine(), options.write_heads)
            print(json.dumps({"status": "ok", "heads": options.write_heads}))
            return 0
        heads = [head for path in options.heads for head in _read_heads(path)]
        report = verify(get_engine(), now=utc_now(), heads=heads)
    except Exception:
        log_event(
            "operational_check_failed", level=logging.ERROR, reason_code="audit_seal_check_failed"
        )
        print(json.dumps({"status": "unavailable"}))
        return 2
    print(
        json.dumps(
            {
                "status": "attention" if report.findings else "ok",
                "findings": report.findings[:_REPORTED],
                "truncated": report.capped or len(report.findings) > _REPORTED,
                "chains": report.chains,
                "sealed_hours": report.sealed_hours,
                "rows": report.rows,
            },
            separators=(",", ":"),
        )
    )
    if report.findings:
        log_event("operational_attention", level=logging.WARNING, reason_code="audit_seals_differ")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
