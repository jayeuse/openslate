"""Count committed sends under the caller's organization/author transaction lock."""

from datetime import timedelta
from hashlib import sha256
from math import ceil
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.comms.messages.models import CommsMessage


def admit_message_send(db: Session, org_id: UUID, actor_id: UUID) -> int | None:
    """Hold the author lock until caller commit/rollback; never write admission rows."""
    identity = f"comms-message-send:{org_id}:{actor_id}".encode()
    lock_key = int.from_bytes(sha256(identity).digest()[:8], signed=True)
    db.execute(select(func.pg_advisory_xact_lock(lock_key)))
    timestamp = utc_now()
    count, oldest = db.execute(
        select(func.count(), func.min(CommsMessage.created_at)).where(
            CommsMessage.org_id == org_id,
            CommsMessage.author_id == actor_id,
            CommsMessage.created_at > timestamp - timedelta(seconds=10),
        )
    ).one()
    if count >= 20:
        return max(1, int(ceil((oldest + timedelta(seconds=10) - timestamp).total_seconds())))
    return None
