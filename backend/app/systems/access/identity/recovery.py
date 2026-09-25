"""Recovery-token delivery coordination that preserves anonymous request privacy."""

from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.access.identity.contracts import ActionTokenInvalid
from app.systems.access.identity.delivery import queue_action_delivery
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.identity.service import issue_action_token


def queue_recovery_delivery(db: Session, user_id: UUID) -> bool:
    """Queue a recovery email, treating a locked expiry race as an anonymous no-op."""

    try:
        raw_token = issue_action_token(db, user_id, ActionTokenPurpose.RECOVERY)
    except ActionTokenInvalid:
        return False
    return queue_action_delivery(db, user_id, ActionTokenPurpose.RECOVERY, raw_token)
