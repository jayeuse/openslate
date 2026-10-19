"""Pure transaction buffers: no socket, queue wait or pooled connection in commit hooks."""

from contextvars import ContextVar
from typing import Any
from uuid import UUID

from sqlalchemy import event
from sqlalchemy.orm import Session, SessionTransaction

from app.core.database.organization_scope import session_organization
from app.core.database.session import AuditSession
from app.core.observability import log_event
from app.systems.comms.realtime.envelopes import validated_envelope
from app.systems.manage.audit.context import get_audit_context

PENDING = "comms_publish_pending"
COMMITTED = "comms_publish_committed"
SAVEPOINTS = "comms_publish_savepoints"
MAX_BUFFERED_EVENTS = 1024
request_events: ContextVar[list[dict[str, Any]] | None] = ContextVar(
    "comms_publish_request", default=None
)


def stage_comms_event(
    db: Session,
    *,
    org_id: UUID,
    actor_id: UUID,
    envelope: dict[str, Any],
    recipient_id: UUID | None = None,
) -> None:
    if (
        not isinstance(db, AuditSession)
        or session_organization(db) != org_id
        or get_audit_context(db).performed_by != actor_id
    ):
        raise ValueError("Unbound event authority")
    wire = validated_envelope(envelope, org_id=org_id, actor_id=actor_id, recipient_id=recipient_id)
    buffer = db.info.setdefault(PENDING, [])
    if len(buffer) == MAX_BUFFERED_EVENTS:
        log_event(
            "operational_attention", reason_code="comms_publish_buffer_full", upstream="realtime"
        )
        return  # IDs-only invalidations are best effort; never undo an authorized SQL write.
    buffer.append(wire)


def take_committed_events(db: Session) -> list[dict[str, Any]]:
    """For non-request callers: detach immutable-by-convention values before closing the session."""
    return list(db.info.pop(COMMITTED, []))


@event.listens_for(AuditSession, "after_transaction_create")
def remember_savepoint(db: AuditSession, transaction: SessionTransaction) -> None:
    if transaction.nested:
        db.info.setdefault(SAVEPOINTS, {})[transaction] = list(db.info.get(PENDING, []))


@event.listens_for(AuditSession, "after_rollback")
def discard_rolled_back(db: AuditSession) -> None:
    if db.in_nested_transaction():
        previous = db.info.get(SAVEPOINTS, {}).pop(db.get_nested_transaction(), [])
        db.info[PENDING] = previous
    else:
        db.info.pop(PENDING, None)
        db.info.pop(SAVEPOINTS, None)


@event.listens_for(AuditSession, "after_commit")
def detach_committed(db: AuditSession) -> None:
    if db.in_nested_transaction():
        return
    events = db.info.pop(PENDING, [])
    db.info.pop(SAVEPOINTS, None)
    destination = request_events.get()
    if destination is None:
        destination = db.info.setdefault(COMMITTED, [])
    room = MAX_BUFFERED_EVENTS - len(destination)
    destination.extend(events[:room])
    if len(events) > room:
        log_event(
            "operational_attention", reason_code="comms_publish_buffer_full", upstream="realtime"
        )


@event.listens_for(AuditSession, "after_transaction_end")
def end_transaction(db: AuditSession, transaction: SessionTransaction) -> None:
    db.info.get(SAVEPOINTS, {}).pop(transaction, None)
    if transaction.parent is None:
        db.info.pop(PENDING, None)
        db.info.pop(SAVEPOINTS, None)
