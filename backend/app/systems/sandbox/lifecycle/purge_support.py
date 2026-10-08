"""Shared facts for destructive previews; backup history is informational only."""

import hashlib
import json
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.base_model import BaseModel
from app.systems.manage.backups.models import BackupRun
from app.systems.manage.backups.service import installation_id
from app.systems.platform.scheduling.models import ScheduledWork
from app.systems.sandbox.lifecycle.schemas import LifecycleRowState

PURGE_DISABLED_MESSAGE = "Permanent delete is turned off for this installation."


def last_successful_backup_at(db: Session) -> datetime | None:
    """Last historical success for this installation, not a restore guarantee."""
    return db.scalar(
        select(func.max(BackupRun.finished_at)).where(
            BackupRun.installation_id == installation_id(db),
            BackupRun.state == "succeeded",
        )
    )


def purge_row_state(row: BaseModel | ScheduledWork) -> LifecycleRowState:
    """Fingerprint all retained columns without exposing their contents."""
    state = {column.name: getattr(row, column.name) for column in row.__table__.columns}
    fingerprint = hashlib.sha256(
        json.dumps(state, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()
    return LifecycleRowState(
        entity_type=row.__tablename__,
        entity_id=row.id,
        is_deleted=row.is_deleted if isinstance(row, BaseModel) else False,
        deleted_at=row.deleted_at if isinstance(row, BaseModel) else None,
        updated_at=row.updated_at,
        state_fingerprint=fingerprint,
    )
