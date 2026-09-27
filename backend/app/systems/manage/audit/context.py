from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

AUDIT_CONTEXT_KEY = "audit_context"


@dataclass
class AuditContext:
    performed_by: UUID | None = None
    request_id: UUID | None = None
    request_method: str | None = None
    request_path: str | None = None
    actor_label: str | None = None


def get_audit_context(session: Session) -> AuditContext:
    context = session.info.get(AUDIT_CONTEXT_KEY)
    if isinstance(context, AuditContext):
        return context
    context = AuditContext()
    session.info[AUDIT_CONTEXT_KEY] = context
    return context


def set_audit_actor(session: Session, actor: UUID | None) -> None:
    get_audit_context(session).performed_by = actor
