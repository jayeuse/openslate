"""The If-Match token a client sends when it saves a record."""

from uuid import UUID

from sqlalchemy.orm import Session

from app.systems.sandbox.records.models import Record


def record_version(db: Session, record_id: UUID) -> str:
    """Return the record's current updated_at, quoted like the frontend's If-Match."""

    record = db.get(Record, record_id, populate_existing=True)
    assert record is not None
    return f'"{record.updated_at.isoformat()}"'
