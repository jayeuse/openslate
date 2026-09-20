"""Compatibility import for local Identity's durable SMTP outbox."""

from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.platform.notifications.outbox import queue_action_delivery as _queue


def queue_action_delivery(
    db: Session, user_id: UUID, purpose: ActionTokenPurpose, raw_token: str
) -> bool:
    """Queue a protected action-token delivery within the caller transaction."""

    return _queue(db, user_id, purpose, raw_token)
