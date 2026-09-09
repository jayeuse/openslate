"""Read-only administrative operation diagnostics; never reconciles or writes data.

Run from backend/: uv run python scripts/check_operational_health.py
Exit 0: no issue found; 1: operator attention; 2: visibility unavailable.
"""

import json
import logging
import sys
from pathlib import Path
from typing import TypedDict

from sqlalchemy import text
from sqlalchemy.engine import Connection

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database.session import get_engine
from app.core.observability import configure_observability_logging, log_event

# Match the actual producer stage and source. A different stage's success cannot
# resolve an attempt, even when it happens to share the same operation ID.
ATTENTION_QUERY = text("""
SELECT e.id, e.operation_id, e.event_type, e.source,
       CASE WHEN e.occurred_at > CURRENT_TIMESTAMP + INTERVAL '5 minutes'
            THEN 'clock_skew'
            WHEN e.outcome = 'partial' THEN 'partial' ELSE 'unresolved' END AS reason
FROM public.security_events AS e
WHERE (e.event_type, e.source) IN (
    ('user.invitation', 'users.service'),
    ('user.invitation_resend', 'users.service'),
    ('user.invitation_acceptance', 'users.service'),
    ('user.authentication_activation', 'users.router'),
    ('user.authentication_disable', 'users.router'),
    ('user.authentication_restore', 'users.router'),
    ('user.authentication_reconciliation', 'users.router')
)
AND (
    e.outcome = 'partial'
    OR (e.outcome = 'attempt' AND e.occurred_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')
    OR e.occurred_at > CURRENT_TIMESTAMP + INTERVAL '5 minutes'
)
AND NOT EXISTS (
    SELECT 1 FROM public.security_events AS terminal
    WHERE terminal.operation_id = e.operation_id
      AND terminal.event_type = e.event_type AND terminal.source = e.source
      AND terminal.outcome IN ('success', 'failure', 'denied', 'partial')
      AND (terminal.occurred_at, terminal.id) > (e.occurred_at, e.id)
)
ORDER BY e.occurred_at, e.id
LIMIT 101
""")


class OperationReference(TypedDict):
    event_id: str
    operation_id: str
    event_type: str
    source: str
    reason: str


class OperationalReport(TypedDict):
    status: str
    operations: list[OperationReference]
    truncated: bool
    coverage: str


def inspect_operations(connection: Connection) -> OperationalReport:
    """Use database time and a bounded query within a read-only transaction."""
    connection.execute(text("SET TRANSACTION READ ONLY"))
    connection.execute(text("SET LOCAL statement_timeout = '5s'"))
    rows = connection.execute(ATTENTION_QUERY).mappings().all()
    return {
        "status": "attention" if rows else "ok",
        "operations": [
            {
                "event_id": str(row["id"]),
                "operation_id": str(row["operation_id"]),
                "event_type": str(row["event_type"]),
                "source": str(row["source"]),
                "reason": str(row["reason"]),
            }
            for row in rows[:100]
        ],
        "truncated": len(rows) > 100,
        "coverage": "backend_administrative_events_only",
    }


def main() -> int:
    configure_observability_logging()
    try:
        with get_engine().connect() as connection:
            report = inspect_operations(connection)
    except Exception:
        # This signal deliberately has no dependency on SecurityEvent ingestion.
        log_event("operational_check_failed", level=logging.ERROR, reason_code="check_failed")
        print(json.dumps({"status": "unavailable", "reason": "check_failed"}))
        return 2
    print(json.dumps(report, separators=(",", ":")))
    if report["operations"]:
        log_event(
            "operational_attention", level=logging.WARNING, reason_code="operations_need_review"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
