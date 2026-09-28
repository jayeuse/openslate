"""Read-side projections for record trigger activity."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerEvent,
    RecordTriggerRun,
)
from app.systems.sandbox.record_triggers.schemas import (
    TriggerRunListResponse,
    TriggerRunResponse,
)


def list_recent_runs(db: Session, *, limit: int, offset: int) -> TriggerRunListResponse:
    total = (
        db.scalar(
            select(func.count())
            .select_from(RecordTriggerRun)
            .where(RecordTriggerRun.is_deleted.is_(False))
        )
        or 0
    )
    rows = db.execute(
        select(RecordTriggerRun, RecordTrigger, RecordTriggerEvent)
        .join(
            RecordTrigger,
            RecordTrigger.id == RecordTriggerRun.trigger_id,
        )
        .join(
            RecordTriggerEvent,
            RecordTriggerEvent.id == RecordTriggerRun.event_id,
        )
        .where(RecordTriggerRun.is_deleted.is_(False))
        .order_by(RecordTriggerRun.created_at.desc(), RecordTriggerRun.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    items = [
        TriggerRunResponse(
            id=run.id,
            created_at=run.created_at,
            trigger_id=definition.id,
            trigger_name=definition.name,
            event_kind=event.event_kind,
            state=run.state,
            details=run.details,
            attempts=event.attempt_count,
        )
        for run, definition, event in rows
    ]
    return TriggerRunListResponse(
        items=items,
        limit=limit,
        offset=offset,
        count=len(items),
        total=total,
        has_more=offset + len(items) < total,
    )
