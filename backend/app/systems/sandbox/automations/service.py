"""Read-side projections for published automation activity."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import (
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.automations.schemas import (
    AutomationRunListResponse,
    AutomationRunResponse,
)


def list_recent_runs(db: Session, *, limit: int, offset: int) -> AutomationRunListResponse:
    total = (
        db.scalar(
            select(func.count())
            .select_from(PublishedAutomationRun)
            .where(PublishedAutomationRun.is_deleted.is_(False))
        )
        or 0
    )
    rows = db.execute(
        select(PublishedAutomationRun, PublishedAutomationDefinition, PublishedAutomationEvent)
        .join(
            PublishedAutomationDefinition,
            PublishedAutomationDefinition.id == PublishedAutomationRun.automation_id,
        )
        .join(
            PublishedAutomationEvent,
            PublishedAutomationEvent.id == PublishedAutomationRun.event_id,
        )
        .where(PublishedAutomationRun.is_deleted.is_(False))
        .order_by(PublishedAutomationRun.created_at.desc(), PublishedAutomationRun.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    items = [
        AutomationRunResponse(
            id=run.id,
            created_at=run.created_at,
            automation_id=definition.id,
            automation_name=definition.name,
            event_kind=event.event_kind,
            state=run.state,
            details=run.details,
            attempts=event.attempt_count,
        )
        for run, definition, event in rows
    ]
    return AutomationRunListResponse(
        items=items,
        limit=limit,
        offset=offset,
        count=len(items),
        total=total,
        has_more=offset + len(items) < total,
    )
