"""The one read check that opens a record, shared by the record routes and record history."""

from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.access.policy.checks import module_level
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.sandbox.records.models import Record


def record_access(db: Session, user: User, record_id: UUID) -> tuple[Record, AccessLevel] | None:
    """The record and the caller's level on its module; ``None`` when it is missing or unreadable.

    A record in a module the caller cannot read answers the same as a missing record.
    """

    record = db.get(Record, record_id)
    granted = None if record is None else module_level(db, user, record.module_id)
    if record is None or granted is None:
        return None
    return record, granted
