"""Six durable admissions per actor/organization in a rolling sixty-second window."""

from datetime import datetime, timedelta
from math import ceil
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import Engine, select, text

from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.comms.realtime.models import CommsRealtimeAdmission


def admit(engine: Engine, org_id: UUID, user_id: UUID, now: datetime) -> None:
    """Commit independently before projection work; downstream failure retains the charge."""
    with AuditSession(engine) as db:
        scope_session(db, org_id)
        db.connection().execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"comms:realtime-admission:{org_id}:{user_id}"},
        )
        row = db.scalar(
            select(CommsRealtimeAdmission).where(
                CommsRealtimeAdmission.org_id == org_id,
                CommsRealtimeAdmission.user_id == user_id,
            )
        )
        recent = (
            sorted(value for value in row.issued_at if value > now - timedelta(seconds=60))
            if row
            else []
        )
        if len(recent) == 6:
            retry = max(1, ceil((recent[0] + timedelta(seconds=60) - now).total_seconds()))
            raise HTTPException(
                429,
                "Realtime token rate exceeded",
                headers={
                    "Retry-After": str(retry),
                    "Cache-Control": "no-store",
                },
            )
        if row is None:
            db.add(CommsRealtimeAdmission(org_id=org_id, user_id=user_id, issued_at=[now]))
        else:
            row.issued_at = sorted([*recent, now])
        db.commit()
